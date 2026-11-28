import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { searchMaps } from '../skills/explore/scripts/search.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { railHtml } from '../skills/explore/assets/rail.js';

// Pin, archive and search all maps (I1, #39). Illustrative fixtures under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'library-'));
  const store = new Store(path.join(dir, 'ideas'));
  const settled = async (title, idea, result) => {
    const map = await store.create({ title, idea });
    const job = await store.claim('setup', map.id);
    return store.complete(map.id, job.jobId, job.claimKey, result ?? { summary: `${title} explored.`, body: 'Findings.' });
  };
  const act = async (map, input) => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  return { dir, store, settled, act };
}

test('pinning puts a map first and survives a restart, without a version', async () => {
  const { store, settled, act } = await workspace();
  const old = await settled('Garden plan', 'A shared allotment.');
  await settled('Field notebook', 'Notes that work offline.');
  const versions = (await store.versions.list(old.id)).versions.length;
  await act(old, { type: 'pin', pinned: true });
  assert.equal((await store.list())[0].id, old.id); assert.equal((await store.list())[0].pinned, true);
  assert.equal((await new Store(store.directory).list())[0].id, old.id, 'after a restart');
  assert.equal((await store.versions.list(old.id)).versions.length, versions, 'no version is recorded');
  assert.deepEqual(JSON.parse(await readFile(store.file(old.id), 'utf8')).library, { pinned: true, archived: false });
});

test('archiving hides a map from the default list unless it has work waiting; unarchiving brings it back', async () => {
  const { dir, store, settled, act } = await workspace();
  const old = await settled('Garden plan', 'A shared allotment.'), busy = await settled('Field notebook', 'Notes.');
  const before = JSON.parse(await readFile(store.file(old.id), 'utf8'));
  await act(old, { type: 'archive', archived: true });
  await act(busy, { type: 'suggest', nodeId: busy.rootId, title: 'Sync', body: 'x' });
  const child = (await store.get(busy.id)).nodes[1];
  await act(busy, { type: 'activate', nodeId: child.id }); await act(busy, { type: 'archive', archived: true });
  const after = JSON.parse(await readFile(store.file(old.id), 'utf8'));
  const { library, revision, updatedAt, ...rest } = after, { library: _, revision: r, updatedAt: u, ...was } = before;
  assert.deepEqual(rest, was, 'only the library state changed'); assert.equal(library.archived, true); assert.match(library.archivedAt, /^\d{4}-/);
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const maps = async query => (await (await fetch(`${app.address}/api/maps${query}`, { headers: { Authorization: `Bearer ${token}` } })).json()).maps.map(m => m.id);
    assert.deepEqual(await maps(''), [busy.id], 'an archived map with work waiting still shows');
    assert.deepEqual((await maps('?archived=include')).sort(), [old.id, busy.id].sort());
    assert.deepEqual((await maps('?archived=only')).sort(), [old.id, busy.id].sort());
    await act(old, { type: 'archive', archived: false });
    assert.ok((await maps('')).includes(old.id));
  } finally { await app.close(); }
});

test('search finds text only in an answer or a source note, with short excerpts and pages', async () => {
  const { store, settled, act } = await workspace();
  const map = await settled('Field notebook', 'Notes that work offline.', { summary: 'Sync matters.', body: 'Findings.', questions: ['Who edits?'],
    sources: [{ title: 'Field study', url: 'https://example.org/study', note: 'Teams used solar chargers in the valley for a month.' }] });
  await act(map, { type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Only the ranger with a satellite phone edits.' });
  for (let i = 0; i < 4; i++) await settled(`Other ${i}`, 'Nothing relevant.');
  let result = await searchMaps(store, { query: 'satellite phone' });
  assert.deepEqual(result.hits.map(h => h.mapId), [map.id]);
  assert.deepEqual(result.hits[0].matches[0], { nodeId: map.rootId, field: 'answer', excerpt: 'Only the ranger with a satellite phone edits.' });
  result = await searchMaps(store, { query: 'SOLAR' });
  assert.equal(result.hits[0].matches[0].field, 'source');
  const long = await settled('Long map', 'x'.repeat(50) + ' needle ' + 'y'.repeat(400));
  for (let i = 0; i < 5; i++) await act(long, { type: 'suggest', nodeId: long.rootId, title: `needle ${i}`, body: `needle in branch ${i}` });
  const found = (await searchMaps(store, { query: 'needle' })).hits.find(h => h.mapId === long.id);
  assert.equal(found.matches.length, 3); assert.ok(found.more > 0); assert.ok(found.matches.every(m => m.excerpt.length <= 160));
  const paged = await searchMaps(store, { query: 'Nothing relevant', limit: 2 });
  assert.equal(paged.hits.length, 2); assert.equal(paged.nextOffset, 2);
  await assert.rejects(searchMaps(store, { query: 'Nothing relevant', offset: 2, limit: 2 }), error => error.status === 409, 'continuing needs the revision');
  await act(map, { type: 'pin', pinned: true });
  await assert.rejects(searchMaps(store, { query: 'Nothing relevant', offset: 2, limit: 2, revision: paged.revision }), error => error.status === 409, 'a change restarts the search');
  await assert.rejects(searchMaps(store, { query: 'x' }), error => error.status === 400);
});

test('a pull that only changes pin or archive state is not an outside change', async () => {
  const { store, settled } = await workspace();
  const map = await settled('Field notebook', 'Notes.');
  await store.get(map.id);
  const file = store.file(map.id), saved = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...saved, library: { pinned: true, archived: false } }, null, 2) + '\n');
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange, null);
});

test('the CLI keeps title search, adds content search and shows archived maps on request', async () => {
  const { dir, store, settled, act } = await workspace();
  const map = await settled('Field notebook', 'Notes that work offline in the valley.');
  const archived = await settled('Garden plan', 'A shared allotment.');
  await act(archived, { type: 'archive', archived: true });
  const app = await startServer({ workspace: dir, port: 0 });
  const cli = async args => JSON.parse((await promisify(execFile)(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', dir])).stdout);
  try {
    assert.deepEqual((await cli(['maps', '--query', 'field'])).maps.map(m => m.id), [map.id]);
    assert.deepEqual((await cli(['maps', '--query', 'valley'])).maps, [], 'titles and IDs only, as before');
    assert.deepEqual((await cli(['maps', '--query', 'valley', '--content'])).hits.map(h => h.mapId), [map.id]);
    assert.ok((await cli(['maps', '--archived', 'include'])).maps.some(m => m.id === archived.id));
    assert.ok(!(await cli(['maps'])).maps.some(m => m.id === archived.id));
  } finally { await app.close(); }
});

test('the rail lists pinned maps first, offers Pin and Archive in each map\'s ⋯ menu, and hides archived ones', () => {
  const maps = [{ id: 'map-a', title: 'Pinned', count: 2, pinned: true }, { id: 'map-b', title: 'Plain', count: 1 }, { id: 'map-c', title: 'Old', count: 3, archived: true }];
  const html = railHtml(maps, { esc: String, currentId: 'map-b', showArchived: false });
  assert.ok(html.indexOf('Pinned') < html.indexOf('Plain')); assert.doesNotMatch(html, /Old/);
  assert.match(html, /data-map-pin="map-a"[^>]*>Unpin</); assert.match(html, /data-map-pin="map-b"[^>]*>Pin</);
  assert.match(html, /data-map-archive="map-b"[^>]*>Archive</);
  const archivedView = railHtml(maps, { esc: String, currentId: null, showArchived: true });
  assert.match(archivedView, /Old/); assert.match(archivedView, /data-map-archive="map-c"[^>]*>Unarchive</);
});

test('one idea\'s repeated sentence is one match, so a real match elsewhere is not hidden', async () => {
  const { store, settled, act } = await workspace();
  const map = await settled('Field notebook', 'Whether mesh radio works.');
  await act(map, { type: 'suggest', nodeId: map.rootId, title: 'Antenna', body: 'A taller mesh radio antenna.' });
  const hit = (await searchMaps(store, { query: 'mesh radio' })).hits[0];
  assert.ok(hit.matches.some(match => match.nodeId !== map.rootId), 'the Antenna idea is among the matches');
});

test('unpinning or archiving never moves a map up, and a change that changes nothing is refused', async () => {
  const { store, settled, act } = await workspace();
  const older = await settled('Garden plan', 'A shared allotment.');
  const newer = await settled('Field notebook', 'Notes.');
  await act(older, { type: 'pin', pinned: true });
  await act(older, { type: 'pin', pinned: false });
  assert.deepEqual((await store.list()).map(m => m.id), [newer.id, older.id]);
  await assert.rejects(act(older, { type: 'pin', pinned: false }), error => error.status === 409);
});
