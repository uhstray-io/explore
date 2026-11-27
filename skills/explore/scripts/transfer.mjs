import { snapshotOf } from './versions.mjs';

// Export and import a complete map (I2). An export is the saved map without claim data. Importing is
// Store.importMap, which never overwrites anything already here.
export const maxImportIdeas = 5000;

export async function exportMap(store, mapId) {
  return { format: 'explore-map', version: 1, exportedAt: new Date().toISOString(), map: snapshotOf(await store.get(mapId)) };
}

// The map inside an export, or a bare map.json. `fail(message)` must throw.
export function unwrapExport(data, fail) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('This file is not an Explore map.');
  if (data.format === 'explore-map') {
    if (data.version !== 1) fail('This export was made by a newer version of Explore. Update Explore to import it.');
    return { map: data.map, exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null };
  }
  if (data.schemaVersion === undefined) fail('This file is not an Explore map.');
  return { map: data, exportedAt: null };
}

export const mapSummary = map => ({ title: map.title, revision: map.revision, updatedAt: map.updatedAt, ideas: map.nodes.length });
