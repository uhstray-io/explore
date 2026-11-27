import { randomUUID } from 'node:crypto';
import { snapshotOf, contentHash } from './versions.mjs';
import { validateMap, mapFolderPattern, isOpenJob } from './map-validation.mjs';

// Export and import a complete map (I2). An export is the saved map without claim data; an import is
// untrusted data that never overwrites an existing map: an identical one opens it, a changed one is a
// conflict the user settles by importing a copy.

class TransferProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new TransferProblem(message, status); };
const summary = map => ({ title: map.title, revision: map.revision, updatedAt: map.updatedAt, ideas: map.nodes.length });

export async function exportMap(store, mapId) {
  return { format: 'explore-map', version: 1, exportedAt: new Date().toISOString(), map: snapshotOf(await store.get(mapId)) };
}

// The map inside an export, or a bare map.json.
function unwrap(data) {
  need(data && typeof data === 'object' && !Array.isArray(data), 'This file is not an Explore map.');
  if (data.format === 'explore-map') {
    need(data.version === 1, 'This export was made by a newer version of Explore. Update Explore to import it.');
    return { map: data.map, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null };
  }
  need(data.schemaVersion !== undefined, 'This file is not an Explore map.');
  return { map: data, exportedAt: null };
}

export function importMap(store, data, { asCopy = false } = {}) {
  return store.serial(async () => {
    const { map: incoming, exportedAt } = unwrap(data);
    const problems = validateMap(incoming).errors;
    need(!problems.length, `This map cannot be imported: ${problems.slice(0, 5).map(problem => `${problem.message.replace(/\.$/, '')} (${problem.code} at ${problem.at})`).join('; ')}${problems.length > 5 ? '; and more' : ''}.`);
    const map = snapshotOf(incoming);
    const existing = (await store.list()).find(item => item.id === map.id);
    if (existing && !asCopy) {
      const current = await store.get(map.id);
      return contentHash(current) === contentHash(map) ? { existing: map.id } : { conflict: { mapId: map.id, existing: summary(current), incoming: summary(map) } };
    }
    const at = new Date().toISOString(), copy = asCopy || !mapFolderPattern.test(map.id);
    if (copy) Object.assign(map, { id: `map-${randomUUID().slice(0, 8)}`, title: `${map.title.slice(0, 93)} (copy)`, createdAt: at, importedFrom: { mapId: incoming.id, revision: incoming.revision, exportedAt } });
    // Imported work stays inactive until the user acts, as after a restart.
    for (const job of map.jobs.filter(isOpenJob)) Object.assign(job, { status: 'interrupted', finishedAt: at, error: 'Imported while queued or running. Retry to continue.' });
    for (const node of map.nodes.filter(node => ['queued', 'running'].includes(node.status))) node.status = 'interrupted';
    store.adoptNew(map);
    store.event(map, 'map-imported', null, copy ? `Copy of ${incoming.id}` : 'Imported');
    await store.save(map);
    return { imported: map.id };
  });
}
