import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { snapshotOf } from '../skills/explore/scripts/versions.mjs';
import { exportMap } from '../skills/explore/scripts/transfer.mjs';
import { reusableResult, RESEARCH, EXPLAIN } from '../skills/explore/assets/questions.js';
import { questionResearchHtml, questionHelpHtml } from '../skills/explore/assets/workspace-view.js';
import { questionClick } from '../skills/explore/assets/question-clicks.js';

// Reuse earlier research answers (Z4, #62). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const options = [{ id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.' }, { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' }];
const research = { summary: 'Two workable models.', options, recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' } };
const help = { help: 'It asks how edits combine.' };

async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'reuse-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on the field.', body: 'Sync is the hard part.', questions: ['Which sync model fits?', 'Who edits notes?'], suggestions: [{ title: 'Storage', body: 'Local storage limits.' }] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  // Ask for help with `type` on a question, let the agent deliver `result`, and return the map as the browser sees it.
  const ask = async (questionId, { type = 'request-research', result = research } = {}) => {
    await act({ type, nodeId: map.rootId, questionId });
    const packet = await store.claim('agent', map.id);
    await store.complete(map.id, packet.jobId, packet.claimKey, result);
    return store.view(await store.get(map.id));
  };
  const view = async () => store.view(await store.get(map.id));
  const storage = async () => (await store.get(map.id)).nodes.find(node => node.title === 'Storage');
  const questions = (await store.get(map.id)).nodes[0].questions;
  return { store, map, act, ask, view, storage, questions };
}
const latest = (shown, type, questionId) => shown.jobs.filter(job => job.type === type && job.subjectId === questionId && job.status === 'completed').at(-1);

test('the newest research on an unchanged map is marked unchanged; its key stays in map.json, out of views, versions and exports', async () => {
  const { store, map, ask, view, questions } = await setup();
  const shown = await ask(questions[0].id);
  const job = latest(shown, RESEARCH, questions[0].id);
  assert.equal(job.contextUnchanged, true);
  assert.equal(reusableResult(shown.jobs, RESEARCH, questions[0].id), job);
  for (const key of ['requestKey', 'reuseKey', 'inputSignature']) assert.equal(Object.hasOwn(job, key), false, `${key} stays private`);
  const saved = await store.get(map.id), stored = saved.jobs.find(item => item.id === job.id);
  assert.match(stored.reuseKey, /^[0-9a-f]{64}$/); assert.equal(Object.hasOwn(stored, 'requestKey'), false, 'no request key is kept');
  assert.equal(JSON.stringify(snapshotOf(saved)).includes('reuseKey'), false, 'versions leave it out');
  assert.equal(JSON.stringify(await exportMap(store, map.id)).includes('reuseKey'), false, 'exports leave it out');
  const { versions } = await store.versions.list(map.id);
  assert.ok(versions.length);
  for (const version of versions) assert.doesNotMatch(await readFile(store.versions.file(map.id, version.id), 'utf8'), /reuseKey/, 'saved versions on disk too');
  assert.equal(reusableResult(shown.jobs, RESEARCH, questions[1].id), null, 'another question is not matched');
  assert.equal(reusableResult(shown.jobs, EXPLAIN, questions[0].id), null, 'another kind of help is not matched');
  const branch = (await view()).jobs.find(item => item.type === undefined || item.type === 'investigate');
  assert.equal(Object.hasOwn(branch, 'contextUnchanged'), false, 'branch research is never offered');
});

test('anything the research packet shows removes the mark: an answer, how sure it is, what would disprove it, a linked dependency, the goal or the glossary', async () => {
  const cases = {
    'another answer on the idea': async ({ act, map, questions }) => act({ type: 'change-answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'Only the team lead.' }),
    'how sure an answer is': async ({ act, map, questions }) => act({ type: 'change-answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'The field team.', answerState: 'assumption' }),
    'what would disprove an assumption': async ({ act, map, questions }) => act({ type: 'set-disprove-if', nodeId: map.rootId, questionId: questions[1].id, text: 'A second team edits too.' }),
    'a linked dependency': async ({ act, map, storage }) => act({ type: 'link', nodeId: map.rootId, to: (await storage()).id, relation: 'depends_on' }),
    'the goal': async ({ act }) => act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' }),
    'the glossary': async ({ act }) => act({ type: 'glossary-add', term: 'Sync', definition: 'Sharing changes between devices.' }),
  };
  for (const [what, change] of Object.entries(cases)) {
    const context = await setup(), { act, map, ask, view, questions } = context;
    // An answer to change first, the same in every case; an assumption where the note needs one.
    await act({ type: 'answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'The field team.', ...(what.includes('disprove') ? { answerState: 'assumption' } : {}) });
    assert.equal(latest(await ask(questions[0].id), RESEARCH, questions[0].id).contextUnchanged, true, what);
    await change(context);
    const shown = await view();
    assert.equal(reusableResult(shown.jobs, RESEARCH, questions[0].id), null, `${what} changed: no offer`);
  }
});

test('Explain this question reads only the question, its idea and the path up, so a related link leaves it reusable', async () => {
  const { act, map, ask, view, storage, questions } = await setup();
  assert.equal(reusableResult((await ask(questions[0].id, { type: 'request-help', result: help })).jobs, EXPLAIN, questions[0].id)?.contextUnchanged, true);
  await act({ type: 'link', nodeId: map.rootId, to: (await storage()).id, relation: 'related_to' });
  assert.equal(reusableResult((await view()).jobs, EXPLAIN, questions[0].id)?.contextUnchanged, true, 'its packet has no links');
  await act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' });
  assert.equal(reusableResult((await view()).jobs, EXPLAIN, questions[0].id), null, 'its packet carries the goal');
});

test('only the newest finished result is marked; waiting, failed, cancelled, interrupted, stale and pre-feature jobs never are', async () => {
  const { store, map, act, ask, view, questions } = await setup();
  const first = latest(await ask(questions[0].id), RESEARCH, questions[0].id);
  const shown = await ask(questions[0].id); // Ask again: new work on the same unchanged map.
  const second = latest(shown, RESEARCH, questions[0].id);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(shown.jobs.filter(job => job.contextUnchanged).map(job => job.id), [second.id], 'only the newest');
  await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  assert.equal(reusableResult((await view()).jobs, RESEARCH, questions[0].id), null, 'queued');
  assert.equal((await view()).jobs.some(job => job.contextUnchanged), false, 'nothing is marked while new work waits');
  let packet = await store.claim('agent', map.id);
  assert.equal((await view()).jobs.some(job => job.contextUnchanged), false, 'or runs');
  await store.fail(map.id, packet.jobId, packet.claimKey, 'No sources.');
  assert.equal(latest(await view(), RESEARCH, questions[0].id).contextUnchanged, true, 'a failure leaves the earlier result as it was');
  // A job interrupted by a restart has no result and is never offered; the finished one before it still is.
  const raw = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  raw.jobs.push({ ...raw.jobs.find(job => job.id === second.id), id: 'job-interrupted', status: 'interrupted', result: undefined });
  assert.equal(store.view(raw).jobs.find(job => job.id === 'job-interrupted').contextUnchanged, undefined);
  // Stale: the context changed while the research ran.
  await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  packet = await store.claim('agent', map.id);
  await act({ type: 'answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'The field team.' });
  await store.complete(map.id, packet.jobId, packet.claimKey, research);
  const stale = await view();
  assert.equal(latest(stale, RESEARCH, questions[0].id).stale, true); assert.equal(reusableResult(stale.jobs, RESEARCH, questions[0].id), null, 'stale');
  // A job saved before this feature has no key.
  const old = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  for (const job of old.jobs) delete job.reuseKey;
  assert.equal(store.view(old).jobs.some(job => job.contextUnchanged), false, 'pre-feature');
});

test('cancelled research is never marked', async () => {
  const { act, view, map, questions } = await setup();
  const saved = await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  await act({ type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal((await view()).jobs.some(job => job.contextUnchanged), false);
});

test('an unchanged result says so inside it, with Ask again; earlier results always show when they were done', () => {
  const question = { id: 'q1', text: 'Which sync model fits?', answer: null };
  const job = { id: 'job-r1', type: RESEARCH, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: research };
  const html = questionResearchHtml({ question, jobs: [job], listening: false, seen: new Set(), esc });
  assert.match(html, /<summary>Research from your agent, not your answer · [^<]*2026<\/summary><p class="reuse-note" id="reuse-note-job-r1">Nothing it used has changed since you asked\. <button type="button" class="text-button" data-reuse-again="research" data-node-id="n1" data-question-id="q1" aria-describedby="reuse-note-job-r1">Ask again<\/button><\/p>/);
  assert.doesNotMatch(questionResearchHtml({ question, jobs: [{ ...job, contextUnchanged: undefined }], listening: false, seen: new Set(), esc }), /reuse-note/, 'only when unchanged');
  const explained = { id: 'job-h1', type: EXPLAIN, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: help };
  assert.match(questionHelpHtml({ question, jobs: [explained], listening: false, seen: new Set(), esc }), /<summary>Help from your agent, not an answer · [^<]*2026<\/summary><p class="reuse-note"[^>]*>Nothing it used has changed since you asked\. <button [^>]*data-reuse-again="help" data-node-id="n1" data-question-id="q1"[^>]*>Ask again/);
});

test('asking again opens and focuses the earlier result and writes nothing; Ask again queues new work', async () => {
  const job = { id: 'job-r1', type: RESEARCH, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: research };
  const calls = [], toasts = [], focused = [], rendered = [];
  const details = { open: false, scrollIntoView() {}, querySelector: selector => (selector === 'summary' ? { focus() { focused.push('summary'); } } : null) };
  globalThis.document = { querySelector: selector => (selector === '[data-help="job-r1"]' ? details : null) };
  const state = { visibleMap: { jobs: [job] }, map: { jobs: [job] }, drafts: {}, helpSeen: new Set(['job-r1']) };
  const app = { state, act: async (...args) => { calls.push(args); return true; }, toast: message => toasts.push(message), renderDetail: () => rendered.push(true), closeMenus: () => {}, agentListening: () => false, loadRestartPreview: () => {} };
  // A control with `dataset`, found by the handler that names its data attribute.
  const click = dataset => {
    const attribute = `data-${Object.keys(dataset)[0].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, control = { dataset };
    return questionClick({ target: { closest: selector => (selector.split(', ').includes(`[${attribute}]`) ? control : null) } }, app).then(done => ({ done, control }));
  };
  try {
    assert.equal((await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' })).done, true);
    assert.deepEqual(calls, [], 'no job is queued');
    assert.equal(details.open, true); assert.equal(state.helpSeen.has('job-r1'), false, 'it opens'); assert.deepEqual(focused, ['summary'], 'focus moves to it');
    assert.equal(rendered.length, 1); assert.match(toasts.at(-1), /Nothing it used has changed since you asked/);
    const { done, control } = await click({ reuseAgain: 'research', nodeId: 'n1', questionId: 'q1' });
    assert.equal(done, true); assert.deepEqual(calls, [['n1', 'request-research', { questionId: 'q1' }]], 'Ask again queues new work');
    assert.equal(control.disabled, false, 'enabled again once sent'); assert.equal(toasts.at(-1), 'Queued. Connect your agent to get the research.');
    await click({ reuseAgain: 'help', nodeId: 'n1', questionId: 'q1' });
    assert.deepEqual(calls.at(-1), ['n1', 'request-help', { questionId: 'q1' }]); assert.equal(toasts.at(-1), 'Queued. Connect your agent to get the explanation.');
    state.visibleMap.jobs = [{ ...job, contextUnchanged: undefined }];
    await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' });
    assert.deepEqual(calls.at(-1), ['n1', 'request-research', { questionId: 'q1' }], 'nothing to reuse: it queues as before');
    await click({ qHelp: '', nodeId: 'n1', questionId: 'q1' });
    assert.deepEqual(calls.at(-1), ['n1', 'request-help', { questionId: 'q1' }], 'Explain queues when it has no earlier help');
  } finally { delete globalThis.document; }
});
