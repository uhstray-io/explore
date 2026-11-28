import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { branchRestoration, previewBranchRestore } from '../skills/explore/scripts/branch-restore.mjs';
import { restorableHash } from '../skills/explore/scripts/versions.mjs';
import { branchRestoreHtml } from '../skills/explore/assets/branch-restore.js';

// Restore one branch from a saved version (E2, #21). Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'branch-restore-'));
  return { dir, store: new Store(path.join(dir, 'ideas')) };
}
// The Store's read-only rules (isComplete, hasConclusions, affectedBy); nothing is written.
const rules = new Store(path.resolve('.test-output', 'branch-restore-rules'));
const n = (id, parentId, extra = {}) => ({ id, parentId, title: `Idea ${id}`, kind: parentId ? 'research' : 'idea', prompt: `Premise ${id}.`, body: `Premise ${id}.`, summary: `Premise ${id}.`,
  status: 'suggested', reviewState: 'unreviewed', stale: false, contentRevision: 1, questions: [], sources: [], ...extra });
const explored = (id, parentId, extra = {}) => n(id, parentId, { status: 'explored', completedAt: '2026-01-01T00:00:00.000Z', summary: `Found ${id}.`, body: `Findings ${id}.`, ...extra });
const mapOf = (nodes, links = [], extra = {}) => ({ schemaVersion: 1, id: 'map-0000000a', rootId: 'root', title: 'Field notebook', revision: 5, nodes,
  edges: [...nodes.filter(node => node.parentId).map(node => ({ from: node.parentId, to: node.id, type: 'contains' })), ...links], jobs: [], history: [], view: { positions: {} }, ...extra });
const ids = list => list.map(item => item.id ?? item).sort();
const linkKeys = edges => edges.filter(edge => edge.type !== 'contains').map(edge => `${edge.from} ${edge.type} ${edge.to}`).sort();

test('the branch comes back as it was, nodes added since are removed, and nothing outside changes', () => {
  const then = mapOf([explored('root', null), explored('a', 'root'), n('a1', 'a'), n('a2', 'a'), n('b', 'root')]);
  const now = mapOf([explored('root', null), explored('a', 'root', { summary: 'Newer finding.' }), n('a1', 'a', { prompt: 'Changed.', body: 'Changed.', summary: 'Changed.', contentRevision: 2 }),
    n('a2', 'a'), n('a3', 'a'), n('b', 'root', { summary: 'Edited later.', contentRevision: 3 }), n('b1', 'b')]);
  const before = structuredClone([now, then]);
  const plan = branchRestoration(now, then, 'a', rules);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(structuredClone([now, then]), before, 'the inputs are never changed');
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  assert.equal(byId.get('a').summary, 'Found a.'); assert.equal(byId.get('a1').prompt, 'Premise a1.');
  assert.equal(byId.has('a3'), false); assert.equal(byId.get('b').summary, 'Edited later.'); assert.ok(byId.has('b1'));
  assert.deepEqual(ids(plan.changes.changed), ['a', 'a1']); assert.deepEqual(ids(plan.changes.removed), ['a3']); assert.deepEqual(plan.changes.readded, []);
  assert.deepEqual(plan.changes.changed.find(change => change.id === 'a'), { id: 'a', title: 'Idea a', before: 'Newer finding.', after: 'Found a.' });
  assert.ok(!plan.edges.some(edge => edge.to === 'a3'), 'its containment link goes with it');
});

test('a deep branch deleted since the version comes back with the version’s positions; survivors keep today’s', () => {
  const then = mapOf([n('root', null), n('a', 'root'), n('a1', 'a'), n('a11', 'a1'), n('b', 'root')], [], { view: { positions: { a: { x: 1, y: 1 }, a1: { x: 2, y: 2 }, a11: { x: 3, y: 3 } } } });
  const now = mapOf([n('root', null), n('a', 'root'), n('a2', 'a'), n('b', 'root')], [], { view: { positions: { a: { x: 9, y: 9 }, a2: { x: 8, y: 8 }, b: { x: 7, y: 7 } } } });
  const plan = branchRestoration(now, then, 'a', rules);
  assert.deepEqual(ids(plan.changes.readded), ['a1', 'a11']); assert.deepEqual(ids(plan.changes.removed), ['a2']);
  assert.deepEqual(plan.positions, { a: { x: 9, y: 9 }, a1: { x: 2, y: 2 }, a11: { x: 3, y: 3 }, b: { x: 7, y: 7 } });
  // A leaf restores on its own too, and a branch whose top idea is gone comes back under its parent.
  assert.deepEqual(branchRestoration(now, then, 'a1', rules).changes.readded.map(node => node.id), ['a1', 'a11']);
});

test('links inside come from the version, boundary links survive when both ends exist, and outside links are untouched', () => {
  const then = mapOf([n('root', null), n('a', 'root'), n('a1', 'a'), n('a2', 'a'), n('b', 'root'), n('d', 'root')],
    [{ from: 'a1', to: 'b', type: 'depends_on' }, { from: 'a2', to: 'a1', type: 'contradicts' }, { from: 'a1', to: 'd', type: 'related_to' }]);
  const now = mapOf([n('root', null), n('a', 'root'), n('a1', 'a'), n('a2', 'a'), n('a3', 'a'), n('b', 'root'), n('c', 'root')],
    [{ from: 'a1', to: 'a2', type: 'depends_on' }, { from: 'b', to: 'a3', type: 'depends_on' }, { from: 'a2', to: 'c', type: 'supports' }, { from: 'b', to: 'c', type: 'related_to' }]);
  const plan = branchRestoration(now, then, 'a', rules);
  assert.deepEqual(linkKeys(plan.edges), ['a1 depends_on b', 'a2 contradicts a1', 'a2 supports c', 'b related_to c'],
    'from the version inside and across; today’s across; none to a removed idea (a3) or to one deleted since (d)');
  assert.deepEqual(plan.links.added.map(link => `${link.from} ${link.type} ${link.to}`).sort(), ['a1 depends_on b', 'a2 contradicts a1']);
  assert.deepEqual(plan.links.removed.map(link => `${link.from} ${link.type} ${link.to}`).sort(), ['a1 depends_on a2', 'b depends_on a3']);
});

test('restored findings are flagged when an ancestor or an outside prerequisite changed since the version', () => {
  const then = mapOf([explored('root', null), explored('a', 'root'), n('a1', 'a'), explored('b', 'root')], [{ from: 'a', to: 'b', type: 'depends_on' }]);
  const same = mapOf([explored('root', null), explored('a', 'root', { summary: 'Later.' }), n('a1', 'a'), explored('b', 'root')], [{ from: 'a', to: 'b', type: 'depends_on' }]);
  assert.deepEqual(branchRestoration(same, then, 'a', rules).flagInside, [], 'nothing it relied on changed');
  const ancestor = structuredClone(same); ancestor.nodes[0].contentRevision = 2;
  assert.deepEqual(branchRestoration(ancestor, then, 'a', rules).flagInside, ['a'], 'the root changed: only the restored idea with findings');
  const untouched = structuredClone(ancestor); untouched.nodes.push(explored('a2', 'a')); untouched.edges.push({ from: 'a', to: 'a2', type: 'contains' });
  const thenWith = structuredClone(then); thenWith.nodes.push(explored('a2', 'a')); thenWith.edges.push({ from: 'a', to: 'a2', type: 'contains' });
  assert.deepEqual(branchRestoration(untouched, thenWith, 'a', rules).flagInside, ['a'], 'an idea that comes back the same is not flagged');
  const deleted = structuredClone(same); deleted.nodes = deleted.nodes.filter(entry => entry.id !== 'b'); deleted.edges = deleted.edges.filter(edge => edge.from !== 'b' && edge.to !== 'b');
  assert.deepEqual(branchRestoration(deleted, then, 'a', rules).flagInside, ['a'], 'a prerequisite deleted since counts as changed');
  const prerequisite = structuredClone(same); prerequisite.nodes[3].contentRevision = 4;
  assert.deepEqual(branchRestoration(prerequisite, then, 'a', rules).flagInside, ['a']);
  // Outside ideas that depend on the branch go through the existing traversal.
  const dependent = mapOf([...structuredClone(same.nodes), explored('c', 'root'), n('c1', 'c')], [...same.edges.filter(edge => edge.type !== 'contains'), { from: 'c', to: 'a1', type: 'depends_on' }]);
  const plan = branchRestoration(dependent, then, 'a', rules);
  assert.deepEqual(plan.outsideAffected.sort(), ['c', 'c1']); assert.deepEqual(plan.flagOutside, ['c']);
  const asking = structuredClone(dependent); asking.nodes.find(entry => entry.id === 'c1').questions = [{ id: 'q9', text: 'Who decides?', answer: null }];
  assert.equal(branchRestoration(asking, then, 'a', rules).setAside, 1, 'the preview can say which questions are set aside');
});

test('the root, an idea missing from the version, a missing parent, a moved ID, active work and no change are refused', () => {
  const then = mapOf([n('root', null), n('x', 'root'), n('a', 'x'), n('a1', 'a')]);
  assert.throws(() => branchRestoration(then, then, 'root', rules), error => error.status === 400 && /whole version/.test(error.message));
  assert.throws(() => branchRestoration(then, then, 'nope', rules), error => error.status === 404);
  const codes = (now, nodeId = 'a') => branchRestoration(now, then, nodeId, rules).conflicts.map(conflict => conflict.code);
  assert.deepEqual(codes(mapOf([n('root', null)])), ['missing-parent']);
  assert.deepEqual(codes(mapOf([n('root', null), n('x', 'root'), n('a', 'x'), n('a1', 'root')])), ['moved']);
  const busy = mapOf([n('root', null), n('x', 'root'), n('a', 'x'), n('a1', 'a', { summary: 'Later.' })]);
  busy.jobs = [{ id: 'job-00000001', nodeId: 'a1', status: 'queued', type: 'investigate' }];
  assert.deepEqual(codes(busy), ['active-work']);
  assert.deepEqual(codes(structuredClone(then)), ['unchanged']);
});

test('jobs for the branch are replaced by the version’s; other jobs stay', () => {
  const job = (id, nodeId, status, extra = {}) => ({ id, nodeId, status, type: 'investigate', ...extra });
  const then = mapOf([n('root', null), explored('a', 'root'), n('a1', 'a'), n('b', 'root')]);
  then.jobs = [job('job-0000000a', 'a', 'completed', { result: { summary: 'Found a.', body: 'Findings a.' } }), job('job-0000000b', 'a1', 'queued')];
  const now = mapOf([n('root', null), explored('a', 'root', { summary: 'Later.' }), n('a1', 'a'), n('a3', 'a'), n('b', 'root')]);
  now.jobs = [job('job-0000000c', 'a', 'failed'), job('job-0000000d', 'a3', 'completed'), job('job-0000000e', 'b', 'running')];
  assert.deepEqual(ids(branchRestoration(now, then, 'a', rules).jobs), ['job-0000000a', 'job-0000000b', 'job-0000000e']);
});

// A map whose branch "Sync" has findings, an answer and two sub-ideas, saved as a version; then later work.
async function scenario() {
  const { dir, store } = await workspace();
  const act = async (map, input) => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  let map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  let job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Offline first.', body: 'Findings about offline use.' });
  map = await act(map, { type: 'suggest', nodeId: map.rootId, title: 'Sync', body: 'How notes sync.' });
  map = await act(map, { type: 'suggest', nodeId: map.rootId, title: 'Power', body: 'Battery life.' });
  const sync = map.nodes.find(node => node.title === 'Sync'), power = map.nodes.find(node => node.title === 'Power');
  map = await act(map, { type: 'activate', nodeId: sync.id });
  job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Merge by hand.', body: 'Keep both copies.', questions: ['Who edits?'] });
  map = await store.get(map.id);
  map = await act(map, { type: 'answer', nodeId: sync.id, questionId: map.nodes.find(node => node.id === sync.id).questions[0].id, answer: 'Two of us.' });
  // The answer continues the run; it finishes, so the branch is complete.
  job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Merge by hand; two editors.', body: 'Keep both copies.' });
  map = await store.get(map.id);
  map = await act(map, { type: 'suggest', nodeId: sync.id, title: 'Conflicts', body: 'When edits disagree.' });
  const [version] = (await store.versions.list(map.id)).versions;
  // Later: a new idea inside the branch, a revised premise inside it, and a change outside it.
  map = await act(map, { type: 'suggest', nodeId: sync.id, title: 'Late idea', body: 'Added after the version.' });
  const conflicts = map.nodes.find(node => node.title === 'Conflicts');
  map = await act(map, { type: 'revise', nodeId: conflicts.id, body: 'A revised premise.' });
  map = await act(map, { type: 'suggest', nodeId: power.id, title: 'Solar', body: 'Charging outside.' });
  return { dir, store, act, map, version, sync, power };
}

test('confirming restores the branch in one revision and one version, starts no research, and Undo reverses it', async () => {
  const { store, act, map, version, sync } = await scenario();
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: sync.id });
  assert.equal(preview.counts.removed, 1); assert.equal(preview.counts.changed, 1); assert.deepEqual(preview.conflicts, []);
  const versionsBefore = (await store.versions.list(map.id)).versions.length;
  const restored = await act(map, { type: 'restore-branch', nodeId: sync.id, version: version.id, previewHash: preview.hash });
  assert.equal(restored.revision, map.revision + 1);
  assert.ok(!restored.nodes.some(node => node.title === 'Late idea')); assert.equal(restored.nodes.find(node => node.title === 'Conflicts').prompt, 'When edits disagree.');
  assert.ok(restored.nodes.some(node => node.title === 'Solar'), 'outside the branch stays as it is now');
  assert.equal(restored.history.at(-1).type, 'branch-restored');
  assert.equal(restored.jobs.filter(job => job.status === 'queued').length, map.jobs.filter(job => job.status === 'queued').length, 'no research is queued');
  const { versions } = await store.versions.list(map.id);
  assert.equal(versions.length, versionsBefore + 1); assert.deepEqual(versions[0].labels, ['branch-restored']);
  // E1's Undo: restore the version saved just before.
  const undone = await act(restored, { type: 'restore-version', version: versions[1].id, undo: true });
  assert.deepEqual(undone.nodes.map(node => [node.id, node.prompt, node.summary]), map.nodes.map(node => [node.id, node.prompt, node.summary]));
});

test('a stale preview, the root and active work are refused without changing the file', async () => {
  const { store, act, map, version, sync, power } = await scenario();
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: sync.id });
  const file = store.file(map.id), bytes = await readFile(file);
  await assert.rejects(act(map, { type: 'restore-branch', nodeId: sync.id, version: version.id, previewHash: 'stale' }), error => error.status === 409 && /Preview the restore again/.test(error.message));
  await assert.rejects(act(map, { type: 'restore-branch', nodeId: map.rootId, version: version.id, previewHash: preview.hash }), error => error.status === 400);
  assert.deepEqual(await readFile(file), bytes, 'nothing written');
  // Work that starts after the preview changes the map, so the old revision is refused; active work blocks a fresh one.
  const busy = await act(map, { type: 'activate', nodeId: map.nodes.find(node => node.title === 'Late idea').id });
  await assert.rejects(store.action(map.id, { type: 'restore-branch', expectedRevision: map.revision, nodeId: sync.id, version: version.id, previewHash: preview.hash }), error => error.status === 409);
  const blocked = await previewBranchRestore(store, map.id, version.id, { nodeId: sync.id });
  assert.deepEqual(blocked.conflicts.map(conflict => conflict.code), ['active-work']);
  await assert.rejects(act(busy, { type: 'restore-branch', nodeId: sync.id, version: version.id, previewHash: blocked.hash }), error => error.status === 409 && /queued or running/.test(error.message));
  assert.ok(power);
});

test('work that was open in the version comes back interrupted, without a claim', async () => {
  const { store, act, map, power } = await scenario();
  // A version saved while Power is queued; then that run is claimed and finishes.
  await act(map, { type: 'activate', nodeId: power.id });
  const [version] = (await store.versions.list(map.id)).versions;
  const job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'A day of battery.', body: 'Findings.' });
  const done = await store.get(map.id);
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: power.id });
  const restored = await act(done, { type: 'restore-branch', nodeId: power.id, version: version.id, previewHash: preview.hash });
  const back = restored.jobs.find(entry => entry.id === job.jobId);
  assert.equal(back.status, 'interrupted'); assert.equal(back.claimKey, undefined);
  assert.equal(restored.nodes.find(node => node.id === power.id).status, 'interrupted');
  await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Late.' }), 'the old claim cannot deliver');
});

test('the server previews in pages, and the browser’s preview disables Confirm while conflicts exist', async () => {
  const { dir, store, map, version, sync } = await scenario();
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const get = query => fetch(`${app.address}/api/maps/${map.id}/versions/${version.id}/branch?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const first = await (await get(`node=${sync.id}&limit=1`)).json();
    assert.equal(first.nodes.length, 1); assert.equal(first.nextOffset, 1); assert.equal(first.counts.changed + first.counts.removed + first.counts.readded, 2);
    assert.equal((await (await get(`node=${sync.id}&offset=1&limit=1`)).json()).nodes.length, 1);
    assert.equal((await get(`node=${map.rootId}`)).status, 400);
    assert.equal(JSON.parse(await readFile(store.file(map.id), 'utf8')).revision, map.revision, 'a preview writes nothing');
    const html = branchRestoreHtml(first, { esc: String });
    assert.match(html, /data-branch-confirm(?![^>]*disabled)/); assert.match(html, /1 idea added since/);
    const blocked = branchRestoreHtml({ ...first, conflicts: [{ code: 'active-work', message: 'Wait for the work.', nodes: [] }] }, { esc: String });
    assert.match(blocked, /data-branch-confirm[^>]*disabled/); assert.match(blocked, /Wait for the work\./);
  } finally { await app.close(); }
});

test('the hash names the map it starts from, and a finished branch that comes back unfinished is listed', () => {
  const then = mapOf([n('root', null), n('a', 'root'), n('a1', 'a')]);
  const one = mapOf([n('root', null), explored('a', 'root'), n('a1', 'a', { summary: 'One edit.' })]), two = structuredClone(one);
  two.nodes[2].summary = 'Another edit.';
  assert.notEqual(branchRestoration(one, then, 'a', rules).hash, branchRestoration(two, then, 'a', rules).hash, 'same result, different starting point');
  assert.deepEqual(branchRestoration(one, then, 'a', rules).reopened, ['a']);
});

test('a branch that already matches the version is refused, even after its work was claimed', async () => {
  const { store, map, sync } = await scenario();
  const [latest] = (await store.versions.list(map.id)).versions;
  const preview = await previewBranchRestore(store, map.id, latest.id, { nodeId: sync.id });
  assert.deepEqual(preview.conflicts.map(conflict => conflict.code), ['unchanged']);
});

test('a restore keeps the event log and growth append-only, and Undo brings back everything it replaced', async () => {
  const { store, act, map, version, sync } = await scenario();
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: sync.id });
  const restored = await act(map, { type: 'restore-branch', nodeId: sync.id, version: version.id, previewHash: preview.hash });
  assert.deepEqual(restored.history.slice(0, map.history.length), map.history, 'nothing in the log is rewritten');
  assert.deepEqual(restored.growth, map.growth, 'growth is unchanged; brought-back ideas keep their entries');
  const [, before] = (await store.versions.list(map.id)).versions;
  const undone = await act(restored, { type: 'restore-version', version: before.id, undo: true });
  assert.equal(restorableHash(undone), restorableHash(map)); assert.deepEqual(undone.view.positions, map.view.positions);
});

test('the preview says how many more it leaves out of each list', () => {
  const idea = i => ({ id: `n${i}`, title: `Idea ${i}` });
  const preview = { node: idea(0), counts: { changed: 0, readded: 0, removed: 0, linksAdded: 0, linksRemoved: 0, reopened: 60, flaggedInside: 0, affected: 70, flagged: 3, questionsSetAside: 4 },
    nodes: [], nextOffset: null, reopened: Array.from({ length: 50 }, (_, i) => idea(i)), flaggedInside: [], affected: Array.from({ length: 50 }, (_, i) => idea(i)), conflicts: [] };
  const html = branchRestoreHtml(preview, { esc: String });
  assert.match(html, /and 10 more\./); assert.match(html, /and 20 more\. 3 findings will be flagged for review, and 4 open questions set aside/);
  assert.doesNotMatch(html, /role="alert"/); assert.match(html, /<section class="branch-restore" tabindex="-1" role="group"/);
});
