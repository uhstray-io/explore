import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, isCompleted } from '../skills/explore/scripts/store.mjs';
import { questionMenuHtml, questionTidyHtml } from '../skills/explore/assets/workspace-view.js';

// Tidy my wording (Z3, #61). Illustrative fixtures under .test-output, never ideas/.
async function asked(questions = ['Who edits the notes?', 'How long are trips?']) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'tidy-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent');
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on the team.', body: 'Who edits matters.', questions });
  const act = async input => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, ...input }); };
  return { store, map: saved, act, question: saved.nodes[0].questions[0] };
}
const tidyJobs = map => map.jobs.filter(job => job.type === 'clean-answer');
const draft = 'me and maybe my  partner , we both edits notes notes in the field';

test('asking to tidy a draft queues one job with the draft and leaves the idea alone', async () => {
  const { map, act, question } = await asked();
  let saved = await act({ type: 'clean-answer', questionId: question.id, text: draft });
  const [job] = tidyJobs(saved);
  assert.equal(job.subjectId, question.id); assert.deepEqual(job.input, { text: draft });
  const node = saved.nodes[0];
  assert.equal(node.status, 'awaiting-answer'); assert.equal(node.contentRevision, map.nodes[0].contentRevision);
  assert.equal(node.questions[0].answer, null); assert.deepEqual(saved.growth, map.growth);
  saved = await act({ type: 'clean-answer', questionId: question.id, text: 'Another draft.' });
  assert.equal(tidyJobs(saved).length, 1, 'one pending request per question');
  for (const text of ['', '   ', 'x'.repeat(12001)]) await assert.rejects(act({ type: 'clean-answer', questionId: map.nodes[0].questions[1].id, text }), error => error.status === 400);
});

test('the agent gets only the question and the draft', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'clean-answer', questionId: question.id, text: draft });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'clean-answer');
  assert.deepEqual(packet.question, { id: question.id, text: 'Who edits the notes?' });
  assert.equal(packet.draft, draft);
  assert.equal(packet.context, undefined); assert.doesNotMatch(JSON.stringify(packet), /[\\/]nodes[\\/]|\.md"/, 'no nearby ideas or file paths');
  assert.match(packet.instruction, /keep the meaning/i); assert.match(packet.instruction, /add nothing/i);
});

test('a tidied wording stays on the job, and using or keeping it removes both texts', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'clean-answer', questionId: question.id, text: draft });
  const packet = await store.claim('agent', map.id);
  for (const bad of [{ text: '' }, { text: 'x', answer: 'y' }, { text: 'x'.repeat(12001) }, { text: 'x', changes: 'y'.repeat(301) }])
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400);
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { text: 'My partner and I both edit notes in the field.', changes: 'Fixed grammar and a repeated word.' });
  let job = tidyJobs(saved)[0];
  assert.equal(job.status, 'completed'); assert.equal(job.result.text, 'My partner and I both edit notes in the field.');
  const node = saved.nodes[0];
  assert.equal(node.questions[0].answer, null); assert.equal(node.status, 'awaiting-answer'); assert.equal(isCompleted(saved, node), false);
  assert.doesNotMatch(await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8'), /My partner and I/, 'never shown as findings');
  await assert.rejects(act({ type: 'resolve-clean', jobId: job.id, outcome: 'maybe' }), error => error.status === 400);
  saved = await act({ type: 'resolve-clean', jobId: job.id, outcome: 'applied' });
  job = tidyJobs(saved)[0];
  assert.equal(job.outcome, 'applied'); assert.equal(job.input, undefined); assert.equal(job.result, undefined, 'the draft and the proposal are gone from the map');
  assert.doesNotMatch(await readFile(store.file(map.id), 'utf8'), /edits notes notes|My partner and I/);
  await assert.rejects(act({ type: 'resolve-clean', jobId: job.id, outcome: 'rejected' }), error => error.status === 409, 'resolved once');
});

test('keeping your own wording and stopping a request also leave the idea alone', async () => {
  const { store, map, act, question } = await asked();
  let saved = await act({ type: 'clean-answer', questionId: question.id, text: draft });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'cancel-job', jobId: tidyJobs(saved)[0].id });
  assert.equal(tidyJobs(saved)[0].status, 'cancelled'); assert.equal(saved.nodes[0].status, 'awaiting-answer');
  await act({ type: 'clean-answer', questionId: question.id, text: draft });
  const packet = await store.claim('agent', map.id);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { text: 'Tidied.' });
  saved = await act({ type: 'resolve-clean', jobId: packet.jobId, outcome: 'rejected' });
  const job = tidyJobs(saved).find(j => j.id === packet.jobId);
  assert.equal(job.outcome, 'rejected'); assert.equal(job.result, undefined);
});

test('only an open question on an unfinished branch can be tidied; one saved for later can', async () => {
  const { store, act, question, map } = await asked();
  const other = map.nodes[0].questions[1];
  await act({ type: 'answer-later', questionId: other.id });
  await act({ type: 'clean-answer', questionId: other.id, text: 'A week or two.' });
  await act({ type: 'answer', questionId: question.id, answer: 'Two of us.' });
  await assert.rejects(act({ type: 'clean-answer', questionId: question.id, text: draft }), error => error.status === 409, 'answered');
  await act({ type: 'revise', body: 'A different premise.' });
  await assert.rejects(act({ type: 'clean-answer', questionId: other.id, text: draft }), error => error.status === 409, 'superseded');
  const { act: act2, map: map2 } = await asked();
  await act2({ type: 'dismiss-question', questionId: map2.nodes[0].questions[0].id });
  await assert.rejects(act2({ type: 'clean-answer', questionId: map2.nodes[0].questions[0].id, text: draft }), error => error.status === 409, 'dismissed');
  assert.ok(store);
});

test('Tidy my wording sits after Explain this question and shows only while there is a draft', () => {
  const esc = String;
  const labels = html => [...html.matchAll(/role="menuitem"([^>]*)>([^<]+)</g)].map(([, attributes, label]) => `${label}${/ hidden/.test(attributes) ? ' (hidden)' : ''}`);
  assert.deepEqual(labels(questionMenuHtml({ id: 'q-1' }, { nodeId: 'n', kind: 'open', drafting: true, esc })).slice(0, 4), ['Help me answer', 'Explain this question', 'Tidy my wording', 'Answer later']);
  assert.equal(labels(questionMenuHtml({ id: 'q-1' }, { nodeId: 'n', kind: 'open', esc }))[2], 'Tidy my wording (hidden)');
  assert.ok(labels(questionMenuHtml({ id: 'q-1', deferredAt: 'x' }, { nodeId: 'n', kind: 'waiting', drafting: true, esc })).includes('Tidy my wording'));
  assert.ok(!labels(questionMenuHtml({ id: 'q-1', answer: 'x' }, { nodeId: 'n', kind: 'answered', esc })).some(label => label.startsWith('Tidy')));
});

test('the tidied wording shows beside the original with Use this wording and Keep mine', () => {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const question = { id: 'q-1', text: 'Who edits?' };
  const job = (status, extra = {}) => ({ id: `job-${status}`, type: 'clean-answer', subjectId: 'q-1', status, stale: false, input: { text: 'me and <her>' }, ...extra });
  const html = (jobs, more = {}) => questionTidyHtml({ question, jobs, listening: false, draft: 'me and <her>', esc, ...more });
  assert.match(html([job('queued')]), /Queued for your agent\./);
  assert.match(html([job('queued')]), /data-stop-job="job-queued"/);
  assert.match(html([job('queued')]), /stored in the map/, 'says the draft sits in map.json while pending');
  const done = job('completed', { result: { text: 'She and I.', changes: 'Grammar.' } });
  const shown = html([done]);
  assert.match(shown, /Your wording<\/strong> me and &lt;her>/); assert.match(shown, /Tidied<\/strong> She and I\./); assert.match(shown, /Grammar\./);
  assert.match(shown, /data-tidy-use="job-completed" data-question-id="q-1">Use this wording/);
  assert.match(shown, /data-tidy-keep="job-completed" data-question-id="q-1">Keep mine/);
  assert.doesNotMatch(shown, /changed since/);
  assert.match(html([done], { draft: 'something new' }), /You changed your answer since asking/);
  assert.equal(html([{ ...done, stale: true }]), '', 'not for a question that is no longer open');
  assert.equal(html([{ ...done, outcome: 'applied', result: undefined, input: undefined }]), '');
  assert.match(html([], { restorable: true }), /data-tidy-restore="q-1">Restore my wording/);
  assert.equal(html([]), '');
});
