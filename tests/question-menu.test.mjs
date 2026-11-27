import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';

async function asked(questions = ['Budget?', 'Audience?']) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'qmenu-')), 'ideas'));
  const map = await store.create({ title: 'Workshop', idea: 'Plan a workshop.' });
  const job = await store.claim('test');
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Scoped.', body: 'Questions.', questions });
  const act = async (input, actor) => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, ...input }, actor ? { actor } : {}); };
  return { store, map: saved, act, job };
}

test('new questions record when and by which job they were asked', async () => {
  const { map, job } = await asked();
  assert.ok(map.nodes[0].questions.every(q => q.askedAt && q.jobId === job.jobId));
});

test('rating is feedback, not content: it never re-runs research and can be cleared', async () => {
  const { act, map } = await asked(['Only?']);
  const q = map.nodes[0].questions[0];
  let saved = await act({ type: 'rate-question', questionId: q.id, rating: 'bad', reason: 'Too vague.' }, { name: 'Ana' });
  assert.deepEqual([saved.nodes[0].questions[0].rating, saved.nodes[0].questions[0].ratingReason, saved.nodes[0].questions[0].ratedBy], ['bad', 'Too vague.', { name: 'Ana' }]);
  assert.equal(saved.nodes[0].contentRevision, map.nodes[0].contentRevision);
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  saved = await act({ type: 'rate-question', questionId: q.id, rating: null });
  assert.equal(saved.nodes[0].questions[0].rating, undefined);
  await assert.rejects(act({ type: 'rate-question', questionId: q.id, rating: 'meh' }), error => error.status === 400);
});

test('dismissing the last blocking question continues the branch; dismissing one of several waits', async () => {
  const { act, map } = await asked();
  const [a, b] = map.nodes[0].questions;
  let saved = await act({ type: 'dismiss-question', questionId: a.id });
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  await assert.rejects(act({ type: 'answer', questionId: a.id, answer: 'Late.' }), error => error.status === 409);
  assert.equal(mapBrief(saved).sections.find(s => s.id === 'questions').items.length, 1, 'dismissed questions are not waiting');
  saved = await act({ type: 'restore-question', questionId: a.id });
  assert.equal(saved.nodes[0].questions[0].dismissedAt, undefined);
  saved = await act({ type: 'dismiss-question', questionId: a.id });
  saved = await act({ type: 'dismiss-question', questionId: b.id });
  assert.equal(saved.nodes[0].status, 'queued');
  assert.match(saved.jobs.at(-1).reason, /dismissed the remaining questions/);
  await assert.rejects(act({ type: 'restore-question', questionId: a.id }), error => error.status === 409, 'not while the branch is queued');
});

test('regenerate waits for one replacement question, linked to the original', async () => {
  const { store, act, map } = await asked(['Vague question?']);
  const original = map.nodes[0].questions[0];
  let saved = await act({ type: 'regenerate-question', questionId: original.id, reason: 'Ask about money specifically.' });
  assert.equal(saved.nodes[0].status, 'awaiting-answer', 'the branch waits for the replacement');
  assert.equal(saved.nodes[0].questions[0].replacedBy, 'pending');
  assert.equal(saved.nodes[0].questions[0].rating, 'bad');
  const packet = await store.claim('test');
  assert.equal(packet.jobType, 'regenerate-question'); assert.match(packet.reason ?? '', /./);
  assert.equal(packet.question.text, 'Vague question?'); assert.equal(packet.userReason, 'Ask about money specifically.');
  assert.ok(JSON.stringify(packet).length < 6500);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { question: { text: 'What is the most you can spend on materials?' } });
  const [old, fresh] = saved.nodes[0].questions;
  assert.equal(fresh.text, 'What is the most you can spend on materials?');
  assert.equal(fresh.replaces, old.id); assert.equal(old.replacedBy, fresh.id); assert.equal(fresh.jobId, packet.jobId);
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  assert.equal(await store.claim('test'), null, 'nothing else was queued');
});

test('a failed or stopped regeneration brings the original question back', async () => {
  const { store, act, map } = await asked(['Vague?']);
  const q = map.nodes[0].questions[0];
  await act({ type: 'regenerate-question', questionId: q.id });
  let packet = await store.claim('test');
  let saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'No better question.');
  assert.equal(saved.nodes[0].questions[0].dismissedAt, undefined); assert.equal(saved.nodes[0].questions[0].replacedBy, undefined);
  saved = await act({ type: 'regenerate-question', questionId: q.id });
  saved = await act({ type: 'cancel-job', jobId: saved.jobs.at(-1).id, nodeId: undefined });
  assert.equal(saved.nodes[0].questions[0].replacedBy, undefined, 'stopping it restores the original too');
});

test('a replacement for a question that is no longer waiting is kept as stale and not added', async () => {
  const { store, act, map } = await asked(['Vague?', 'Other?']);
  const [q, other] = map.nodes[0].questions;
  await act({ type: 'regenerate-question', questionId: q.id });
  const packet = await store.claim('test');
  await act({ type: 'revise', body: 'A new premise.' });
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { question: { text: 'Too late.' } });
  assert.equal(saved.jobs.find(j => j.id === packet.jobId).stale, true);
  assert.equal(saved.nodes[0].questions.some(x => x.text === 'Too late.'), false);
  assert.ok(other);
});

test('the next investigation hears the user’s feedback and never re-asks a dismissed question', async () => {
  const { store, act, map } = await asked(['Good one?', 'Bad one?', 'Dismissed one?']);
  const [good, bad, dismissed] = map.nodes[0].questions;
  await act({ type: 'rate-question', questionId: good.id, rating: 'good' });
  await act({ type: 'rate-question', questionId: bad.id, rating: 'bad', reason: 'Leading.' });
  await act({ type: 'answer', questionId: good.id, answer: 'Yes.' });
  await act({ type: 'answer', questionId: bad.id, answer: 'No.' });
  await act({ type: 'dismiss-question', questionId: dismissed.id });
  const packet = await store.claim('test');
  assert.deepEqual(packet.selected.dismissedQuestions, ['Dismissed one?']);
  const feedback = packet.questionFeedback;
  assert.ok(feedback.some(f => f.text === 'Bad one?' && f.rating === 'bad' && f.reason === 'Leading.'));
  assert.ok(feedback.some(f => f.text === 'Good one?' && f.rating === 'good'));
  assert.match(packet.instruction, /rated bad or dismissed/);
  assert.ok(JSON.stringify(packet).length <= 15500);
  const read = contextExcerpt(await store.get(map.id), map.rootId, { section: 'questions' });
  assert.match(read.excerpt, /Rated: bad — Leading\./); assert.match(read.excerpt, /Dismissed/);
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /## Dismissed questions/);
});

test('older maps without any of this behave as before', async () => {
  const { store, act, map } = await asked(['Old style?']);
  const legacy = await store.get(map.id);
  delete legacy.nodes[0].questions[0].askedAt; delete legacy.nodes[0].questions[0].jobId;
  const saved = await act({ type: 'answer', questionId: legacy.nodes[0].questions[0].id, answer: 'Fine.' });
  assert.equal(saved.nodes[0].status, 'queued');
});
