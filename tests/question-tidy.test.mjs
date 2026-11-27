import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, isCompleted } from '../skills/explore/scripts/store.mjs';
import { questionMenuHtml, questionTidyHtml, tidyArrived } from '../skills/explore/assets/workspace-view.js';
import { questionClick } from '../skills/explore/assets/question-clicks.js';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { startServer } from '../skills/explore/scripts/server.mjs';

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

test('Tidy my wording sits after Explain this question and waits for a draft', () => {
  const esc = String;
  const labels = html => [...html.matchAll(/role="menuitem"([^>]*)>([^<]+)</g)].map(([, attributes, label]) => `${label}${/ hidden/.test(attributes) ? ' (hidden)' : ''}`);
  assert.deepEqual(labels(questionMenuHtml({ id: 'q-1' }, { nodeId: 'n', kind: 'open', esc })).slice(0, 4), ['Help me answer', 'Explain this question', 'Tidy my wording (hidden)', 'Answer later'], 'opening the menu shows it while there is a draft');
  assert.match(questionMenuHtml({ id: 'q-1' }, { nodeId: 'n', kind: 'open', esc }), /data-q-tidy data-needs-draft hidden/);
  assert.ok(labels(questionMenuHtml({ id: 'q-1', deferredAt: 'x' }, { nodeId: 'n', kind: 'waiting', esc })).includes('Tidy my wording (hidden)'));
  assert.ok(!labels(questionMenuHtml({ id: 'q-1', answer: 'x' }, { nodeId: 'n', kind: 'answered', esc })).some(label => label.startsWith('Tidy')));
});

test('the tidied wording shows beside the original with Use this wording and Keep mine', () => {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const question = { id: 'q-1', text: 'Who edits?' };
  const job = (status, extra = {}) => ({ id: `job-${status}`, type: 'clean-answer', subjectId: 'q-1', status, stale: false, input: { text: 'me and <her>' }, ...extra });
  const html = (jobs, more = {}) => questionTidyHtml({ question, jobs, listening: false, draft: 'me and <her>', esc, ...more });
  assert.match(html([job('queued')]), /Queued for your agent\./);
  assert.match(html([job('queued')]), /data-stop-job="job-queued"/);
  assert.match(html([job('queued')]), /Until you use or keep the result, your draft is stored in the map file/);
  assert.match(html([job('failed')]), /could not tidy this wording/, 'a failed request says so');
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

test('only the newest open request keeps the texts, and versions and exports never carry them', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'clean-answer', questionId: question.id, text: draft });
  let packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, { text: 'First tidy.' });
  let saved = await act({ type: 'clean-answer', questionId: question.id, text: 'A second draft of mine.' });
  const [first, second] = tidyJobs(saved);
  assert.equal(first.result, undefined, 'the older proposal gave up its texts'); assert.equal(first.input, undefined);
  assert.deepEqual(second.input, { text: 'A second draft of mine.' });
  // Answering while the second is still queued stops it before an agent reads the draft.
  saved = await act({ type: 'answer', questionId: question.id, answer: 'Two of us.' });
  assert.equal(tidyJobs(saved)[1].status, 'cancelled'); assert.equal(tidyJobs(saved)[1].input, undefined);
  assert.equal(await store.claim('agent', map.id), null, 'nothing about the draft is handed out');
  const versionsDir = path.join(path.dirname(store.file(map.id)), 'versions');
  for (const file of await readdir(versionsDir)) assert.doesNotMatch(await readFile(path.join(versionsDir, file), 'utf8'), /edits notes notes|First tidy|second draft/, file);
});

test('a draft whose packet would not fit is refused when asked, not lost at claim', async () => {
  const { act, question } = await asked();
  await assert.rejects(act({ type: 'clean-answer', questionId: question.id, text: '- "an item"\n'.repeat(900) }), error => error.status === 400 && /too long to tidy/.test(error.message));
});

test('a tidied wording that arrives is noticed for the selected idea only', () => {
  const job = (id, nodeId, status, result) => ({ id, type: 'clean-answer', nodeId, status, ...(result ? { result } : {}) });
  assert.equal(tidyArrived([job('a', 'n1', 'running')], [job('a', 'n1', 'completed', { text: 'x' })], 'n1'), true);
  assert.equal(tidyArrived([job('a', 'n1', 'completed', { text: 'x' })], [job('a', 'n1', 'completed', { text: 'x' })], 'n1'), false);
  assert.equal(tidyArrived([job('a', 'n2', 'running')], [job('a', 'n2', 'completed', { text: 'x' })], 'n1'), false);
});

test('the question clicks work outside app.js: dismiss, answer later, and using, keeping and restoring a tidied wording', async () => {
  const fields = { 'q-1': { value: 'my draft', focus() {} } };
  globalThis.document = { querySelector: selector => { const match = selector.match(/data-draft="([^"]+)"/); return match ? fields[match[1]] ?? null : null; } };
  const calls = [], toasts = [];
  const state = { drafts: { 'q-1': 'my draft' }, tidyRestore: {}, map: { nodes: [{ id: 'n', questions: [] }] },
    visibleMap: { jobs: [{ id: 'job-t', type: 'clean-answer', subjectId: 'q-1', nodeId: 'n', status: 'completed', result: { text: 'My tidy draft.' }, input: { text: 'my draft' } }] } };
  let succeed = true;
  const app = { state, act: async (...args) => { calls.push(args); return succeed; }, toast: message => toasts.push(message), renderDetail() {}, closeMenus() {}, agentListening: () => false, loadRestartPreview() {} };
  const click = attributes => questionClick({ target: { closest: selector => { const name = selector.match(/^\[data-([a-z-]+)/)?.[1]; return name && attributes[name] !== undefined ? { dataset: attributes.dataset, disabled: false } : null; } } }, app);
  assert.equal(await click({ 'q-dismiss': '', dataset: { nodeId: 'n', questionId: 'q-1' } }), true);
  assert.equal(await click({ 'answer-later': '', dataset: { nodeId: 'n', answerLater: 'q-1' } }), true);
  assert.deepEqual(calls.map(call => call[1]), ['dismiss-question', 'answer-later']); assert.equal(toasts.length, 2, 'both confirm, with no error');
  succeed = false;
  assert.equal(await click({ 'tidy-use': '', dataset: { tidyUse: 'job-t', questionId: 'q-1' } }), true);
  assert.equal(state.drafts['q-1'], 'my draft', 'a failed save leaves the draft alone'); assert.equal(state.tidyRestore['q-1'], undefined);
  succeed = true;
  await click({ 'tidy-use': '', dataset: { tidyUse: 'job-t', questionId: 'q-1' } });
  assert.equal(state.drafts['q-1'], 'My tidy draft.'); assert.equal(state.tidyRestore['q-1'], 'my draft');
  await click({ 'tidy-restore': '', dataset: { tidyRestore: 'q-1' } });
  assert.equal(state.drafts['q-1'], 'my draft'); assert.equal(state.tidyRestore['q-1'], undefined);
  await click({ 'tidy-keep': '', dataset: { tidyKeep: 'job-t', questionId: 'q-1' } });
  assert.deepEqual(calls.at(-1), [null, 'resolve-clean', { jobId: 'job-t', outcome: 'rejected' }]);
  delete globalThis.document;
});

test('the CLI hands out a tidy request and delivers the tidied wording', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'tidy-cli-'));
  const app = await startServer({ workspace, port: 0 });
  const cli = async args => JSON.parse((await promisify(execFile)(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', workspace])).stdout);
  try {
    const map = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
    const run = await app.store.claim('setup', map.id);
    let saved = await app.store.complete(map.id, run.jobId, run.claimKey, { summary: 's', body: 'b', questions: ['Who edits?'] });
    saved = await app.store.action(map.id, { expectedRevision: saved.revision, nodeId: map.rootId, type: 'clean-answer', questionId: saved.nodes[0].questions[0].id, text: draft });
    const packet = await cli(['next', '--worker', 'agent']);
    assert.equal(packet.jobType, 'clean-answer'); assert.equal(packet.draft, draft);
    const file = path.join(workspace, 'tidy.json'); await writeFile(file, JSON.stringify({ text: 'My partner and I both edit notes.' }));
    assert.equal((await cli(['result', '--job', packet.jobId, '--file', file])).saved, true);
    assert.equal(tidyJobs(await app.store.get(map.id))[0].result.text, 'My partner and I both edit notes.');
  } finally { await app.close(); }
});
