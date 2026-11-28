import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { reusableResult, RESEARCH, EXPLAIN } from '../skills/explore/assets/questions.js';
import { questionResearchHtml, questionHelpHtml } from '../skills/explore/assets/workspace-view.js';
import { questionClick } from '../skills/explore/assets/question-clicks.js';

// Reuse earlier research answers (Z4, #62). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const options = [{ id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.' }, { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' }];
const research = { summary: 'Two workable models.', options, recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' } };

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
  const questions = (await store.get(map.id)).nodes[0].questions;
  return { store, map, act, ask, view, questions };
}
const latest = (shown, type, questionId) => shown.jobs.filter(job => job.type === type && job.subjectId === questionId).at(-1);

test('asking again on an unchanged map offers the earlier research; the public view shows only that it is unchanged', async () => {
  const { store, map, ask, view, questions } = await setup();
  const shown = await ask(questions[0].id);
  const job = latest(shown, RESEARCH, questions[0].id);
  assert.equal(job.contextUnchanged, true);
  assert.equal(reusableResult(shown.jobs, RESEARCH, questions[0].id), job);
  for (const key of ['requestKey', 'reuseKey', 'inputSignature']) assert.equal(Object.hasOwn(job, key), false, `${key} stays private`);
  const stored = (await store.get(map.id)).jobs.find(item => item.id === job.id);
  assert.match(stored.requestKey, /^[0-9a-f]{64}$/); assert.match(stored.reuseKey, /^[0-9a-f]{64}$/);
  assert.equal(reusableResult(shown.jobs, RESEARCH, questions[1].id), null, 'another question is not matched');
  assert.equal(reusableResult(shown.jobs, EXPLAIN, questions[0].id), null, 'another kind of help is not matched');
  const branch = (await view()).jobs.find(item => item.type === undefined || item.type === 'investigate');
  assert.equal(Object.hasOwn(branch, 'contextUnchanged'), false, 'branch research is never offered');
});

test('a change to what the research used removes the offer: the idea, a linked dependency, the goal or the glossary', async () => {
  const cases = {
    'the idea itself': async ({ act, map, questions }) => act({ type: 'answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'The field team.' }),
    'a linked dependency': async ({ act, map, store }) => {
      const storage = (await store.get(map.id)).nodes.find(node => node.title === 'Storage');
      await act({ type: 'link', nodeId: map.rootId, to: storage.id, relation: 'depends_on' });
    },
    'the goal': async ({ act }) => act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' }),
    'the glossary': async ({ act }) => act({ type: 'glossary-add', term: 'Sync', definition: 'Sharing changes between devices.' }),
  };
  let setupRef;
  for (const [what, change] of Object.entries(cases)) {
    setupRef = await setup();
    const { ask, view, questions } = setupRef;
    assert.equal(latest(await ask(questions[0].id), RESEARCH, questions[0].id).contextUnchanged, true, what);
    await change(setupRef);
    assert.equal(reusableResult((await view()).jobs, RESEARCH, questions[0].id), null, `${what} changed: no offer`);
  }
});

test('failed, cancelled and stale research, and jobs saved before this feature, are never offered', async () => {
  const { store, map, act, view, questions } = await setup();
  await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  let packet = await store.claim('agent', map.id);
  await store.fail(map.id, packet.jobId, packet.claimKey, 'No sources.');
  assert.equal(reusableResult((await view()).jobs, RESEARCH, questions[0].id), null, 'failed');
  let saved = await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  await act({ type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal(reusableResult((await view()).jobs, RESEARCH, questions[0].id), null, 'cancelled');
  await act({ type: 'request-research', nodeId: map.rootId, questionId: questions[0].id });
  packet = await store.claim('agent', map.id);
  await act({ type: 'answer', nodeId: map.rootId, questionId: questions[1].id, answer: 'The field team.' }); // While it ran.
  await store.complete(map.id, packet.jobId, packet.claimKey, research);
  const shown = await view();
  assert.equal(latest(shown, RESEARCH, questions[0].id).stale, true); assert.equal(reusableResult(shown.jobs, RESEARCH, questions[0].id), null, 'stale');
  // A job saved before this feature has no keys.
  const raw = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  for (const job of raw.jobs) { delete job.requestKey; delete job.reuseKey; }
  const old = store.view(raw);
  assert.equal(old.jobs.some(job => job.contextUnchanged), false);
});

test('Explain this question is offered again the same way', async () => {
  const { ask, questions } = await setup();
  const shown = await ask(questions[0].id, { type: 'request-help', result: { help: 'It asks how edits combine.' } });
  assert.equal(reusableResult(shown.jobs, EXPLAIN, questions[0].id)?.contextUnchanged, true);
});

test('the question shows the offer with the earlier date, and earlier results always show when they were done', () => {
  const question = { id: 'q1', text: 'Which sync model fits?', answer: null };
  const job = { id: 'job-r1', type: RESEARCH, subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: research };
  const html = questionResearchHtml({ question, jobs: [job], listening: false, seen: new Set(), esc, offers: { q1: 'job-r1' }, nodeId: 'n1' });
  assert.match(html, /<p class="reuse-offer" role="status">You asked this on [^<]*2026\. Nothing it used has changed since\. <button type="button" class="text-button" data-reuse-show="job-r1" data-question-id="q1">Show earlier result<\/button> <button type="button" class="text-button" data-reuse-again="research" data-node-id="n1" data-question-id="q1">Ask again<\/button><\/p>/);
  assert.match(html, /<summary>Research from your agent, not your answer · [^<]*2026<\/summary>/);
  assert.doesNotMatch(questionResearchHtml({ question, jobs: [job], listening: false, seen: new Set(), esc, nodeId: 'n1' }), /reuse-offer/, 'no offer until asked again');
  const help = { id: 'job-h1', type: EXPLAIN, subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: { help: 'It asks how edits combine.' } };
  assert.match(questionHelpHtml({ question, jobs: [help], listening: false, seen: new Set(), esc, offers: { q1: 'job-h1' }, nodeId: 'n1' }), /data-reuse-again="help" data-node-id="n1" data-question-id="q1">Ask again/);
  assert.match(questionHelpHtml({ question, jobs: [help], listening: false, seen: new Set(), esc, nodeId: 'n1' }), /<summary>Help from your agent, not an answer · [^<]*2026<\/summary>/);
});

test('asking again offers the earlier result instead of queueing; Show earlier result writes nothing, and Ask again queues new work', async () => {
  const job = { id: 'job-r1', type: RESEARCH, subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', contextUnchanged: true, result: research };
  const calls = [], toasts = [], opened = [];
  const details = { open: false, scrollIntoView() {}, querySelector: () => ({ focus() { opened.push('summary'); } }) };
  globalThis.document = { querySelector: selector => (selector === '[data-help="job-r1"]' ? details : selector.startsWith('[data-reuse-show') ? { focus() { opened.push('offer'); } } : null) };
  const state = { visibleMap: { jobs: [job] }, map: { jobs: [job] }, drafts: {}, helpSeen: new Set(['job-r1']) };
  const app = { state, act: async (...args) => { calls.push(args); return true; }, toast: message => toasts.push(message), renderDetail: () => {}, closeMenus: () => {}, agentListening: () => false, loadRestartPreview: () => {} };
  const click = dataset => questionClick({ target: { closest: selector => (selector === `[${Object.keys(dataset)[0].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace(/^/, 'data-')}]` ? { dataset } : null) } }, app);
  try {
    assert.equal(await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' }), true);
    assert.deepEqual(calls, [], 'no job is queued'); assert.deepEqual(state.reuseOffers, { q1: 'job-r1' }); assert.deepEqual(opened, ['offer'], 'focus moves to the offer');
    assert.equal(await click({ reuseShow: 'job-r1', questionId: 'q1' }), true);
    assert.deepEqual(calls, [], 'showing it writes nothing'); assert.equal(details.open, true); assert.equal(state.helpSeen.has('job-r1'), false, 'it opens'); assert.deepEqual(state.reuseOffers, {});
    state.reuseOffers = { q1: 'job-r1' };
    assert.equal(await click({ reuseAgain: 'research', nodeId: 'n1', questionId: 'q1' }), true);
    assert.deepEqual(calls, [['n1', 'request-research', { questionId: 'q1' }]], 'Ask again queues new work'); assert.deepEqual(state.reuseOffers, {});
    state.visibleMap.jobs = [{ ...job, contextUnchanged: false }];
    await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' });
    assert.equal(calls.length, 2, 'nothing to offer: it queues as before');
  } finally { delete globalThis.document; }
});
