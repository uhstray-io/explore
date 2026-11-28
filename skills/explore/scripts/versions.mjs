import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { atomicJson } from './files.mjs';
import { undoDependencies } from '../assets/workspace-view.js';

// Version history (E1). Each saved change to a map is one standalone file in the map's folder,
// ideas/<map-id>/versions/<time>-<random>.json, committed with the map so anyone who pulls can
// preview, undo and restore. There is no index file: the list is derived by scanning, so two
// people's histories merge in Git as separate new files without conflicts.
export const versionLimits = { count: 50, bytes: 16 * 1024 * 1024, names: 10 };
const idPattern = /^\d{8}T\d{9}Z-[a-f0-9]{6}$/;
// Saves that only move ideas or keep the queue's own books are not versions of the content.
const bookkeeping = new Set(['started', 'interrupted']);

class VersionProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new VersionProblem(message, status); };

// Fields that change without changing a map's content: the counters every save changes, and pin and archive
// state (I1). Two saved forms that differ only in these are the same map to everyone reading it.
export function presentationOnly(before, after) {
  try {
    const strip = bytes => { const { library, revision, updatedAt, ...rest } = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); return JSON.stringify(rest); };
    return strip(before) === strip(after);
  } catch { return false; }
}
// The map as saved, minus claim data that only works with one machine's running server.
export function snapshotOf(map) {
  const copy = structuredClone(map);
  // A transient job's texts (a draft being tidied) stay in map.json only: never in versions or exports.
  for (const job of copy.jobs || []) { delete job.claimKey; delete job.claimHash; delete job.inputSignature; if (job.transient) { delete job.input; delete job.result; } }
  return copy;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Identity of a version's content: everything except the counters every save changes.
export function contentHash(map) { const { revision, updatedAt, ...content } = snapshotOf(map); return hash(content); }
// What a restore replaces. The event log and growth history only grow, and today's layout is kept.
export function restorableHash(map) {
  const { title, originalIdea, rootId, nodes, edges, jobs } = snapshotOf(map);
  return hash({ title, originalIdea, rootId, nodes, edges, jobs });
}
export function shouldRecord(labels) { return labels.some(label => !bookkeeping.has(label)); }
const describe = (id, record, bytes) => ({ id, mapId: record.mapId, revision: record.revision, at: record.at, labels: record.labels,
  ...(record.author ? { author: record.author } : {}), ...(record.name ? { name: record.name } : {}), ...(record.checkpoint ? { checkpoint: true } : {}), ...(record.kept ? { kept: true } : {}), contentHash: record.contentHash, bytes });

// The versions history may let go of, newest first: unnamed, unimported, beyond the newest `keepNewest` such
// versions, and not one that anyone's Undo depends on (what it walks and what it restores), so letting go of
// them never changes what Undo does. Old contributors keep only their own few versions, not the whole history.
export function removable(versions, { keepNewest }) {
  const kept = new Set();
  for (const author of new Set([null, ...versions.map(version => version.author).filter(Boolean)]))
    for (const version of undoDependencies(versions, author)) kept.add(version.id);
  return versions.filter(version => !version.name && !version.kept).slice(keepNewest).filter(version => !kept.has(version.id));
}

export class Versions {
  constructor(directory, limits = {}) { this.directory = directory; this.limits = { ...versionLimits, ...limits }; this.headers = new Map(); }
  folder(mapId) { return path.join(this.directory, mapId, 'versions'); }
  file(mapId, id) { need(typeof id === 'string' && idPattern.test(id), 'Version not found.', 404); return path.join(this.folder(mapId), `${id}.json`); }
  // Newest first. Files are immutable except for their name, so headers are cached by size and time.
  async scan(mapId) {
    let names = [];
    // A history folder that is a link is never read, so nothing behind it is listed or removed.
    const folder = await lstat(this.folder(mapId)).catch(() => null);
    if (folder && !folder.isDirectory()) return [];
    try { names = (await readdir(this.folder(mapId))).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const versions = [];
    for (const name of names) {
      const file = path.join(this.folder(mapId), name), id = name.slice(0, -5);
      let info;
      try { info = await lstat(file); } catch { continue; }
      if (!info.isFile()) continue; // A link or folder is never a version.
      const key = file;
      let cached = this.headers.get(key);
      if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
        let header = null;
        try {
          const record = JSON.parse(await readFile(file, 'utf8'));
          if (record?.format === 'explore-version' && record.version === 1 && record.mapId === mapId && typeof record.at === 'string' && Array.isArray(record.labels) && record.map) header = describe(id, record, info.size);
        } catch {} // A damaged version file is left alone and not offered.
        cached = { mtimeMs: info.mtimeMs, size: info.size, header };
        this.headers.set(key, cached);
      }
      if (cached.header) versions.push(cached.header);
    }
    return versions.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }
  async list(mapId) {
    const versions = await this.scan(mapId);
    // Versions older than the feature, or tidied away, are not listed; committed ones remain in Git history.
    return { versions: versions.map(({ contentHash, mapId: _, ...version }) => version), earlierMissing: !versions.length || versions.at(-1).revision > 1, limits: this.limits };
  }
  async get(mapId, id) {
    let record;
    try { record = JSON.parse(await readFile(this.file(mapId, id), 'utf8')); }
    catch (error) { if (error instanceof VersionProblem) throw error; throw new VersionProblem('Version not found.', 404); }
    need(record?.format === 'explore-version' && record.mapId === mapId && record.map, 'Version not found.', 404);
    need(record.version === 1, 'This version was saved by a newer version of Explore. Update Explore to use it.', 409);
    return { version: describe(id, record, 0), map: record.map };
  }
  async findContent(mapId, map) { const target = contentHash(map); return (await this.scan(mapId)).find(version => version.contentHash === target) || null; }
  // Records the map as it is about to be saved. A snapshot identical to the newest version is not written again.
  // A checkpoint (`name` with `checkpoint: true`) is a version Explore names itself before a branch restart:
  // kept like every named version, and not counted among the names people choose. When the newest
  // version already holds this content and has no name, that version is named instead of copied.
  async record(map, { labels, author, at = new Date().toISOString(), kept = false, name, checkpoint = false } = {}) {
    const content = contentHash(map), versions = await this.scan(map.id), newest = versions[0];
    if (newest?.contentHash === content && !(name && newest.name)) {
      if (name) { const file = this.file(map.id, newest.id); await atomicJson(file, { ...JSON.parse(await readFile(file, 'utf8')), name, ...(checkpoint ? { checkpoint: true } : {}) }); }
      return newest.id;
    }
    const id = `${at.replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`;
    await atomicJson(this.file(map.id, id), { format: 'explore-version', version: 1, mapId: map.id, revision: map.revision, at,
      ...(author ? { author } : {}), ...(kept ? { kept: true } : {}), ...(name ? { name } : {}), ...(checkpoint ? { checkpoint: true } : {}), labels, contentHash: content, map: snapshotOf(map) });
    await this.prune(map.id);
    return id;
  }
  // Keeps every named or imported version, the versions Undo needs, and the newest others within the count and
  // byte limits.
  async prune(mapId) {
    const versions = await this.scan(mapId), allowed = new Set(removable(versions, { keepNewest: 1 }).map(version => version.id));
    let kept = 0, bytes = 0;
    for (const version of versions.filter(version => !version.name && !version.kept)) {
      kept += 1; bytes += version.bytes;
      if ((kept > this.limits.count || bytes > this.limits.bytes) && allowed.has(version.id)) await this.unlinkVersion(mapId, version.id).catch(() => {});
    }
  }
  async unlinkVersion(mapId, id) { const file = this.file(mapId, id); await unlink(file); this.headers.delete(file); }
  // Removes one version the shared rule allows: the storage cleanup's only way to delete history (J5).
  async remove(mapId, id, { keepNewest }) {
    need(removable(await this.scan(mapId), { keepNewest }).some(version => version.id === id), 'This version is kept: it is named, imported, among the newest, or needed by Undo.', 409);
    await this.unlinkVersion(mapId, id);
  }
  async name(mapId, id, name) {
    const file = this.file(mapId, id), versions = await this.scan(mapId);
    need(versions.some(version => version.id === id), 'Version not found.', 404);
    const record = JSON.parse(await readFile(file, 'utf8'));
    if (name === null) delete record.name;
    else {
      need(typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 120, 'A version name must be 1–120 characters.');
      name = name.trim();
      need(!versions.some(version => version.id !== id && version.name === name), 'That name is already used for another version.', 409);
      need((record.name && !record.checkpoint) || versions.filter(version => version.name && !version.checkpoint).length < this.limits.names, `A map can have at most ${this.limits.names} named versions. Remove a name first.`, 409);
      record.name = name;
    }
    delete record.checkpoint; // Once the user names or unnames it, it is theirs.
    await atomicJson(file, record);
  }
}

// What restoring `snapshot` would change in `current`, and which finished branches it would reopen.
export function compareVersion(current, snapshot, isCompleted) {
  const index = nodes => new Map(nodes.map(node => [node.id, node]));
  const now = index(current.nodes), then = index(snapshot.nodes);
  const edgeKey = edge => JSON.stringify([edge.from, edge.to, edge.type]);
  const nowEdges = new Set(current.edges.map(edgeKey)), thenEdges = new Set(snapshot.edges.map(edgeKey));
  return {
    counts: {
      nodesAdded: [...then.keys()].filter(id => !now.has(id)).length,
      nodesRemoved: [...now.keys()].filter(id => !then.has(id)).length,
      nodesChanged: [...then.keys()].filter(id => now.has(id) && JSON.stringify(now.get(id)) !== JSON.stringify(then.get(id))).length,
      linksAdded: [...thenEdges].filter(key => !nowEdges.has(key)).length,
      linksRemoved: [...nowEdges].filter(key => !thenEdges.has(key)).length,
    },
    reopened: [...then.keys()].filter(id => now.has(id) && isCompleted(current, now.get(id)) && !isCompleted(snapshot, then.get(id))),
  };
}
