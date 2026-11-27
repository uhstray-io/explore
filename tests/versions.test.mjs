import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';

async function fixture(options) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'versions-'));
  const store = new Store(path.join(dir, 'ideas'), options);
  const map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  return { dir, store, map };
}
async function act(store, mapId, input, actor) {
  const map = await store.get(mapId);
  return store.action(mapId, { expectedRevision: map.revision, ...input }, actor ? { actor } : {});
}
const suggest = (store, map, title) => act(store, map.id, { type: 'suggest', nodeId: map.rootId, title, body: `About ${title}.` });
const files = async (store, mapId) => { try { return (await readdir(path.join(store.directory, mapId, 'versions'))).sort(); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

test('each content change records one version; moving an idea and claiming work do not', async () => {
  const { store, map } = await fixture();
  assert.equal((await store.versions.list(map.id)).versions.length, 1, 'creating the map is the first version');
  await act(store, map.id, { type: 'position', nodeId: map.rootId, x: 10, y: 20 });
  const job = await store.claim('test');
  assert.equal((await store.versions.list(map.id)).versions.length, 1);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions: ['Who decides?'] });
  let saved = await store.get(map.id);
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'The owner.' }, { name: 'Ana' });
  await suggest(store, map, 'Sync timing');
  const { versions } = await store.versions.list(map.id);
  assert.equal(versions.length, 4);
  assert.deepEqual(versions.map(v => v.labels.join(',')), ['suggested', 'answered,activated', 'result', 'activated']);
  assert.equal(versions[1].author, 'Ana'); assert.equal(versions[0].author, undefined);
  assert.equal((await files(store, map.id)).length, 4, 'one standalone file per version, no index file');
});

test('a version holds the map exactly as it was, without claim data', async () => {
  const { store, map } = await fixture();
  const job = await store.claim('test');
  const completed = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.' });
  const [latest] = (await store.versions.list(map.id)).versions;
  const { map: snapshot } = await store.versions.get(map.id, latest.id);
  assert.equal(snapshot.revision, completed.revision);
  assert.equal(snapshot.nodes[0].summary, 'Found.');
  const raw = await readFile(path.join(store.directory, map.id, 'versions', `${latest.id}.json`), 'utf8');
  assert.doesNotMatch(raw, /claimKey|claimHash|inputSignature/);
});

test('versions from two people merge as separate files and list in time order', async () => {
  const { store, map } = await fixture();
  await suggest(store, map, 'Mine');
  const [mine] = (await store.versions.list(map.id)).versions;
  const folder = path.join(store.directory, map.id, 'versions');
  const theirs = JSON.parse(await readFile(path.join(folder, `${mine.id}.json`), 'utf8'));
  theirs.at = new Date(Date.parse(mine.at) - 1000).toISOString(); theirs.author = 'Bo'; theirs.labels = ['suggested']; theirs.map.title = 'Their edit';
  await writeFile(path.join(folder, '20200101T000000000Z-b0b0b0.json'), JSON.stringify(theirs, null, 2));
  const { versions } = await store.versions.list(map.id);
  assert.equal(versions.length, 3);
  assert.ok(versions.some(v => v.author === 'Bo'), 'their version is listed beside mine');
  assert.deepEqual(versions.map(v => v.at), versions.map(v => v.at).sort().reverse(), 'newest first across both histories');
});

test('identical snapshots are not written twice', async () => {
  const { store, map } = await fixture();
  const before = await files(store, map.id);
  const current = await store.get(map.id);
  await store.versions.record(current, { labels: ['suggested'] });
  assert.deepEqual(await files(store, map.id), before);
});

test('retention keeps every named version and stays within the count and byte limits', async () => {
  const { store, map } = await fixture({ versionLimits: { count: 3, bytes: 1e9, names: 10 } });
  const first = (await store.versions.list(map.id)).versions[0];
  await act(store, map.id, { type: 'name-version', version: first.id, name: 'Starting point' });
  for (const title of ['A', 'B', 'C', 'D', 'E']) await suggest(store, map, title);
  let { versions } = await store.versions.list(map.id);
  assert.equal(versions.filter(v => !v.name).length, 3);
  assert.equal(versions.find(v => v.id === first.id).name, 'Starting point');
  const small = await fixture({ versionLimits: { count: 50, bytes: 9000, names: 10 } });
  for (const title of ['A', 'B', 'C', 'D', 'E', 'F']) await suggest(small.store, small.map, title);
  versions = (await small.store.versions.list(small.map.id)).versions;
  assert.ok(versions.reduce((total, v) => total + v.bytes, 0) <= 9000);
  assert.ok(versions.length >= 1, 'the newest version is always kept');
});

test('restoring brings back the map as it was, keeps the event log and growth, and can be undone', async () => {
  const { store, map } = await fixture();
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions: ['Next?'] });
  await suggest(store, map, 'Keep me');
  const withA = (await store.versions.list(map.id)).versions[0];
  await suggest(store, map, 'Restore removes me');
  const before = await store.get(map.id);
  const restored = await act(store, map.id, { type: 'restore-version', version: withA.id });
  assert.deepEqual(restored.nodes.map(n => n.title), ['Field notebook', 'Keep me']);
  assert.ok(restored.history.length > before.history.length, 'the event log only grows');
  assert.deepEqual(restored.growth, before.growth, 'growth history is kept');
  assert.equal(restored.revision, before.revision + 1);
  const latest = (await store.versions.list(map.id)).versions;
  assert.deepEqual(latest[0].labels, ['version-restored']);
  const undone = await act(store, map.id, { type: 'restore-version', version: latest[1].id });
  assert.deepEqual(undone.nodes.map(n => n.title), ['Field notebook', 'Keep me', 'Restore removes me']);
});

test('restoring keeps today’s positions for ideas that still exist', async () => {
  const { store, map } = await fixture();
  const first = (await store.versions.list(map.id)).versions[0];
  await suggest(store, map, 'Later');
  await act(store, map.id, { type: 'position', nodeId: map.rootId, x: 123, y: 45 });
  const job = await store.claim('test'); await store.fail(map.id, job.jobId, job.claimKey, 'Stopped for the test.');
  const restored = await act(store, map.id, { type: 'restore-version', version: first.id });
  assert.deepEqual(restored.view.positions[map.rootId], { x: 123, y: 45 });
});

test('restore is refused while work is queued or running, and when nothing would change', async () => {
  const { store, map } = await fixture();
  const first = (await store.versions.list(map.id)).versions[0];
  await assert.rejects(act(store, map.id, { type: 'restore-version', version: first.id }), error => error.status === 409 && /queued or running/.test(error.message));
  const job = await store.claim('test');
  await assert.rejects(act(store, map.id, { type: 'restore-version', version: first.id }), error => error.status === 409);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions: ['Next?'] });
  const latest = (await store.versions.list(map.id)).versions[0];
  await assert.rejects(act(store, map.id, { type: 'restore-version', version: latest.id }), error => error.status === 409 && /already matches/.test(error.message));
  await assert.rejects(act(store, map.id, { type: 'restore-version', version: 'missing-000000' }), error => error.status === 404);
});

test('work that was active in the restored version comes back interrupted, so an old claim cannot deliver', async () => {
  const { store, map } = await fixture();
  const queued = (await store.versions.list(map.id)).versions[0];
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions: ['Next?'] });
  const restored = await act(store, map.id, { type: 'restore-version', version: queued.id });
  assert.equal(restored.jobs[0].status, 'interrupted'); assert.equal(restored.jobs[0].claimKey, undefined);
  assert.equal(restored.nodes[0].status, 'interrupted');
  await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Too late.' }), error => error.status === 409);
  assert.equal(await store.claim('test'), null, 'restoring never starts research');
});

test('the preview shows the version exactly, counts the differences and lists reopened branches', async () => {
  const { store, map } = await fixture();
  const queued = (await store.versions.list(map.id)).versions[0];
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Finished.', body: 'Complete.', suggestions: [{ title: 'Child', body: 'Later.' }] });
  const before = await readFile(store.file(map.id), 'utf8');
  const preview = await store.versions.preview(map.id, queued.id);
  assert.equal(preview.map.nodes.length, 1); assert.equal(preview.map.nodes[0].status, 'queued');
  assert.deepEqual(preview.counts, { nodesAdded: 0, nodesRemoved: 1, nodesChanged: 1, linksAdded: 0, linksRemoved: 1 });
  assert.deepEqual(preview.reopened, [map.rootId]);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'previewing writes nothing');
});

test('versions can be named, at most ten, each unique and 1–120 characters', async () => {
  const { store, map } = await fixture({ versionLimits: { count: 50, bytes: 1e9, names: 2 } });
  await suggest(store, map, 'A'); await suggest(store, map, 'B');
  const [c, b, a] = (await store.versions.list(map.id)).versions;
  await act(store, map.id, { type: 'name-version', version: a.id, name: 'First' });
  await assert.rejects(act(store, map.id, { type: 'name-version', version: b.id, name: 'First' }), /already used/);
  await assert.rejects(act(store, map.id, { type: 'name-version', version: b.id, name: 'x'.repeat(121) }), /120/);
  await act(store, map.id, { type: 'name-version', version: b.id, name: 'Second' });
  await assert.rejects(act(store, map.id, { type: 'name-version', version: c.id, name: 'Third' }), /at most 2/);
  await act(store, map.id, { type: 'unname-version', version: a.id });
  await act(store, map.id, { type: 'name-version', version: c.id, name: 'Third' });
  const names = (await store.versions.list(map.id)).versions.map(v => v.name ?? null);
  assert.deepEqual(names, ['Third', 'Second', null]);
});

test('maps saved before version history load unchanged and say earlier versions are missing', async () => {
  const { store, map } = await fixture();
  await suggest(store, map, 'A');
  await rm(path.join(store.directory, map.id, 'versions'), { recursive: true });
  const restarted = new Store(store.directory);
  const listing = await restarted.versions.list(map.id);
  assert.deepEqual(listing.versions, []); assert.equal(listing.earlierMissing, true);
});

test('a version replaced by an outside change is kept unless an identical version exists', async () => {
  const { store, map } = await fixture();
  await store.get(map.id);
  const count = (await files(store, map.id)).length;
  const file = store.file(map.id);
  const pulled = JSON.parse(await readFile(file, 'utf8')); pulled.title = 'Pulled';
  await writeFile(file, JSON.stringify(pulled, null, 2) + '\n');
  await store.get(map.id);
  assert.equal((await files(store, map.id)).length, count, 'the replaced version was already recorded');
  assert.ok(store.tracking(map.id).outsideChange.preserved);
  pulled.title = 'Pulled again';
  await writeFile(file, JSON.stringify(pulled, null, 2) + '\n');
  await store.get(map.id);
  const { versions } = await store.versions.list(map.id);
  assert.equal(versions.length, count + 1);
  assert.deepEqual(versions[0].labels, ['before-outside-change']);
  assert.equal((await store.versions.get(map.id, versions[0].id)).map.title, 'Pulled');
});

test('copies kept before version history existed are imported as versions', async () => {
  const { store, map } = await fixture();
  const preserved = path.join(store.directory, map.id, 'preserved');
  await mkdir(preserved);
  const old = JSON.parse(await readFile(store.file(map.id), 'utf8')); old.title = 'Kept by H3';
  await writeFile(path.join(preserved, '2026-11-27T10-00-00-000Z-abcdef0123456789.json'), JSON.stringify(old, null, 2));
  const restarted = new Store(store.directory);
  await restarted.recover();
  const { versions } = await restarted.versions.list(map.id);
  assert.ok(versions.some(v => v.labels.includes('preserved')));
  await assert.rejects(readdir(preserved), error => error.code === 'ENOENT');
});

test('the browser lists versions, previews one without writing, and restores it', async () => {
  const { startServer } = await import('../skills/explore/scripts/server.mjs');
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'versions-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = (route, body, authorized = true) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let map = await (await call('/maps', { title: 'Shared notes', idea: 'Works offline.' })).json();
    const packet = await (await call('/next?worker=test')).json();
    map = await (await call(`/maps/${map.id}/result`, { jobId: packet.jobId, claimKey: packet.claimKey, result: { summary: 'Found.', body: 'Details.', questions: ['Next?'] } })).json();
    map = await (await call(`/maps/${map.id}/action`, { expectedRevision: map.revision, expectedFingerprint: map.fingerprint, nodeId: map.rootId, type: 'suggest', title: 'Later idea', body: 'Added after.' })).json();
    assert.equal((await call(`/maps/${map.id}/versions`, undefined, false)).status, 401);
    const listing = await (await call(`/maps/${map.id}/versions`)).json();
    assert.equal(listing.versions.length, 3); assert.equal(listing.earlierMissing, false);
    const target = listing.versions[1];
    const before = await readFile(path.join(workspace, 'ideas', map.id, 'map.json'), 'utf8');
    const preview = await (await call(`/maps/${map.id}/versions/${target.id}`)).json();
    assert.equal(preview.map.nodes.length, 1); assert.equal(preview.counts.nodesRemoved, 1);
    assert.doesNotMatch(JSON.stringify(preview), /claimKey|inputSignature/);
    assert.equal(await readFile(path.join(workspace, 'ideas', map.id, 'map.json'), 'utf8'), before);
    assert.equal((await call(`/maps/${map.id}/versions/nope`)).status, 404);
    assert.equal((await call(`/maps/map-00000000/versions`)).status, 404);
    const restored = await (await call(`/maps/${map.id}/action`, { expectedRevision: map.revision, expectedFingerprint: map.fingerprint, type: 'restore-version', version: target.id })).json();
    assert.equal(restored.nodes.length, 1);
    for (const name of await readdir(path.join(workspace, 'ideas', map.id, 'versions'))) {
      assert.doesNotMatch(await readFile(path.join(workspace, 'ideas', map.id, 'versions', name), 'utf8'), /claimKey|claimHash|inputSignature/);
    }
  } finally { await app.close(); }
});
