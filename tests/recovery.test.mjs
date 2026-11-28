import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { runDoctor } from '../skills/explore/scripts/doctor.mjs';
import { recoverHtml } from '../skills/explore/assets/recover-dialog.js';

// Recovery tools (J2, #44). Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'recovery-'));
  const app = await startServer({ workspace: dir, port: 0 });
  const { token } = await (await fetch(`${app.address}/api/session`)).json();
  const call = async (route, body) => {
    const response = await fetch(`${app.address}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { dir, app, token, call };
}
// Every file in a folder and its bytes' hash, to prove nothing in it changed.
async function fingerprint(folder) {
  const out = {};
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    out[path.relative(folder, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return out;
}
// A map with a few saved versions, one of them while work was queued.
async function versioned(app) {
  let map = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await app.store.claim('test', map.id); await app.store.complete(map.id, job.jobId, job.claimKey, { summary: 'Offline first.', body: 'Findings.' });
  map = await app.store.get(map.id);
  map = await app.store.action(map.id, { expectedRevision: map.revision, type: 'suggest', nodeId: map.rootId, title: 'Sync', body: 'How notes sync.' });
  map = await app.store.action(map.id, { expectedRevision: map.revision, type: 'activate', nodeId: map.nodes[1].id });
  return map;
}

test('a damaged map never stops the workspace: its versions list, preview and copy out, and its folder is untouched', async () => {
  const { dir, app, call } = await workspace();
  try {
    const damaged = await versioned(app), healthy = await app.store.create({ title: 'Garden plan', idea: 'A shared allotment.' });
    const folder = path.join(dir, 'ideas', damaged.id);
    await writeFile(path.join(folder, 'map.json'), '{ "this is": not json');
    const before = await fingerprint(folder);
    const listed = (await call('/maps?archived=include')).body.maps;
    assert.deepEqual(listed.find(map => map.id === damaged.id), { id: damaged.id, unreadable: true, problem: 'invalid-json' });
    assert.equal((await call(`/maps/${healthy.id}`)).status, 200, 'other maps still open');
    const { versions } = (await call(`/maps/${damaged.id}/versions`)).body;
    assert.ok(versions.length >= 3); assert.ok(versions.every(version => !version.problem));
    const queued = versions.find(version => version.labels.includes('activated'));
    const preview = (await call(`/maps/${damaged.id}/versions/${queued.id}`)).body;
    assert.equal(preview.damaged, true); assert.equal(preview.map.nodes.length, 2);
    const copy = await call('/recover-copy', { mapId: damaged.id, version: queued.id });
    assert.equal(copy.status, 200); assert.notEqual(copy.body.recovered, damaged.id);
    const opened = (await call(`/maps/${copy.body.recovered}`)).body;
    assert.deepEqual(opened.recoveredFrom, { mapId: damaged.id, version: queued.id, revision: queued.revision });
    assert.match(opened.title, /\(recovered\)$/);
    assert.ok(!opened.jobs.some(job => ['queued', 'running'].includes(job.status)), 'no queued or running work in the copy');
    assert.ok(!opened.nodes.some(node => ['queued', 'running'].includes(node.status)));
    assert.deepEqual(await fingerprint(folder), before, 'the damaged map’s files are byte-for-byte unchanged');
  } finally { await app.close(); }
});

test('a server starts with a damaged map, and the doctor names it', async () => {
  const { dir, app } = await workspace();
  const map = await app.store.create({ title: 'Field notebook', idea: 'Notes.' });
  await app.close();
  await writeFile(path.join(dir, 'ideas', map.id, 'map.json'), '<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n');
  const again = await startServer({ workspace: dir, port: 0 });
  try {
    const report = JSON.parse((await runDoctor({ workspace: dir })).stdout);
    const check = report.checks.find(entry => entry.name === 'damaged-maps');
    assert.equal(check.status, 'warning'); assert.match(check.message, new RegExp(`${map.id} \\(conflict-markers\\)`));
    assert.deepEqual(report.damagedMaps, [{ id: map.id, problem: 'conflict-markers' }]);
  } finally { await again.close(); }
});

test('versions that cannot be used are listed with a reason and refused, and a newer format is never rewritten', async () => {
  const { dir, app, call } = await workspace();
  try {
    const map = await versioned(app), folder = path.join(dir, 'ideas', map.id, 'versions');
    const [good] = (await call(`/maps/${map.id}/versions`)).body.versions;
    const record = JSON.parse(await readFile(path.join(folder, `${good.id}.json`), 'utf8'));
    const brokenId = '20200101T000000000Z-abcdef', badMapId = '20200102T000000000Z-abcdef';
    await writeFile(path.join(folder, `${brokenId}.json`), '<<<<<<< ours\n{}\n=======\n');
    await writeFile(path.join(folder, `${badMapId}.json`), JSON.stringify({ ...record, at: '2020-01-02T00:00:00.000Z', map: { ...record.map, nodes: [null] } }));
    const listed = (await call(`/maps/${map.id}/versions`)).body;
    assert.deepEqual(listed.unusable, [{ id: brokenId, problem: 'conflict-markers' }]);
    assert.equal(listed.versions.find(version => version.id === badMapId).problem, 'invalid-map');
    const refused = await call('/recover-copy', { mapId: map.id, version: badMapId });
    assert.equal(refused.status, 409); assert.doesNotMatch(JSON.stringify(refused.body), /[A-Za-z]:\\|\/Users\/|\.test-output/, 'no paths in errors');
    assert.equal((await call('/recover-copy', { mapId: map.id, version: 'nope' })).status, 404);
    // A map saved by a newer Explore is read for recovery but never written.
    const file = path.join(dir, 'ideas', map.id, 'map.json'), newer = JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), schemaVersion: 2 });
    await writeFile(file, newer);
    await call('/maps?archived=include'); await call(`/maps/${map.id}/versions`); await call('/recover-copy', { mapId: map.id, version: good.id });
    assert.equal(await readFile(file, 'utf8'), newer);
  } finally { await app.close(); }
});

test('a healthy map can copy a version out too, and the copy is its own map', async () => {
  const { app, call } = await workspace();
  try {
    const map = await versioned(app), [latest] = (await call(`/maps/${map.id}/versions`)).body.versions;
    const before = (await call(`/maps/${map.id}`)).body.revision;
    const copy = await call('/recover-copy', { mapId: map.id, version: latest.id });
    assert.equal(copy.status, 200); assert.equal((await call(`/maps/${map.id}`)).body.revision, before, 'the original is not changed');
    assert.notEqual(copy.body.recovered, map.id); assert.equal((await call(`/maps/${copy.body.recovered}`)).status, 200, 'the copy opens');
  } finally { await app.close(); }
});

test('the recovery list offers Preview and Copy only for usable versions, and says why the others cannot be used', () => {
  const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const html = recoverHtml({ mapId: 'map-0000000a', problem: 'invalid-json', versions: [{ id: 'v1', at: '2026-11-02T10:00:00.000Z', revision: 4, labels: ['suggested'] }, { id: 'v2', at: '2026-11-01T10:00:00.000Z', revision: 3, labels: ['result'], problem: 'invalid-map' }], unusable: [{ id: 'v0', problem: 'conflict-markers' }] }, { esc });
  assert.match(html, /cannot be opened/); assert.match(html, /never changed/);
  assert.match(html, /data-recover-preview="v1"/); assert.match(html, /data-recover-copy="v1"/);
  assert.doesNotMatch(html, /data-recover-preview="v2"|data-recover-copy="v2"|data-recover-copy="v0"/);
  assert.match(html, /revision 3[^<]*<\/strong>[\s\S]*?Cannot be used/); assert.match(html, /Cannot be used: unresolved Git conflict/);
});
