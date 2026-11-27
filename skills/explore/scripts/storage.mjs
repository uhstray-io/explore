import { lstat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { removable } from './versions.mjs';
import { mapFolderPattern } from './map-validation.mjs';
import { keepChoices } from '../assets/storage-dialog.js';

// Storage overview and history cleanup (J5). The inventory only reads, without parsing any map. Cleanup removes
// only history versions a preview listed, under the shared rule in versions.mjs (never named or imported versions,
// the newest ones, or any Undo needs), each rechecked under the map's lock. Maps, generated Markdown and everything
// in .explore/ are never touched, and links are never followed.
class StorageProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new StorageProblem(message, status); };
const previewMs = 15 * 60 * 1000;

// File lengths from lstat, not disk allocation. A link is reported and never followed; an unreadable entry is
// unknown (null), never zero.
async function entry(file) {
  try { const info = await lstat(file); return info.isSymbolicLink() ? { linked: true, bytes: null, folder: false } : { bytes: info.isFile() ? info.size : 0, folder: info.isDirectory() }; }
  catch (error) { return error.code === 'ENOENT' ? { bytes: 0, missing: true } : { bytes: null }; }
}
async function folderBytes(dir) {
  const self = await entry(dir);
  if (self.linked || self.missing || !self.folder) return { bytes: self.linked ? null : 0, linked: self.linked ? 1 : 0 };
  let names; try { names = await readdir(dir); } catch { return { bytes: null, linked: 0 }; }
  let bytes = 0, linked = 0;
  for (const name of names) { const item = await entry(path.join(dir, name)); if (item.linked) linked++; else if (item.bytes === null) bytes = null; else if (bytes !== null) bytes += item.bytes; }
  return { bytes, linked };
}
const add = (...values) => values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0);

export function createStorage(store, { runtime = null, now = Date.now } = {}) {
  const previews = new Map();
  // Map folders by name only: reading a map could adopt an outside change and record a version.
  const mapIds = async () => (await readdir(store.directory, { withFileTypes: true }).catch(() => [])).filter(item => item.isDirectory() && mapFolderPattern.test(item.name)).map(item => item.name);
  return {
    async inventory() {
      const maps = [];
      for (const id of await mapIds()) {
        const dir = path.dirname(store.file(id));
        const [mapFile, readme, nodes, versionsFolder] = await Promise.all([entry(store.file(id)), entry(path.join(dir, 'README.md')), folderBytes(path.join(dir, 'nodes')), entry(path.join(dir, 'versions'))]);
        // History counts what Explore lists as versions, so it matches the history panel.
        const versions = versionsFolder.linked ? null : await store.versions.scan(id).catch(() => null);
        maps.push({ id, mapBytes: mapFile.bytes, markdownBytes: add(readme.bytes, nodes.bytes),
          versions: versions ? { count: versions.length, bytes: versions.reduce((sum, version) => sum + version.bytes, 0), named: versions.filter(version => version.name).length, oldest: versions.at(-1)?.at ?? null, newest: versions[0]?.at ?? null }
            : { count: null, bytes: null, named: null, oldest: null, newest: null },
          linked: (mapFile.linked ? 1 : 0) + (readme.linked ? 1 : 0) + nodes.linked + (versionsFolder.linked ? 1 : (await folderBytes(path.join(dir, 'versions'))).linked) });
      }
      const total = map => add(map.mapBytes, map.markdownBytes, map.versions.bytes);
      maps.sort((a, b) => (total(b) ?? 0) - (total(a) ?? 0));
      const claims = runtime ? await folderBytes(path.join(runtime, 'claims')) : { bytes: 0 };
      const claimCount = runtime ? (await readdir(path.join(runtime, 'claims')).catch(() => [])).filter(name => name.endsWith('.json')).length : 0;
      const usage = runtime ? await entry(path.join(runtime, 'context-usage.jsonl')) : { bytes: 0 };
      return { maps, totals: { bytes: add(...maps.map(total)) }, runtime: { claims: { count: claimCount, bytes: claims.bytes }, usageLogBytes: usage.bytes },
        linked: maps.reduce((sum, map) => sum + map.linked, 0), note: 'Sizes are file lengths, not space used on disk. Links are counted, never followed.' };
    },
    // Lists exactly what a cleanup would remove. It changes nothing; its ID works once, within 15 minutes.
    async preview({ mapIds: chosen, keepNewest } = {}) {
      need(keepChoices.includes(keepNewest), 'Keep the newest 5, 10 or 25 versions.');
      for (const [id, old] of previews) if (now() - old.createdAt >= previewMs) previews.delete(id);
      const all = await mapIds(), ids = chosen === undefined ? all : chosen;
      need(Array.isArray(ids) && ids.every(id => all.includes(id)), 'Choose maps in this workspace.');
      const byMap = new Map();
      for (const mapId of ids) {
        const candidates = removable(await store.versions.scan(mapId), { keepNewest }).map(version => ({ mapId, versionId: version.id, revision: version.revision, at: version.at, bytes: version.bytes, contentHash: version.contentHash }));
        if (candidates.length) byMap.set(mapId, candidates);
      }
      const id = randomUUID(), candidates = [...byMap.values()].flat();
      previews.set(id, { createdAt: now(), keepNewest, byMap });
      return { id, keepNewest, candidates: candidates.map(({ contentHash, ...candidate }) => candidate), bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) };
    },
    // Removes only the previewed versions. Each map is rechecked under its lock, so a version named, changed or
    // needed by Undo since the preview is kept and reported.
    async clean({ previewId } = {}) {
      const preview = previews.get(previewId);
      need(preview, 'This preview is unknown. Preview the cleanup again.', 404);
      previews.delete(previewId);
      need(now() - preview.createdAt < previewMs, 'This preview expired. Preview the cleanup again.', 404);
      const outcomes = [];
      for (const [mapId, candidates] of preview.byMap) await store.withMapLock(mapId, async () => {
        const versions = await store.versions.scan(mapId), allowed = new Set(removable(versions, { keepNewest: preview.keepNewest }).map(version => version.id));
        for (const candidate of candidates) {
          const current = versions.find(version => version.id === candidate.versionId), result = { mapId, versionId: candidate.versionId };
          const reason = !current ? 'It is no longer there, or it is a link.' : current.name ? 'It was named after the preview.' : current.contentHash !== candidate.contentHash || current.bytes !== candidate.bytes ? 'It changed after the preview.'
            : !allowed.has(current.id) ? 'Undo or the newest versions need it now.' : null;
          if (reason) { outcomes.push({ ...result, outcome: 'skipped', reason }); continue; }
          try { await store.versions.remove(mapId, candidate.versionId, { keepNewest: preview.keepNewest }); outcomes.push({ ...result, outcome: 'removed' }); }
          catch (error) { outcomes.push({ ...result, outcome: 'failed', reason: error.message }); }
        }
      });
      return { outcomes, note: 'Removed versions leave this folder and Explore stops listing them; copies already committed stay in Git history.' };
    },
  };
}
