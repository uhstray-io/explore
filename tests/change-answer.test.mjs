import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';

// Root asks "Budget?" (answered), then a follow-up; a child branch depends on the root and has findings.
async function scenario() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'change-')), 'ideas'));
  let map = await store.create({ title: 'Workshop', idea: 'Plan a workshop.' });
  const act = async input => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, ...input }); };
  let job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Scoped.', body: 'First pass.', questions: ['Budget?'], suggestions: [{ title: 'Venue', body: 'Where?' }] });
  const budget = map.nodes[0].questions[0];
  await act({ type: 'answer', questionId: budget.id, answer: 'Forty pounds.' });
  job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Cheap plan.', body: 'Built on forty pounds.', questions: ['Which evening?'] });
  const venue = map.nodes[1];
  map = await act({ type: 'activate', nodeId: venue.id });
  job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Halls.', body: 'Venue findings.' });
  return { store, map: await store.get(map.id), act, budget, venue };
}

test('changing an answer keeps the old one, flags what relied on it, and continues from the new answer', async () => {
  const { store, act, budget, venue } = await scenario();
  const saved = await act({ type: 'change-answer', questionId: budget.id, answer: 'Two hundred pounds.' });
  const root = saved.nodes[0], q = root.questions.find(x => x.id === budget.id);
  assert.equal(q.answer, 'Two hundred pounds.'); assert.ok(q.changedAt);
  assert.equal(q.previousAnswers.length, 1); assert.equal(q.previousAnswers[0].answer, 'Forty pounds.'); assert.ok(q.previousAnswers[0].replacedAt);
  assert.equal(root.stale, true, 'the findings built on the old answer are flagged');
  assert.equal(saved.nodes.find(n => n.id === venue.id).stale, true, 'so are findings below it');
  assert.equal(saved.nodes.find(n => n.id === venue.id).questions.every(x => !x.supersededAt), true, 'their questions stay');
  const followUp = root.questions.find(x => x.text === 'Which evening?');
  assert.ok(followUp.supersededAt, 'the follow-up asked after the old answer is replaced');
  assert.equal(root.status, 'queued');
  assert.match(saved.jobs.at(-1).reason, /changed their answer to 'Budget\?'/);
});

test('Save without re-running only fixes the wording', async () => {
  const { act, budget, map } = await scenario();
  const saved = await act({ type: 'change-answer', questionId: budget.id, answer: 'Forty pounds, roughly.', rerun: false });
  const root = saved.nodes[0];
  assert.equal(root.questions[0].answer, 'Forty pounds, roughly.');
  assert.equal(root.questions[0].previousAnswers[0].wordingFix, true);
  assert.equal(root.contentRevision, map.nodes[0].contentRevision);
  assert.equal(root.stale, false); assert.equal(root.status, map.nodes[0].status);
  assert.ok(root.questions.every(q => !q.supersededAt));
});

test('a result from work running during the change is kept as stale', async () => {
  const { store, act, budget, venue, map } = await scenario();
  assert.ok(venue);
  await act({ type: 'suggest', nodeId: venue.id, title: 'Parking', body: 'Is there parking?' });
  const parking = (await store.get(map.id)).nodes.at(-1);
  await act({ type: 'activate', nodeId: parking.id });
  const job = await store.claim('test');
  await act({ type: 'change-answer', questionId: budget.id, answer: 'No budget.' });
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Built on the old budget.' });
  assert.equal(saved.jobs.find(j => j.id === job.jobId).stale, true);
  assert.notEqual(saved.nodes.find(n => n.id === parking.id).summary, 'Late.');
});

test('what cannot be changed is refused without changing the map', async () => {
  const { store, act, map, venue } = await scenario();
  const before = await readFile(store.file(map.id), 'utf8');
  const root = map.nodes[0], open = root.questions.find(q => q.text === 'Which evening?');
  await assert.rejects(act({ type: 'change-answer', questionId: open.id, answer: 'x' }), error => error.status === 409);
  await assert.rejects(act({ type: 'change-answer', questionId: root.questions[0].id, answer: 'Forty pounds.' }), /nothing changed/i);
  await assert.rejects(act({ type: 'change-answer', nodeId: venue.id, questionId: 'q-none', answer: 'x' }), error => error.status === 409 || error.status === 404);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('on a finished branch the change becomes a new branch beside the original, started straight away', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const fresh = new Store(path.join(await mkdtemp(path.join(root, 'change-done-')), 'ideas'));
  let map = await fresh.create({ title: 'Done', idea: 'A finished branch.' });
  let job = await fresh.claim('test');
  map = await fresh.complete(map.id, job.jobId, job.claimKey, { summary: 'Asked.', body: 'Q.', questions: ['Format?'] });
  const q = map.nodes[0].questions[0];
  map = await fresh.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: q.id, answer: 'Hands-on.' });
  job = await fresh.claim('test');
  map = await fresh.complete(map.id, job.jobId, job.claimKey, { summary: 'Finished.', body: 'Done.' });
  await assert.rejects(fresh.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'change-answer', questionId: q.id, answer: 'Talk.' }), /changed answer|beside the original/i);
  const saved = await fresh.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'fork-revision', questionId: q.id, answer: 'A discussion group.', start: true });
  const child = saved.nodes.at(-1);
  assert.deepEqual(child.revisesAnswer, { questionId: q.id, previousAnswer: 'Hands-on.', answer: 'A discussion group.' });
  assert.equal(child.title, 'Changed answer: Format?'); assert.match(child.prompt, /Hands-on\./); assert.match(child.prompt, /A discussion group\./);
  assert.equal(child.status, 'queued', 'the user’s choice is the go-ahead');
  assert.equal(saved.nodes[0].questions[0].answer, 'Hands-on.', 'the finished branch keeps its answer');
  const packet = await fresh.claim('test');
  assert.deepEqual(packet.selected.revisesAnswer, child.revisesAnswer);
});

test('fork-revision without start behaves as before', async () => {
  const root = path.resolve('.test-output');
  const fresh = new Store(path.join(await mkdtemp(path.join(root, 'change-fork-')), 'ideas'));
  let map = await fresh.create({ title: 'Done', idea: 'Finished.' });
  const job = await fresh.claim('test');
  map = await fresh.complete(map.id, job.jobId, job.claimKey, { summary: 'Finished.', body: 'Done.' });
  const saved = await fresh.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'fork-revision', body: 'A changed premise.' });
  assert.equal(saved.nodes.at(-1).status, 'suggested');
  const started = await fresh.action(map.id, { expectedRevision: saved.revision, nodeId: map.rootId, type: 'fork-revision', body: 'Another change.', start: true });
  assert.equal(started.nodes.at(-1).status, 'queued');
});

test('packets and reads show the latest earlier answer', async () => {
  const { store, act, budget, map } = await scenario();
  await act({ type: 'change-answer', questionId: budget.id, answer: 'Two hundred pounds.' });
  const packet = await store.claim('test');
  const q = packet.selected.questions.find(x => x.id === budget.id);
  assert.ok(q.changedAt); assert.equal(q.previousAnswer, 'Forty pounds.');
  const read = contextExcerpt(await store.get(map.id), map.rootId, { section: 'questions' });
  assert.match(read.excerpt, /Earlier answer \(.+\): Forty pounds\./);
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /Earlier answer/);
});
