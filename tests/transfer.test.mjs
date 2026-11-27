import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { exportMap, importMap } from '../skills/explore/scripts/transfer.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';

// Export and import a complete map (I2, #40). Fixtures under .test-output, never ideas/.
const exec = promisify(execFile);
async function workspace(prefix = 'transfer-') {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, prefix));
  return { dir, store: new Store(path.join(dir, 'ideas')) };
}
// A worked map with an answer, a source, a suggestion, a position and a job still running.
async function workedMap(store) {
  let map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  let job = await store.claim('agent', map.id);
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends.', body: 'Fixture.', questions: ['Offline for days?'], suggestions: [{ title: 'Sync', body: 'Later.' }] });
  map = await store.action(map.id, { type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Yes.', expectedRevision: map.revision });
  map = await store.action(map.id, { type: 'position', nodeId: map.rootId, x: 40, y: 80, expectedRevision: map.revision });
  job = await store.claim('agent', map.id); // Left running on purpose.
  map = await store.get(map.id);
  return { map, job };
}
const sorted = list => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('an export holds the whole map and nothing machine-local', async () => {
  const { store } = await workspace();
  const { map, job } = await workedMap(store);
  const exported = await exportMap(store, map.id);
  assert.equal(exported.format, 'explore-map'); assert.equal(exported.version, 1); assert.match(exported.exportedAt, /^\d{4}-/);
  assert.equal(exported.map.nodes.length, map.nodes.length); assert.deepEqual(exported.map.view.positions, map.view.positions);
  assert.doesNotMatch(JSON.stringify(exported), new RegExp(`claimKey|claimHash|inputSignature|${job.claimKey}`));
});

test('importing into an empty workspace gives the same map, with running work interrupted and views generated', async () => {
  const from = await workspace(), to = await workspace();
  const { map } = await workedMap(from.store);
  const result = await importMap(to.store, await exportMap(from.store, map.id));
  assert.equal(result.imported, map.id);
  const copy = await to.store.get(map.id);
  assert.deepEqual(copy.history.slice(0, -1), map.history); assert.equal(copy.history.at(-1).type, 'map-imported');
  for (const field of ['nodes', 'edges']) assert.deepEqual(sorted(copy[field].map(item => ({ ...item, status: undefined }))), sorted(map[field].map(item => ({ ...item, status: undefined }))), field);
  assert.equal(copy.nodes[0].questions[0].answer, 'Yes.');
  assert.ok(copy.jobs.every(j => !['queued', 'running'].includes(j.status)), 'no active work arrives');
  assert.match(copy.jobs.at(-1).error, /Retry to continue/);
  assert.equal(await to.store.claim('agent', map.id), null, 'nothing can be claimed until the user retries');
  assert.ok((await readdir(path.join(to.store.directory, map.id, 'nodes'))).length > 0);
});

test('an identical map opens the existing one and a changed one is never overwritten', async () => {
  const { store } = await workspace();
  const { map } = await workedMap(store);
  const exported = await exportMap(store, map.id);
  const before = await readFile(store.file(map.id), 'utf8');
  assert.deepEqual(await importMap(store, exported), { existing: map.id });
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing written');
  const changed = structuredClone(exported); changed.map.title = 'Field notebook, revised';
  const conflict = await importMap(store, changed);
  assert.equal(conflict.conflict.existing.title, 'Field notebook'); assert.equal(conflict.conflict.incoming.title, 'Field notebook, revised');
  assert.equal(conflict.conflict.incoming.ideas, map.nodes.length);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
  const copy = await importMap(store, changed, { asCopy: true });
  assert.notEqual(copy.imported, map.id);
  const saved = await store.get(copy.imported);
  assert.equal(saved.title, 'Field notebook, revised (copy)'); assert.deepEqual(saved.importedFrom, { mapId: map.id, revision: exported.map.revision, exportedAt: exported.exportedAt });
  assert.deepEqual(saved.nodes.map(n => n.id), map.nodes.map(n => n.id), 'idea IDs are unchanged');
  assert.equal((await store.list()).length, 2);
});

test('a bare map.json imports too; an ID outside the format always becomes a copy', async () => {
  const from = await workspace(), to = await workspace();
  const { map } = await workedMap(from.store);
  const bare = JSON.parse(await readFile(from.store.file(map.id), 'utf8'));
  assert.equal((await importMap(to.store, bare)).imported, map.id);
  const odd = structuredClone(bare); odd.id = 'my-map';
  const result = await importMap(to.store, odd);
  assert.match(result.imported, /^map-[a-f0-9]{8}$/); assert.notEqual(result.imported, map.id);
});

test('invalid files are refused with nothing written', async () => {
  const from = await workspace(), to = await workspace();
  const { map } = await workedMap(from.store);
  const good = await exportMap(from.store, map.id);
  for (const [change, message] of [
    [data => { data.map.schemaVersion = 2; }, /schema version/i],
    [data => { data.map.edges.push({ from: data.map.rootId, to: 'node-missing1', type: 'contains' }); }, /missing-node/],
    [data => { data.map.rootId = 'node-missing1'; }, /missing-node/],
    [data => { data.version = 2; }, /newer version of Explore/],
    [data => { delete data.map; data.format = 'something-else'; }, /not an Explore map/],
  ]) {
    const data = structuredClone(good); change(data);
    await assert.rejects(importMap(to.store, data), error => error.status >= 400 && message.test(error.message), String(message));
  }
  await assert.rejects(readdir(to.store.directory), 'no ideas folder was even created');
});

test('the browser and CLI export and import through the server, with a larger limit only for imports', async () => {
  const { dir } = await workspace('transfer-http-');
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { map } = await workedMap(app.store);
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = (route, body) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const exported = await (await call(`/maps/${map.id}/export`)).json();
    assert.doesNotMatch(JSON.stringify(exported), new RegExp(token));
    assert.deepEqual(await (await call('/import', { data: exported })).json(), { existing: map.id });
    const large = structuredClone(exported); large.map.nodes[0].body = 'x'.repeat(300000);
    const response = await call('/import', { data: large, asCopy: true });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await call(`/maps/${map.id}/action`, { type: 'position', nodeId: map.rootId, x: 1, y: 1, expectedRevision: map.revision, padding: 'x'.repeat(300000) })).status, 413, 'other routes keep their limit');
    const cli = (...args) => exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', dir]);
    const file = path.join(dir, 'exported.json');
    await cli('export', '--map', map.id, '--out', file);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).map.id, map.id);
    await assert.rejects(cli('export', '--map', map.id, '--out', file), /already exists/);
    const changed = JSON.parse(await readFile(file, 'utf8')); changed.map.title = 'Changed elsewhere';
    await writeFile(file + '.changed', JSON.stringify(changed));
    const conflict = JSON.parse((await cli('import', '--file', file + '.changed')).stdout);
    assert.equal(conflict.conflict.incoming.title, 'Changed elsewhere');
    const copy = JSON.parse((await cli('import', '--file', file + '.changed', '--as-copy')).stdout);
    assert.match(copy.imported, /^map-[a-f0-9]{8}$/);
  } finally { await app.close(); }
});

test('the conflict view and file names say what they mean', async () => {
  const { importConflictHtml, downloadName, briefFilename } = await import('../skills/explore/assets/workspace-view.js');
  const esc = value => String(value).replace(/</g, '&lt;');
  const html = importConflictHtml({ existing: { title: 'Plan <A>', revision: 4, updatedAt: '2026-11-20T10:00:00Z', ideas: 3 }, incoming: { title: 'Plan B', revision: 9, updatedAt: 'not a date', ideas: 1 } }, { esc });
  assert.match(html, /Nothing has been changed/); assert.match(html, /Already here.*Plan &lt;A>.*3 ideas · revision 4 · updated/s);
  assert.match(html, /In the file.*Plan B.*1 idea · revision 9<\/p>/s, 'an unreadable date is left out');
  assert.equal(downloadName('A/B: notes.', '-map.json'), 'A-B- notes-map.json');
  assert.equal(briefFilename('Field notebook'), 'Field notebook-brief.md');
});
