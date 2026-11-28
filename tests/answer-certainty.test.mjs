import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { isOpen, isBlocking, effectiveAnswerState } from '../skills/explore/assets/questions.js';

async function asked(questions = ['Who decides?', 'When?']) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'certainty-')), 'ideas'));
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions });
  return { store, map: await store.get(map.id) };
}
async function act(store, mapId, input) {
  const map = await store.get(mapId);
  return store.action(mapId, { expectedRevision: map.revision, ...input });
}

test('the shared helpers say which questions are open, which block, and how sure an answer is', () => {
  assert.equal(isOpen({ answer: null }), true);
  assert.equal(isOpen({ answer: 'Yes' }), false);
  assert.equal(isOpen({ answer: null, supersededAt: 't' }), false);
  assert.equal(isOpen({ answer: null, dismissedAt: 't' }), false);
  assert.equal(isBlocking({ answer: null }), true);
  assert.equal(isBlocking({ answer: null, deferredAt: 't' }), false, 'a question saved for later stays open but does not block');
  assert.equal(isOpen({ answer: null, deferredAt: 't' }), true);
  assert.deepEqual(effectiveAnswerState({ answer: 'Yes', answerState: 'decided' }), { state: 'decided', recorded: true });
  assert.deepEqual(effectiveAnswerState({ answer: 'Yes' }), { state: 'tentative', recorded: false });
  assert.equal(effectiveAnswerState({ answer: null }), null);
});

test('an answer is Tentative unless the user chooses Decided or Assumption, and always needs text', async () => {
  const { store, map } = await asked(['One?', 'Two?', 'Three?']);
  const [one, two, three] = map.nodes[0].questions;
  let saved = await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: one.id, answer: 'Probably the owner.' });
  assert.equal(saved.nodes[0].questions[0].answerState, 'tentative');
  saved = await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: two.id, answer: 'The owner.', answerState: 'decided' });
  assert.equal(saved.nodes[0].questions[1].answerState, 'decided');
  await assert.rejects(act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: three.id, answer: 'x', answerState: 'maybe' }), /Tentative, Decided or Assumption/);
  await assert.rejects(act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: three.id, answer: '   ', answerState: 'assumption' }), /Answer is required/);
  assert.equal((await store.get(map.id)).nodes[0].questions[2].answer, null);
});

test('changing how sure an answer is never re-runs research, flags findings or changes content', async () => {
  const { store, map } = await asked(['Only?']);
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Yes.' });
  const job = await store.claim('test');
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Finished.' });
  assert.equal(saved.nodes[0].status, 'explored');
  const contentRevision = saved.nodes[0].contentRevision, jobs = saved.jobs.length;
  saved = await act(store, map.id, { type: 'set-answer-state', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answerState: 'decided' });
  assert.equal(saved.nodes[0].questions[0].answerState, 'decided');
  assert.equal(saved.nodes[0].contentRevision, contentRevision);
  assert.equal(saved.jobs.length, jobs); assert.equal(saved.nodes[0].stale, false); assert.equal(saved.nodes[0].status, 'explored');
  await assert.rejects(act(store, map.id, { type: 'set-answer-state', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answerState: 'sure' }), error => error.status === 400);
});

test('Answer later lets the branch continue; the question stays answerable and is saved for later', async () => {
  const { store, map } = await asked(['First?', 'Second?']);
  const [first, second] = map.nodes[0].questions;
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: first.id, answer: 'Yes.' });
  let saved = await act(store, map.id, { type: 'answer-later', nodeId: map.rootId, questionId: second.id });
  assert.ok(saved.nodes[0].questions[1].deferredAt);
  assert.equal(saved.nodes[0].status, 'queued', 'nothing blocks the branch any more');
  const packet = await store.claim('test');
  assert.equal(packet.selected.questions.find(q => q.id === second.id).deferred, true);
  assert.match(packet.reason, /set the remaining questions aside|Continue/);
  await store.fail(map.id, packet.jobId, packet.claimKey, 'Stopped for the test.');
  saved = await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: second.id, answer: 'Later answer.', answerState: 'assumption' });
  assert.equal(saved.nodes[0].questions[1].deferredAt, undefined, 'answering clears it');
});

test('a question saved for later never blocks starting the branch again', async () => {
  const { store, map } = await asked(['Only?']);
  await act(store, map.id, { type: 'answer-later', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id });
  const job = await store.claim('test');
  await store.fail(map.id, job.jobId, job.claimKey, 'Stopped for the test.');
  const saved = await act(store, map.id, { type: 'activate', nodeId: map.rootId });
  assert.equal(saved.nodes[0].status, 'queued');
});

test('older answers stay as they were and read as Tentative, not recorded', async () => {
  const { store, map } = await asked(['Old?']);
  const legacy = await store.get(map.id);
  legacy.nodes[0].questions[0].answer = 'An answer from before certainty existed.';
  await writeFile(store.file(map.id), JSON.stringify(legacy, null, 2) + '\n');
  const before = await readFile(store.file(map.id), 'utf8');
  const read = await new Store(store.directory).get(map.id);
  assert.equal(read.nodes[0].questions[0].answerState, undefined, 'never written on load');
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
  const brief = mapBrief(read);
  assert.match(brief.markdown, /Tentative \(not recorded\)/);
});

test('packets, section reads, briefs and node Markdown all say how sure each answer is', async () => {
  const { store, map } = await asked(['Decided one?', 'Assumed one?', 'Later one?']);
  const [a, b, c] = map.nodes[0].questions;
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: a.id, answer: 'Firm.', answerState: 'decided' });
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: b.id, answer: 'A guess.', answerState: 'assumption' });
  const saved = await act(store, map.id, { type: 'answer-later', nodeId: map.rootId, questionId: c.id });
  const packet = await store.claim('test');
  assert.deepEqual(packet.selected.questions.map(q => q.answerState ?? null), ['decided', 'assumption', null]);
  const read = contextExcerpt(saved, map.rootId, { section: 'questions' });
  assert.match(read.excerpt, /Certainty: Decided/); assert.match(read.excerpt, /Certainty: Assumption/); assert.match(read.excerpt, /Saved for later/);
  const brief = mapBrief(await store.get(map.id));
  const assumed = brief.sections.find(s => s.id === 'assumptions');
  assert.deepEqual(assumed.items.map(item => item.questionId), [b.id], 'assumptions are not read as decisions');
  assert.deepEqual(brief.sections.find(s => s.id === 'later').items.map(item => item.questionId), [c.id]);
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /Certainty: Decided/); assert.match(doc, /Saved for later/);
});
