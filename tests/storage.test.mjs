import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { createStorage } from '../skills/explore/scripts/storage.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';

// Storage overview and history cleanup (J5, #47). Illustrative fixtures under .test-output, never ideas/.
async function fixture(saves = 12) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'storage-'));
  const store = new Store(path.join(workspace, 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  for (let i = 0; i < saves; i++) await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, type: 'suggest', title: `Direction ${i}`, body: 'A direction.' });
  const runtime = path.join(workspace, '.explore'); await mkdir(path.join(runtime, 'claims'), { recursive: true });
  await writeFile(path.join(runtime, 'claims', 'job-00000001.json'), '{"x":1}'); await writeFile(path.join(runtime, 'context-usage.jsonl'), 'line\n');
  return { workspace, store, map, runtime, storage: createStorage(store, { runtime }) };
}
const folderBytes = async dir => { let total = 0; for (const name of await readdir(dir)) total += (await stat(path.join(dir, name))).size; return total; };

test('the inventory reports file sizes per map and in total, and changes nothing', async () => {
  const { store, map, runtime, storage } = await fixture(3);
  const folder = path.dirname(store.file(map.id));
  const before = JSON.stringify(await readdir(folder, { recursive: true }));
  const report = await storage.inventory();
  const entry = report.maps.find(m => m.id === map.id);
  assert.equal(entry.mapBytes, (await stat(store.file(map.id))).size);
  assert.equal(entry.markdownBytes, (await stat(path.join(folder, 'README.md'))).size + await folderBytes(path.join(folder, 'nodes')));
  assert.equal(entry.versions.bytes, await folderBytes(path.join(folder, 'versions')));
  assert.equal(entry.versions.count, (await readdir(path.join(folder, 'versions'))).length);
  assert.equal(report.runtime.claims.count, 1); assert.equal(report.runtime.claims.bytes, 7); assert.equal(report.runtime.usageLogBytes, 5);
  assert.equal(report.totals.bytes, entry.mapBytes + entry.markdownBytes + entry.versions.bytes);
  assert.equal(JSON.stringify(await readdir(folder, { recursive: true })), before);
  assert.ok((await readdir(runtime)).includes('context-usage.jsonl'));
});

test('a preview lists only unnamed versions beyond the newest kept, never named, imported, newest or Undo versions', async () => {
  const { store, map, storage } = await fixture(12);
  const listed = (await store.versions.list(map.id)).versions;
  const oldest = listed.at(-1);
  await store.versions.name(map.id, oldest.id, 'Before the radio idea');
  const preview = await storage.preview({ keepNewest: 5 });
  const ids = preview.candidates.map(c => c.versionId);
  assert.ok(ids.length > 0);
  assert.ok(!ids.includes(oldest.id), 'named versions are kept');
  assert.ok(!ids.includes(listed[0].id), 'the newest version is kept');
  assert.ok(!ids.includes(listed[1].id), 'the version Undo restores is kept');
  assert.ok(listed.slice(0, 5).every(v => !ids.includes(v.id)), 'the newest five are kept');
  assert.equal(preview.bytes, preview.candidates.reduce((sum, c) => sum + c.bytes, 0));
  await assert.rejects(storage.preview({ keepNewest: 7 }), error => error.status === 400);
  assert.equal((await store.versions.list(map.id)).versions.length, listed.length, 'a preview changes nothing');
});

test('confirming removes exactly the previewed versions, skips one named since, and history still works', async () => {
  const { store, map, storage } = await fixture(12);
  const folder = path.dirname(store.file(map.id)), mapBytes = await readFile(store.file(map.id), 'utf8');
  const preview = await storage.preview({ keepNewest: 5 });
  const renamed = preview.candidates[0];
  await store.versions.name(map.id, renamed.versionId, 'Keep this one');
  const result = await storage.clean({ previewId: preview.id });
  assert.deepEqual(result.outcomes.find(o => o.versionId === renamed.versionId), { mapId: map.id, versionId: renamed.versionId, outcome: 'skipped', reason: 'It was named after the preview.' });
  const removed = result.outcomes.filter(o => o.outcome === 'removed').map(o => o.versionId);
  assert.equal(removed.length, preview.candidates.length - 1);
  const remaining = (await store.versions.list(map.id)).versions.map(v => v.id);
  assert.ok(removed.every(id => !remaining.includes(id))); assert.ok(remaining.includes(renamed.versionId));
  assert.equal(await readFile(store.file(map.id), 'utf8'), mapBytes, 'the map is unchanged');
  assert.ok((await readdir(path.join(folder, 'nodes'))).length > 0);
  const target = remaining.at(-1);
  await store.versions.preview(map.id, target);
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, type: 'restore-version', version: target });
  await assert.rejects(storage.clean({ previewId: preview.id }), error => error.status === 404, 'a preview is used once');
  await assert.rejects(storage.clean({ previewId: 'nope' }), error => error.status === 404);
});

test('an expired preview removes nothing', async () => {
  const { store, map } = await fixture(12);
  let clock = 0;
  const storage = createStorage(store, { runtime: null, now: () => clock });
  const preview = await storage.preview({ keepNewest: 5 });
  clock = 16 * 60 * 1000;
  const count = (await store.versions.list(map.id)).versions.length;
  await assert.rejects(storage.clean({ previewId: preview.id }), error => error.status === 404 && /expired/.test(error.message));
  assert.equal((await store.versions.list(map.id)).versions.length, count);
});

test('the storage routes need the session token', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const app = await startServer({ workspace: await mkdtemp(path.join(root, 'storage-http-')), port: 0 });
  try {
    assert.equal((await fetch(`${app.address}/api/storage`)).status, 401);
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const report = await (await fetch(`${app.address}/api/storage`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.ok(Array.isArray(report.maps)); assert.equal(typeof report.totals.bytes, 'number');
    const preview = await fetch(`${app.address}/api/storage/preview`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ keepNewest: 10 }) });
    assert.equal(preview.status, 200); assert.deepEqual((await preview.json()).candidates, []);
  } finally { await app.close(); }
});
