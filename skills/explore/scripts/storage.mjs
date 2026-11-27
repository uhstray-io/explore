import { lstat, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { undoTarget } from '../assets/workspace-view.js';

// Storage overview and history cleanup (J5). The inventory only reads. Cleanup removes unnamed history versions,
// and only ones a preview listed: named and imported versions, the newest version and the versions Undo needs are
// never candidates. Maps, generated Markdown and everything in .explore/ are never touched.
class StorageProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new StorageProblem(message, status); };
export const keepChoices = [5, 10, 25];
const previewMs = 15 * 60 * 1000;

// File lengths from lstat, not disk allocation. Links are reported and never followed; unreadable entries are
// unknown (null), never zero.
async function size(file) {
  try { const info = await lstat(file); return info.isSymbolicLink() ? { linked: true, bytes: null } : { bytes: info.isFile() ? info.size : 0 }; }
  catch (error) { return error.code === 'ENOENT' ? { bytes: 0 } : { bytes: null }; }
}
async function folder(dir, filter = () => true) {
  let names;
  try { names = (await readdir(dir)).filter(filter); } catch (error) { return error.code === 'ENOENT' ? { count: 0, bytes: 0, linked: 0 } : { count: null, bytes: null, linked: 0 }; }
  let bytes = 0, linked = 0, unknown = false;
  for (const name of names) { const entry = await size(path.join(dir, name)); if (entry.linked) linked++; else if (entry.bytes === null) unknown = true; else bytes += entry.bytes; }
  return { count: names.length, bytes: unknown ? null : bytes, linked };
}
const add = (...values) => values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0);

// Unnamed, unimported versions beyond the newest `keepNewest`, less those Undo needs for anyone who saved one.
function candidatesOf(versions, keepNewest) {
  const protectedIds = new Set(versions.length ? [versions[0].id] : []);
  for (const author of new Set([null, ...versions.map(version => version.author).filter(Boolean)])) {
    const undo = undoTarget(versions, author);
    if (undo) { protectedIds.add(undo.target.id); protectedIds.add(undo.undoing.id); }
  }
  return versions.filter(version => !version.name && !version.kept).slice(keepNewest).filter(version => !protectedIds.has(version.id));
}

export function createStorage(store, { runtime = null, now = Date.now } = {}) {
  const previews = new Map();
  const mapIds = async () => (await store.list()).map(item => item.id);
  return {
    async inventory() {
      const maps = [];
      for (const id of await mapIds()) {
        const dir = path.dirname(store.file(id)), versions = await store.versions.scan(id).catch(() => []);
        const [mapFile, readme, nodes, versionFiles] = await Promise.all([size(store.file(id)), size(path.join(dir, 'README.md')), folder(path.join(dir, 'nodes')), folder(path.join(dir, 'versions'))]);
        maps.push({ id, mapBytes: mapFile.bytes, markdownBytes: add(readme.bytes, nodes.bytes),
          versions: { count: versionFiles.count, bytes: versionFiles.bytes, named: versions.filter(version => version.name).length, oldest: versions.at(-1)?.at ?? null, newest: versions[0]?.at ?? null },
          linked: (mapFile.linked ? 1 : 0) + (readme.linked ? 1 : 0) + nodes.linked + versionFiles.linked });
      }
      maps.sort((a, b) => (add(b.mapBytes, b.markdownBytes, b.versions.bytes) ?? 0) - (add(a.mapBytes, a.markdownBytes, a.versions.bytes) ?? 0));
      const claims = runtime ? await folder(path.join(runtime, 'claims'), name => name.endsWith('.json')) : { count: 0, bytes: 0 };
      const usage = runtime ? await size(path.join(runtime, 'context-usage.jsonl')) : { bytes: 0 };
      return { maps, totals: { bytes: add(...maps.map(map => add(map.mapBytes, map.markdownBytes, map.versions.bytes))) ?? null },
        runtime: { claims: { count: claims.count, bytes: claims.bytes }, usageLogBytes: usage.bytes }, note: 'Sizes are file lengths, not space used on disk.' };
    },
    // Lists exactly what a cleanup would remove. It changes nothing; its ID expires after 15 minutes.
    async preview({ mapIds: chosen, keepNewest } = {}) {
      need(keepChoices.includes(keepNewest), `Keep the newest ${keepChoices.join(', ').replace(/, (\d+)$/, ' or $1')} versions.`);
      const all = await mapIds(), ids = chosen === undefined ? all : chosen;
      need(Array.isArray(ids) && ids.every(id => all.includes(id)), 'Choose maps in this workspace.');
      const candidates = [];
      for (const mapId of ids) for (const version of candidatesOf(await store.versions.scan(mapId), keepNewest))
        candidates.push({ mapId, versionId: version.id, revision: version.revision, at: version.at, bytes: version.bytes, contentHash: version.contentHash });
      const id = randomUUID();
      previews.set(id, { createdAt: now(), keepNewest, candidates });
      return { id, keepNewest, candidates: candidates.map(({ contentHash, ...candidate }) => candidate), bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) };
    },
    // Removes only the previewed versions, each rechecked first: still there, unchanged, unnamed and unprotected.
    async clean({ previewId } = {}) {
      const preview = previews.get(previewId);
      need(preview, 'This preview is unknown. Preview the cleanup again.', 404);
      previews.delete(previewId); // A preview is used once.
      need(now() - preview.createdAt < previewMs, 'This preview expired. Preview the cleanup again.', 404);
      const outcomes = [], byMap = new Map(); // Not Map.groupBy: the skill runs on Node 20.
      for (const candidate of preview.candidates) byMap.set(candidate.mapId, [...(byMap.get(candidate.mapId) || []), candidate]);
      for (const [mapId, candidates] of byMap) {
        const versions = await store.versions.scan(mapId), stillCandidates = new Set(candidatesOf(versions, preview.keepNewest).map(version => version.id));
        for (const candidate of candidates) {
          const current = versions.find(version => version.id === candidate.versionId), result = { mapId, versionId: candidate.versionId };
          const reason = !current ? 'It is no longer there.' : current.name ? 'It was named after the preview.' : current.contentHash !== candidate.contentHash || current.bytes !== candidate.bytes ? 'It changed after the preview.'
            : !stillCandidates.has(current.id) ? 'Undo or the newest versions need it now.' : null;
          if (reason) { outcomes.push({ ...result, outcome: 'skipped', reason }); continue; }
          try { await store.versions.remove(mapId, candidate.versionId); outcomes.push({ ...result, outcome: 'removed' }); }
          catch (error) { outcomes.push({ ...result, outcome: 'failed', reason: error.message }); }
        }
      }
      return { outcomes, note: 'Removed versions leave this folder and Explore stops listing them; copies already committed stay in Git history.' };
    },
  };
}
