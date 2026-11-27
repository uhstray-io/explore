import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store, isCompleted } from '../skills/explore/scripts/store.mjs';
import { questionMenuHtml, questionHelpHtml } from '../skills/explore/assets/workspace-view.js';

// Explain this question (B4, #6). Illustrative fixtures under .test-output, never ideas/.
async function asked(questions = ['What counts as offline?', 'Who edits notes?']) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'qhelp-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent');
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on the field.', body: 'Questions.', questions });
  const act = async input => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, ...input }); };
  return { store, map: saved, act, question: saved.nodes[0].questions[0] };
}
const helpJobs = map => map.jobs.filter(job => job.type === 'question-help');

test('asking for an explanation queues one help job and leaves the branch alone', async () => {
  const { map, act, question } = await asked();
  let saved = await act({ type: 'request-help', questionId: question.id });
  assert.equal(helpJobs(saved).length, 1);
  assert.equal(saved.nodes[0].status, 'awaiting-answer'); assert.equal(saved.nodes[0].contentRevision, map.nodes[0].contentRevision);
  assert.deepEqual(helpJobs(saved)[0].input, { question: 'What counts as offline?' });
  saved = await act({ type: 'request-help', questionId: question.id });
  assert.equal(helpJobs(saved).length, 1, 'a repeat request reuses the open job');
});

test('the agent gets the question, its idea and the path to the root, under the packet budget', async () => {
  const { store, map, act, question } = await asked();
  // A long chain of ancestors above the question's idea.
  let parent = map.rootId, saved = map;
  for (let i = 0; i < 30; i++) {
    saved = await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: parent, type: 'suggest', title: `Level ${i}`, body: 'x'.repeat(400) });
    parent = saved.nodes.at(-1).id;
  }
  await act({ type: 'request-help', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'question-help');
  assert.deepEqual(packet.question, { id: question.id, text: 'What counts as offline?' });
  assert.equal(packet.node.id, map.rootId);
  assert.match(packet.instruction, /Do not answer it or recommend an answer/);
  assert.ok(JSON.stringify(packet).length <= 6000);
});

test('delivered help stays on the job and never completes the branch', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-help', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { help: 'x', summary: 'Sneaky findings.' }), error => error.status === 400);
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { help: 'x'.repeat(3001) }), error => error.status === 400);
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { help: 'Offline means no signal at all. For example, a field site with no coverage for a week.' });
  const job = helpJobs(saved)[0];
  assert.equal(job.status, 'completed'); assert.equal(job.stale, false); assert.match(job.result.help, /no signal at all/);
  assert.equal(saved.nodes[0].status, 'awaiting-answer'); assert.equal(isCompleted(saved, saved.nodes[0]), false);
  assert.equal(saved.nodes[0].summary, 'Depends on the field.');
});

test('a failed, stopped or interrupted help job leaves the idea as it was', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-help', questionId: question.id });
  let packet = await store.claim('agent', map.id);
  let saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'No idea.');
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  saved = await act({ type: 'request-help', questionId: question.id });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'cancel-job', jobId: helpJobs(saved).at(-1).id });
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  await act({ type: 'request-help', questionId: question.id });
  packet = await store.claim('agent', map.id);
  await new Store(store.directory).recover();
  saved = await store.get(map.id);
  assert.equal(helpJobs(saved).at(-1).status, 'interrupted'); assert.equal(saved.nodes[0].status, 'awaiting-answer');
});

test('only an open question on an unfinished branch can be explained', async () => {
  const { act, question, map } = await asked();
  const other = map.nodes[0].questions[1];
  await act({ type: 'answer', questionId: question.id, answer: 'No signal for days.' });
  await assert.rejects(act({ type: 'request-help', questionId: question.id }), error => error.status === 409);
  await act({ type: 'revise', body: 'A different premise.' });
  await assert.rejects(act({ type: 'request-help', questionId: other.id }), error => error.status === 409, 'superseded');
});

test('help that arrives after the question was answered is kept as stale', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-help', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  await act({ type: 'answer', questionId: question.id, answer: 'No signal for days.' });
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { help: 'Late.' });
  assert.equal(helpJobs(saved)[0].stale, true);
});

test('the menu offers Explain this question after Help me answer, and help shows under the question, never as an answer', () => {
  const esc = String;
  const menu = questionMenuHtml({ id: 'q-1' }, { nodeId: 'node-1', kind: 'open', esc });
  const labels = [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.equal(labels[0], 'Help me answer'); assert.equal(labels[1], 'Explain this question'); assert.equal(labels[2], 'Tidy my wording'); assert.equal(labels[3], 'Answer later');
  assert.doesNotMatch(questionMenuHtml({ id: 'q-1' }, { nodeId: 'node-1', kind: 'answered', esc }), /Explain this question/);
  const question = { id: 'q-1', text: 'Offline?' };
  const job = status => ({ id: `job-${status}`, type: 'question-help', subjectId: 'q-1', status, stale: false, result: status === 'completed' ? { help: 'It means <no signal>.' } : undefined });
  const html = (jobs, options = {}) => questionHelpHtml({ question, jobs, listening: false, seen: new Set(), esc: value => String(value).replace(/</g, '&lt;'), ...options });
  assert.match(html([job('queued')]), /Queued for your agent/);
  assert.match(html([job('queued')], { listening: true }), /Your agent will pick this up next/);
  assert.match(html([job('running')], { listening: true }), /Your agent is explaining this question/);
  assert.match(html([job('completed')]), /<details class="question-help" data-help="job-completed" data-editor="help-job-completed" open><summary>Help from your agent, not an answer<\/summary><p class="question-help-text">It means &lt;no signal>\.<\/p><\/details>/);
  assert.doesNotMatch(html([job('completed')], { seen: new Set(['job-completed']) }), / open>/, 'collapsed after it was seen');
  assert.equal(html([{ ...job('completed'), stale: true }]), '', 'stale help is not shown as current');
  assert.equal(html([{ ...job('completed'), subjectId: 'q-2' }]), '');
});
