import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';

const exec = promisify(execFile);
async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'outside-'));
  const store = new Store(path.join(dir, 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  return { dir, store, map };
}
// Simulates a pull or branch switch: same revision, different content.
async function replaceOutside(store, mapId, change) {
  const file = store.file(mapId);
  const map = JSON.parse(await readFile(file, 'utf8'));
  change(map);
  const bytes = JSON.stringify(map, null, 2) + '\n';
  await writeFile(file, bytes);
  return bytes;
}
const preserved = async (store, mapId) => {
  try { return await readdir(path.join(store.directory, mapId, 'preserved')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

test('an edit from an outdated view never overwrites a map changed outside Explore', async () => {
  const { store, map } = await fixture();
  const before = await store.get(map.id);
  const bytes = await replaceOutside(store, map.id, m => { m.title = 'Renamed by a teammate'; });
  await assert.rejects(store.action(map.id, { expectedRevision: before.revision, nodeId: map.rootId, type: 'suggest', title: 'Mine', body: 'From the old view.' }),
    error => error.status === 409 && error.code === 'changed-outside');
  assert.equal(await readFile(store.file(map.id), 'utf8'), bytes, 'a matching revision alone never authorises the write');
});

test('a browser still showing the old version is refused even after Explore adopted the new one', async () => {
  const { store, map } = await fixture();
  await store.get(map.id);
  const shown = store.tracking(map.id).fingerprint;
  await replaceOutside(store, map.id, m => { m.title = 'Renamed by a teammate'; });
  const adopted = await store.get(map.id); // Another tab, the agent or the poll read it first.
  await assert.rejects(store.action(map.id, { expectedRevision: adopted.revision, expectedFingerprint: shown, nodeId: map.rootId, type: 'suggest', title: 'Mine', body: 'From the old view.' }),
    error => error.code === 'changed-outside');
  const saved = await store.action(map.id, { expectedRevision: adopted.revision, expectedFingerprint: store.tracking(map.id).fingerprint, nodeId: map.rootId, type: 'suggest', title: 'Mine', body: 'From the new view.' });
  assert.equal(saved.nodes.length, 2);
});

test('the next read adopts an outside change, keeps the previous version and says so', async () => {
  const { store, map } = await fixture();
  const original = await readFile(store.file(map.id), 'utf8');
  await store.get(map.id);
  await replaceOutside(store, map.id, m => { m.title = 'Renamed by a teammate'; });
  const adopted = await store.get(map.id);
  assert.equal(adopted.title, 'Renamed by a teammate');
  const change = store.tracking(map.id).outsideChange;
  assert.ok(change.at); assert.match(change.preserved, /^preserved\/.+\.json$/);
  assert.equal(await readFile(path.join(store.directory, map.id, change.preserved), 'utf8'), original);
  const saved = await store.action(map.id, { expectedRevision: adopted.revision, nodeId: map.rootId, type: 'suggest', title: 'After the pull', body: 'Continues the teammate version.' });
  assert.equal(saved.title, 'Renamed by a teammate'); assert.equal(saved.nodes.length, 2);
});

test('a map whose revision goes backwards is adopted, not ignored', async () => {
  const { store, map } = await fixture();
  const older = await readFile(store.file(map.id), 'utf8');
  const newer = await store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'suggest', title: 'Later work', body: 'Added after the old version.' });
  await writeFile(store.file(map.id), older);
  const adopted = await store.get(map.id);
  assert.ok(adopted.revision < newer.revision);
  assert.equal(adopted.nodes.length, 1);
  assert.ok(store.tracking(map.id).outsideChange);
});

test('changes made through Explore, including agent results, are never outside changes', async () => {
  const { store, map } = await fixture();
  const job = await store.claim('test');
  await Promise.all([store.get(map.id), store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Finished.', questions: ['Next?'] }), store.get(map.id), store.list()]);
  const saved = await store.get(map.id);
  await store.action(map.id, { expectedRevision: saved.revision, nodeId: map.rootId, type: 'answer', questionId: saved.nodes[0].questions[0].id, answer: 'Yes.' });
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange, null);
  assert.deepEqual(await preserved(store, map.id), []);
  assert.match(store.tracking(map.id).fingerprint, /^[a-f0-9]{64}$/);
});

test('a read that saw the old file just before a save never mistakes that save for an outside change', async () => {
  const { store, map } = await fixture();
  await store.get(map.id);
  // Pause one read after it has the old bytes, so the save happens in between.
  const read = store.read.bind(store);
  let release, paused = true;
  const gate = new Promise(resolve => { release = resolve; });
  store.read = async mapId => { const result = await read(mapId); if (paused) { paused = false; await gate; } return result; };
  const slowRead = store.get(map.id);
  const saving = store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'position', x: 4, y: 2 });
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await Promise.all([slowRead, saving]);
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange, null);
  const saved = await store.action(map.id, { expectedRevision: map.revision + 1, nodeId: map.rootId, type: 'position', x: 5, y: 2 });
  assert.deepEqual(saved.view.positions[map.rootId], { x: 5, y: 2 }, 'later edits are not refused either');
});

test('reads racing saves never report an outside change', async () => {
  const { store, map } = await fixture();
  let revision = map.revision;
  for (let index = 0; index < 15; index++) {
    const reads = Array.from({ length: 4 }, () => store.get(map.id));
    const saved = await store.action(map.id, { expectedRevision: revision, nodeId: map.rootId, type: 'position', x: index, y: index });
    revision = saved.revision; await Promise.all(reads);
  }
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange, null);
});

test('the first read after a restart adopts silently', async () => {
  const { store, map } = await fixture();
  await replaceOutside(store, map.id, m => { m.title = 'Changed while the server was stopped'; });
  const restarted = new Store(store.directory);
  assert.equal((await restarted.get(map.id)).title, 'Changed while the server was stopped');
  assert.equal(restarted.tracking(map.id).outsideChange, null);
  assert.deepEqual(await preserved(restarted, map.id), []);
});

test('each previous version is preserved once', async () => {
  const { store, map } = await fixture();
  const first = await readFile(store.file(map.id), 'utf8');
  await store.get(map.id);
  const second = await replaceOutside(store, map.id, m => { m.title = 'Second'; });
  await store.get(map.id);
  await writeFile(store.file(map.id), first); await store.get(map.id);
  await writeFile(store.file(map.id), second); await store.get(map.id);
  assert.equal((await preserved(store, map.id)).length, 2);
});

test('a previous version Git already has is not copied again', async t => {
  const { dir, store, map } = await fixture();
  try { await exec('git', ['init', '-q', dir]); } catch { t.skip('Git is not available.'); return; }
  await store.get(map.id);
  await exec('git', ['-C', dir, 'hash-object', '-w', store.file(map.id)]);
  await replaceOutside(store, map.id, m => { m.title = 'Pulled from a teammate'; });
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange.preserved, null, 'the previous version is safe in Git');
  assert.equal(store.tracking(map.id).outsideChange.inGit, true);
  assert.deepEqual(await preserved(store, map.id), []);
});

test('the agent receives work from a pulled map and can deliver into a merged one', async () => {
  const { store, map } = await fixture();
  await store.get(map.id);
  await replaceOutside(store, map.id, m => { m.title = 'Pulled'; });
  const job = await store.claim('test');
  assert.equal(job.mapTitle, 'Pulled');
  await replaceOutside(store, map.id, m => { m.nodes[0].prompt = 'Merged premise from a teammate.'; });
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Delivered.', body: 'Into the merged map.' });
  assert.equal(saved.nodes[0].summary, 'Delivered.');
});

test('one unreadable map is listed as unreadable and never blocks the others or startup', async () => {
  const { dir, store, map } = await fixture();
  const other = await store.create({ title: 'Second map', idea: 'Still opens.' });
  const cases = {
    'conflict-markers': raw => `<<<<<<< HEAD\n${raw}=======\n${raw}>>>>>>> teammate\n`,
    'invalid-json': raw => raw.slice(0, 40),
    'unsupported-version': raw => raw.replace('"schemaVersion": 1', '"schemaVersion": 99'),
    'invalid-map': raw => raw.replace(/"nodes": \[/, '"nodez": ['),
  };
  for (const [problem, damage] of Object.entries(cases)) {
    const raw = await readFile(store.file(other.id), 'utf8');
    const bad = damage(raw);
    await writeFile(store.file(map.id), bad);
    const restarted = new Store(path.join(dir, 'ideas'));
    await restarted.recover();
    const list = await restarted.list();
    const entry = list.find(item => item.id === map.id);
    assert.deepEqual(entry, { id: map.id, unreadable: true, problem }, problem);
    assert.equal(list.find(item => item.id === other.id).title, 'Second map');
    await assert.rejects(restarted.get(map.id), error => error.status === 409 && error.code === problem && !error.message.includes('schemaVersion') && !error.message.includes('Still opens'));
    const job = await restarted.claim('test');
    assert.equal(job.mapId, other.id, 'work from readable maps is still handed out');
    await restarted.fail(other.id, job.jobId, job.claimKey, 'Reset for the next case.');
    await restarted.action(other.id, { expectedRevision: (await restarted.get(other.id)).revision, nodeId: other.rootId, type: 'activate' });
    assert.equal(await readFile(store.file(map.id), 'utf8'), bad, 'the unreadable file is never rewritten');
  }
});

test('a map file copied into another folder is unreadable rather than saved over the original', async () => {
  const { store, map } = await fixture();
  const copy = 'map-0000c0de';
  await mkdir(path.join(store.directory, copy));
  await writeFile(store.file(copy), await readFile(store.file(map.id)));
  assert.deepEqual((await store.list()).find(item => item.id === copy), { id: copy, unreadable: true, problem: 'invalid-map' });
});
