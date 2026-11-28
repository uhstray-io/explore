import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, isCompleted, hasFindings } from '../skills/explore/scripts/store.mjs';
import { previewRestart } from '../skills/explore/scripts/restart.mjs';
import { growthTimeline } from '../skills/explore/assets/history.js';
import { reviewStepHtml, restartPreviewHtml } from '../skills/explore/assets/workspace-view.js';
import { startServer } from '../skills/explore/scripts/server.mjs';

// A finished "Venue" branch answered twice, with three ideas below it, an outside idea that depends
// on one of them, and an unrelated idea. Illustrative fixture under .test-output, never ideas/.
async function fixture(options, existing) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = existing ? null : await mkdtemp(path.join(root, 'restart-'));
  const store = existing || new Store(path.join(dir, 'ideas'), options);
  let map = await store.create({ title: 'Community workshop', idea: 'Plan a hands-on community workshop.' });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  const run = async result => { const job = await store.claim('fixture', map.id); return store.complete(map.id, job.jobId, job.claimKey, result); };
  const find = title => map.nodes.find(n => n.title === title);
  map = await run({ summary: 'Three things to settle.', body: 'Fixture.', suggestions: [{ title: 'Venue', body: 'Where should it happen?' }, { title: 'Budget', body: 'What can we spend?' }, { title: 'Timing', body: 'When?' }] });
  map = await act({ type: 'activate', nodeId: find('Venue').id });
  map = await run({ summary: 'Depends on the setting.', body: 'Fixture.', questions: ['Indoors or outdoors?'] });
  const first = find('Venue').questions[0];
  map = await act({ type: 'answer', nodeId: find('Venue').id, questionId: first.id, answer: 'Outdoors.' });
  map = await run({ summary: 'Outdoors needs a fallback.', body: 'Fixture.', questions: ['Is a rain plan needed?'] });
  const second = find('Venue').questions[1];
  map = await act({ type: 'answer', nodeId: find('Venue').id, questionId: second.id, answer: 'Yes, a tent.' });
  map = await run({ summary: 'The green with a tent.', body: 'Use the village green.', sources: [{ title: 'Green rules', url: 'https://example.org/green', note: 'Fixture.' }], suggestions: [{ title: 'Green', body: 'Book the green.' }, { title: 'Hall', body: 'A backup hall.' }] });
  map = await act({ type: 'activate', nodeId: find('Green').id });
  map = await run({ summary: 'The green is free.', body: 'Fixture.', suggestions: [{ title: 'Permit', body: 'Apply for a permit.' }] });
  map = await act({ type: 'activate', nodeId: find('Budget').id });
  map = await run({ summary: 'Small budget.', body: 'Fixture.', links: [{ type: 'depends_on', to: find('Green').id }] });
  map = await act({ type: 'activate', nodeId: find('Timing').id });
  map = await run({ summary: 'Summer.', body: 'Fixture.' });
  map = await act({ type: 'position', nodeId: find('Green').id, x: 120, y: 40 });
  return { dir, store, map, act, run, find: title => map.nodes.find(n => n.title === title), refresh: async () => (map = await store.get(map.id)), firstId: first.id, secondId: second.id };
}
const below = ['Green', 'Hall', 'Permit'];

test('the restart preview lists what would change and writes nothing', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const before = await readFile(f.store.file(f.map.id), 'utf8'), versions = (await f.store.versions.list(f.map.id)).versions.length;
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  assert.equal(preview.revision, f.map.revision);
  assert.equal(preview.oldAnswer, 'Outdoors.');
  assert.deepEqual(preview.deleted.map(n => n.title).sort(), below);
  assert.equal(preview.deleteCount, 3); assert.equal(preview.nextOffset, null);
  assert.deepEqual(preview.superseded.map(q => q.text), ['Is a rain plan needed?']);
  assert.deepEqual(preview.flagged.map(n => n.title), ['Budget']);
  assert.equal(preview.linksRemoved, 4, 'three containment links and the outside dependency');
  assert.match(preview.checkpointName, /^Before restarting Venue, \d{4}-\d\d-\d\d$/);
  assert.match(preview.hash, /^[a-f0-9]{64}$/);
  const page = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId, offset: 1, limit: 1 });
  assert.equal(page.deleted.length, 1); assert.equal(page.nextOffset, 2); assert.equal(page.hash, preview.hash);
  assert.equal(await readFile(f.store.file(f.map.id), 'utf8'), before);
  assert.equal((await f.store.versions.list(f.map.id)).versions.length, versions);
});

test('restarting deletes exactly the ideas below, with their work, positions and links', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const deletedIds = below.map(title => f.find(title).id);
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  assert.deepEqual(map.nodes.map(n => n.title).sort(), ['Budget', 'Community workshop', 'Timing', 'Venue']);
  assert.ok(!map.jobs.some(j => deletedIds.includes(j.nodeId)));
  assert.ok(!map.edges.some(e => deletedIds.includes(e.from) || deletedIds.includes(e.to)));
  assert.ok(!Object.keys(map.view.positions).some(id => deletedIds.includes(id)));
  const nodeFiles = await readdir(path.join(f.store.directory, map.id, 'nodes'));
  assert.ok(!deletedIds.some(id => nodeFiles.includes(`${id}.md`)), 'generated views of deleted ideas are removed');
  const event = map.history.find(item => item.type === 'branch-restarted');
  assert.ok(event);
  // The restart's own version is labelled by it first, not by the exploration it queues.
  assert.deepEqual((await f.store.versions.list(map.id)).versions[0].labels, ['branch-restarted', 'activated']); assert.equal(event.nodeId, venue.id); assert.match(event.detail, /3 ideas/);
});

test('the restarted idea keeps its premise and earlier answers, takes the new answer and is queued once', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const node = map.nodes.find(n => n.id === venue.id);
  assert.equal(node.prompt, 'Where should it happen?');
  assert.equal(node.body, node.prompt); assert.equal(node.summary, node.prompt); assert.deepEqual(node.sources, []);
  const [first, second] = node.questions;
  assert.equal(first.answer, 'Indoors.'); assert.equal(first.previousAnswers.at(-1).answer, 'Outdoors.'); assert.ok(first.previousAnswers.at(-1).restart);
  assert.ok(second.supersededAt); assert.equal(second.answer, 'Yes, a tent.', 'earlier answers are kept');
  assert.equal(node.completedAt, undefined); assert.equal(node.reviewState, 'unreviewed'); assert.equal(node.stale, false);
  assert.equal(isCompleted(map, node), false); assert.equal(hasFindings(map, node), false);
  assert.equal(node.status, 'queued');
  const open = map.jobs.filter(j => j.nodeId === node.id && ['queued', 'running'].includes(j.status));
  assert.equal(open.length, 1); assert.match(open[0].reason, /restarted this branch from a changed answer/);
  assert.ok(map.jobs.filter(j => j.nodeId === node.id && j.status === 'completed').every(j => j.restartedAt));
  const markdown = await readFile(path.join(f.store.directory, map.id, 'nodes', `${node.id}.md`), 'utf8');
  assert.match(markdown, /## Earlier result before this branch was restarted/);
  assert.match(markdown, /## Current premise \(not researched findings\)/);
  // The agent picks it up as an ordinary investigation with the new answer.
  const packet = await f.store.claim('agent', map.id);
  assert.equal(packet.selected.id, node.id);
  assert.equal(packet.selected.questions.find(q => q.id === f.firstId).answer, 'Indoors.');
});

test('outside ideas that relied on the branch are flagged; unrelated ones are unchanged', async () => {
  const f = await fixture(), venue = f.find('Venue'), timing = f.find('Timing'), root = f.find('Community workshop');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const budget = map.nodes.find(n => n.title === 'Budget');
  assert.equal(budget.stale, true);
  assert.deepEqual(budget.reviewCauses.map(c => [c.kind, c.sourceId]), [['branch-restarted', venue.id]]);
  for (const [was, now] of [[timing, map.nodes.find(n => n.id === timing.id)], [root, map.nodes.find(n => n.id === root.id)]]) {
    assert.equal(now.stale, false); assert.equal(now.contentRevision, was.contentRevision);
  }
});

test('a named checkpoint is saved first, and restoring it brings every deleted idea back', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const before = f.map.nodes.map(n => n.id).sort();
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  let map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const { versions } = await f.store.versions.list(map.id);
  const checkpoint = versions.find(v => v.name === preview.checkpointName);
  assert.ok(checkpoint, 'the checkpoint is a named version'); assert.ok(checkpoint.checkpoint);
  const saved = await f.store.versions.get(map.id, checkpoint.id);
  assert.deepEqual(saved.map.nodes.map(n => n.id).sort(), before);
  assert.match(map.history.find(item => item.type === 'branch-restarted').detail, new RegExp(checkpoint.id));
  // Growth history no longer shows them; version history still has them.
  assert.ok(!growthTimeline(map).steps.at(-1).nodeIds.some(id => !map.nodes.some(n => n.id === id)));
  // Right away: the restarted branch is only queued, and restoring cancels that.
  map = await f.act({ type: 'restore-version', version: checkpoint.id });
  assert.deepEqual(map.nodes.map(n => n.id).sort(), before);
  assert.equal(map.nodes.find(n => n.id === venue.id).questions[0].answer, 'Outdoors.');
});

test('restart checkpoints do not count against the named-version limit', async () => {
  const f = await fixture({ versionLimits: { names: 1 } }), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const other = (await f.store.versions.list(map.id)).versions.find(v => !v.name);
  await f.act({ type: 'name-version', version: other.id, name: 'My one name' });
  assert.equal((await f.store.versions.list(map.id)).versions.filter(v => v.name).length, 2);
});

test('a second restart on the same day gets its own checkpoint name', async () => {
  const f = await fixture(), venue = f.find('Venue');
  let preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  let map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const job = await f.store.claim('agent', map.id);
  map = await f.store.complete(map.id, job.jobId, job.claimKey, { summary: 'The hall.', body: 'Fixture.' });
  preview = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  assert.match(preview.checkpointName, / \(2\)$/);
  const [newest] = (await f.store.versions.list(map.id)).versions;
  await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Either.', previewHash: preview.hash });
  const versions = (await f.store.versions.list(map.id)).versions;
  assert.equal(versions.filter(v => v.checkpoint).length, 2);
  assert.equal(versions.find(v => v.name === preview.checkpointName).id, newest.id, 'the matching newest version is named, not copied');
});

test('active work, an unchanged answer, an unfinished idea or a changed map are refused without changes', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const restart = extra => f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash, ...extra });
  const unchanged = async attempt => { const before = await readFile(f.store.file(f.map.id), 'utf8'); await attempt(); assert.equal(await readFile(f.store.file(f.map.id), 'utf8'), before); };
  await unchanged(() => assert.rejects(restart({ answer: 'Outdoors.' }), error => error.status === 400 && /Nothing changed/.test(error.message)));
  await unchanged(() => assert.rejects(restart({ previewHash: 'x'.repeat(64) }), error => error.status === 409 && /changed since the preview/.test(error.message)));
  await unchanged(() => assert.rejects(f.act({ type: 'restart-branch', nodeId: f.find('Green').id, questionId: f.firstId, answer: 'x', previewHash: preview.hash }), error => error.status === 409));
  // Work queued anywhere in the branch blocks both the preview and the restart.
  await f.act({ type: 'activate', nodeId: f.find('Permit').id });
  await assert.rejects(previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId }), error => error.status === 409 && /queued or running/.test(error.message));
  await unchanged(() => assert.rejects(restart(), error => error.status === 409 && /queued or running/.test(error.message)));
  // An unfinished idea changes its answer in place instead.
  await f.refresh();
  await unchanged(() => assert.rejects(f.act({ type: 'restart-branch', nodeId: f.find('Permit').id, questionId: f.firstId, answer: 'x', previewHash: preview.hash }), error => error.status === 409 && /finished/.test(error.message)));
});

test('a later change to the branch makes the old preview stale', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  await f.act({ type: 'suggest', nodeId: f.find('Green').id, title: 'Parking', body: 'Where do people park?' });
  const before = await readFile(f.store.file(f.map.id), 'utf8');
  await assert.rejects(f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash }), error => error.status === 409 && /changed since the preview/.test(error.message));
  assert.equal(await readFile(f.store.file(f.map.id), 'utf8'), before);
});

test('a checkpoint that cannot be saved leaves the map unchanged', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  f.store.versions.record = async () => { throw new Error('disk full'); };
  const before = await readFile(f.store.file(f.map.id), 'utf8');
  await assert.rejects(f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash }), error => error.status === 500 && /checkpoint/.test(error.message));
  assert.equal(await readFile(f.store.file(f.map.id), 'utf8'), before);
});

test('recovery tolerates running work whose idea no longer exists', async () => {
  const f = await fixture();
  const file = f.store.file(f.map.id), raw = JSON.parse(await readFile(file, 'utf8'));
  raw.jobs.push({ id: 'job-gone0001', nodeId: 'node-gone0001', status: 'running', reason: 'Fixture.', createdAt: raw.updatedAt, startedAt: raw.updatedAt });
  await writeFile(file, JSON.stringify(raw, null, 2));
  const fresh = new Store(f.store.directory);
  await fresh.recover();
  const map = await fresh.get(f.map.id);
  assert.equal(map.jobs.find(j => j.id === 'job-gone0001').status, 'interrupted');
});

test('a flag from a restart says so and shows the answer before and after', async () => {
  const f = await fixture(), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const html = reviewStepHtml({ map, nodeId: map.nodes.find(n => n.title === 'Budget').id, index: 0, total: 1, esc: String });
  assert.match(html, /Venue<\/button> was restarted from a changed answer/);
  assert.match(html, /<strong>Before:<\/strong> Outdoors\./); assert.match(html, /<strong>Now:<\/strong> Indoors\./);
});

test('the restart preview names what is deleted, flagged and kept, and how to confirm', () => {
  const preview = { deleteCount: 3, deleted: [{ id: 'node-a', title: 'Green' }, { id: 'node-b', title: '<Hall>' }], nextOffset: 2, superseded: [{ id: 'q-2', text: 'Rain plan?' }],
    flagged: [{ id: 'node-c', title: 'Budget' }], linksRemoved: 4, checkpointName: 'Before restarting Venue, 2026-11-27' };
  const esc = value => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = restartPreviewHtml(preview, { esc });
  assert.match(html, /^<div class="state-note warning restart-preview"/);
  assert.match(html, /Ideas to delete \(3\)/); assert.match(html, /&lt;Hall&gt;/); assert.match(html, /data-restart-more="2"/);
  assert.match(html, /1 later question on this branch is set aside/);
  assert.match(html, /Budget/); assert.match(html, /Before restarting Venue, 2026-11-27/);
  assert.match(html, /data-restart-confirm[^>]*>Delete 3 ideas and restart</); assert.match(html, /data-restart-cancel[^>]*>Cancel</);
  const none = restartPreviewHtml({ ...preview, deleteCount: 0, deleted: [], nextOffset: null, superseded: [], flagged: [], linksRemoved: 0 }, { esc });
  assert.match(none, /data-restart-confirm[^>]*>Restart this branch</);
  assert.doesNotMatch(none, /Ideas to delete|data-restart-more|set aside|flagged/i);
});

test('the browser previews a restart without writing, then confirms it', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'restart-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const f = await fixture(undefined, app.store), venue = f.find('Venue');
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const request = async (route, body) => {
      const res = await fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, data: await res.json() };
    };
    const before = await readFile(app.store.file(f.map.id), 'utf8');
    const { status, data: preview } = await request(`/maps/${f.map.id}/restart-preview?node=${venue.id}&question=${f.firstId}&limit=2`);
    assert.equal(status, 200); assert.equal(preview.deleted.length, 2); assert.equal(preview.nextOffset, 2);
    assert.equal(await readFile(app.store.file(f.map.id), 'utf8'), before);
    assert.equal((await request(`/maps/${f.map.id}/restart-preview?node=${venue.id}&question=q-missing`)).status, 409);
    const { status: saved, data: map } = await request(`/maps/${f.map.id}/action`, { type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash, expectedRevision: preview.revision });
    assert.equal(saved, 200); assert.equal(map.nodes.length, 4);
    assert.equal(map.nodes.find(n => n.id === venue.id).completed, false);
  } finally { await app.close(); }
});

test('the checkpoint always carries its own name, even when the map matches a version the user named', async () => {
  const f = await fixture(), venue = f.find('Venue');
  await f.act({ type: 'suggest', nodeId: f.find('Timing').id, title: 'Season', body: 'Which season?' });
  const [newest] = (await f.store.versions.list(f.map.id)).versions;
  await f.act({ type: 'name-version', version: newest.id, name: 'Plan A' });
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  await f.act({ type: 'unname-version', version: newest.id });
  const checkpoint = (await f.store.versions.list(map.id)).versions.find(v => v.name === preview.checkpointName);
  assert.ok(checkpoint?.checkpoint, 'the promised checkpoint exists under its own name');
  assert.ok((await f.store.versions.get(map.id, checkpoint.id)).map.nodes.some(n => n.title === 'Green'));
});

test('renaming a checkpoint makes it one of the user\'s names, within the limit', async () => {
  const f = await fixture({ versionLimits: { names: 1 } }), venue = f.find('Venue');
  const preview = await previewRestart(f.store, f.map.id, { nodeId: venue.id, questionId: f.firstId });
  const map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  const versions = (await f.store.versions.list(map.id)).versions, checkpoint = versions.find(v => v.checkpoint);
  await f.act({ type: 'name-version', version: checkpoint.id, name: 'Mine now' });
  assert.equal((await f.store.versions.list(map.id)).versions.find(v => v.id === checkpoint.id).checkpoint, undefined);
  const other = versions.find(v => !v.name);
  await assert.rejects(f.act({ type: 'name-version', version: other.id, name: 'One too many' }), error => error.status === 409 && /at most 1/.test(error.message));
});

test('work elsewhere that links to a deleted idea still delivers; unknown ideas are still refused', async () => {
  const f = await fixture(), venue = f.find('Venue'), green = f.find('Green');
  let map = await f.act({ type: 'suggest', nodeId: f.find('Community workshop').id, title: 'Catering', body: 'Who feeds people?' });
  map = await f.act({ type: 'activate', nodeId: map.nodes.find(n => n.title === 'Catering').id });
  const job = await f.store.claim('agent', map.id);
  const preview = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  await assert.rejects(f.store.complete(map.id, job.jobId, job.claimKey, { summary: 'Local cafe.', body: 'Fixture.', links: [{ type: 'depends_on', to: 'node-neverwas' }] }), error => error.status === 400 && /Invalid relationship/.test(error.message));
  map = await f.store.complete(map.id, job.jobId, job.claimKey, { summary: 'Local cafe.', body: 'Fixture.', links: [{ type: 'depends_on', to: green.id }] });
  assert.equal(map.nodes.find(n => n.title === 'Catering').summary, 'Local cafe.');
  assert.ok(!map.edges.some(e => e.to === green.id));
});

test('restarting drops the requests to look at the ideas it deletes, says so first, and keeps the others (H7)', async () => {
  const f = await fixture(), venue = f.find('Venue'), actor = { actor: { name: 'Ben' } };
  const ask = async (title, to) => { const map = await f.refresh(); return f.store.action(map.id, { expectedRevision: map.revision, nodeId: f.find(title).id, type: 'assign', to }, actor); };
  await ask('Green', 'Ana'); await ask('Budget', 'Cy');
  let map = await ask('Permit', 'Dee');
  const permit = map.assignments.items.find(item => item.requestedFor === 'Dee');
  map = await f.store.action(map.id, { expectedRevision: map.revision, nodeId: permit.nodeId, type: 'complete-assignment', assignmentId: permit.id }, actor);
  const earlier = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  assert.equal(earlier.requestsRemoved, 1, 'the open one; a done one goes too, but is not waiting on anyone');
  assert.match(restartPreviewHtml(earlier, { esc: String }), /Restarting deletes 3 ideas below this branch, with 4 links and 1 open request to look at them\./);
  await ask('Hall', 'Eve');
  await assert.rejects(f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: earlier.hash }), /Preview the restart again/, 'a request asked for since the preview changes what it deletes');
  const preview = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  assert.equal(preview.requestsRemoved, 2);
  map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  assert.deepEqual(map.assignments.items.map(item => item.requestedFor), ['Cy'], 'only the request on an idea that is still there');
});

test('restarting drops the discussions on the ideas it deletes, counts the open ones first, and keeps the others (H6)', async () => {
  const f = await fixture(), venue = f.find('Venue'), actor = { actor: { name: 'Ben' } };
  const say = async (title, text, threadId) => { const map = await f.refresh(); return f.store.action(map.id, { expectedRevision: map.revision, nodeId: f.find(title).id, type: 'comment', text, ...(threadId ? { threadId } : {}) }, actor); };
  await say('Permit', 'Who signs it?'); await say('Budget', 'Kept.');
  let map = await say('Green', 'Settled.');
  const settled = map.discussions.threads.at(-1);
  map = await f.store.action(map.id, { expectedRevision: map.revision, nodeId: settled.nodeId, type: 'resolve-discussion', threadId: settled.id }, actor);
  const earlier = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  assert.equal(earlier.discussionsRemoved, 1, 'the open one; the resolved one goes too');
  assert.match(restartPreviewHtml(earlier, { esc: String }), /with 4 links and 1 open discussion./);
  await say('Permit', 'A reply since.', map.discussions.threads[0].id);
  await assert.rejects(f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: earlier.hash }), /Preview the restart again/, 'a reply since the preview changes what it deletes');
  const preview = await previewRestart(f.store, map.id, { nodeId: venue.id, questionId: f.firstId });
  map = await f.act({ type: 'restart-branch', nodeId: venue.id, questionId: f.firstId, answer: 'Indoors.', previewHash: preview.hash });
  assert.deepEqual(map.discussions.threads.map(thread => thread.messages[0].text), ['Kept.']);
});
