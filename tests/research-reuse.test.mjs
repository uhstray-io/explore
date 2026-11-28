import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { snapshotOf } from '../skills/explore/scripts/versions.mjs';
import { exportMap } from '../skills/explore/scripts/transfer.mjs';
import { reuseKey, reusableResult, contentKey } from '../skills/explore/scripts/reuse.mjs';
import { questionJobTypes } from '../skills/explore/scripts/question-actions.mjs';
import { RESEARCH, EXPLAIN } from '../skills/explore/assets/questions.js';
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
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on the field.', body: 'Sync is the hard part.', questions: ['Which sync model fits?', 'Who edits notes?', 'Which phones?'], suggestions: [{ title: 'Storage', body: 'Local storage limits.' }] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input });
  // Ask for help with `type` on a question and let the agent deliver `result`; returns the packet it was given.
  const ask = async (questionId, { type = 'request-research', result = research } = {}) => {
    await act({ type, questionId });
    const packet = await store.claim('agent', map.id);
    await store.complete(map.id, packet.jobId, packet.claimKey, result);
    return packet;
  };
  // The result asking again would open, or null.
  const reusable = async (questionId, type = RESEARCH) => (await reusableResult(store, map.id, { type, nodeId: map.rootId, questionId })).jobId;
  const storage = async () => (await store.get(map.id)).nodes.find(node => node.title === 'Storage');
  const questions = (await store.get(map.id)).nodes[0].questions;
  const rewrite = async change => { const raw = JSON.parse(await readFile(store.file(map.id), 'utf8')); change(raw); await writeFile(store.file(map.id), JSON.stringify(raw)); };
  return { store, map, act, ask, reusable, storage, questions, rewrite };
}

test('the claim keys what the agent read from the packet it built, and the key stays in map.json, out of views, versions and exports', async () => {
  const { store, map, ask, reusable, questions } = await setup();
  const packet = await ask(questions[0].id);
  const saved = await store.get(map.id), stored = saved.jobs.find(job => job.id === packet.jobId);
  const identifying = ['mapId', 'mapTitle', 'mapRevision', 'jobId', 'jobType', 'claimKey', 'reason', 'contextCharacters', 'approximateTokens'];
  assert.equal(stored.reuseKey, reuseKey(Object.fromEntries(Object.entries(packet).filter(([key]) => !identifying.includes(key)))), 'exactly what the agent got, without the fields that identify the work');
  assert.equal(await reusable(questions[0].id), packet.jobId);
  assert.equal(Object.hasOwn(store.view(saved).jobs.find(job => job.id === packet.jobId), 'reuseKey'), false, 'views leave it out');
  assert.equal(JSON.stringify(store.view(saved)).includes('contextUnchanged'), false, 'and views carry no mark: the check runs only when asked');
  assert.equal(JSON.stringify(snapshotOf(saved)).includes('reuseKey'), false, 'versions leave it out');
  assert.equal(JSON.stringify(await exportMap(store, map.id)).includes('reuseKey'), false, 'exports leave it out');
  const { versions } = await store.versions.list(map.id);
  assert.ok(versions.length);
  for (const version of versions) assert.doesNotMatch(await readFile(store.versions.file(map.id, version.id), 'utf8'), /reuseKey/, 'saved versions on disk too');
  assert.equal(await reusable(questions[1].id), null, 'another question is not matched');
  assert.equal(await reusable(questions[0].id, EXPLAIN), null, 'another kind of help is not matched');
  assert.equal((await reusableResult(store, map.id, { type: 'investigate', nodeId: map.rootId, questionId: questions[0].id })).jobId, null, 'branch research is never offered');
});

test('anything the research packet shows ends reuse, even what leaves the research current; what it does not show leaves it', async () => {
  const cases = {
    'another answer': ({ act, questions }) => act({ type: 'change-answer', questionId: questions[1].id, answer: 'Only the team lead.' }),
    'how sure an answer is, alone': ({ act, questions }) => act({ type: 'set-answer-state', questionId: questions[1].id, answerState: 'decided' }),
    'a wording fix': ({ act, questions }) => act({ type: 'change-answer', questionId: questions[1].id, answer: 'The field team, mostly.', rerun: false }),
    'what would disprove an assumption': ({ act, questions }) => act({ type: 'set-disprove-if', questionId: questions[1].id, text: 'A second team edits too.' }),
    'a linked dependency': async ({ act, storage }) => act({ type: 'link', to: (await storage()).id, relation: 'depends_on' }),
    'the goal': ({ act }) => act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' }),
    'the glossary': ({ act }) => act({ type: 'glossary-add', term: 'Sync', definition: 'Sharing changes between devices.' }),
    'an existing goal': ({ act }) => act({ type: 'set-guidance', objective: 'Pick a sync model by spring.' }),
    'an agreed term\'s meaning': async ({ act, store, map }) => act({ type: 'glossary-edit', termId: (await store.get(map.id)).glossary[0].id, definition: 'Sharing edits between phones.' }),
  };
  // What a case changes must exist before the research.
  const before = {
    'an existing goal': ({ act }) => act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' }),
    'an agreed term\'s meaning': ({ act }) => act({ type: 'glossary-add', term: 'Sync', definition: 'Sharing changes between devices.' }),
  };
  for (const [what, change] of Object.entries(cases)) {
    const context = await setup(), { act, ask, reusable, questions } = context;
    // An answer to change first, the same in every case: an assumption, so it can carry a note.
    await act({ type: 'answer', questionId: questions[1].id, answer: 'The field team.', answerState: 'assumption' });
    await before[what]?.(context);
    const { jobId } = await ask(questions[0].id);
    assert.equal(await reusable(questions[0].id), jobId, what);
    await change(context);
    assert.equal(await reusable(questions[0].id), null, `${what} changed: asking again asks anew`);
  }
  const { act, ask, reusable, questions } = await setup();
  const { jobId } = await ask(questions[0].id);
  await act({ type: 'rate-question', questionId: questions[1].id, rating: 'good' });
  await act({ type: 'answer-later', questionId: questions[2].id });
  assert.equal(await reusable(questions[0].id), jobId, 'rating or deferring another question changes nothing it read');
});

test('Explain this question reads only the question, its idea and the path up, so a related link or another answer leaves it', async () => {
  const { act, ask, reusable, storage, questions } = await setup();
  const { jobId } = await ask(questions[0].id, { type: 'request-help', result: help });
  assert.equal(await reusable(questions[0].id, EXPLAIN), jobId);
  await act({ type: 'link', to: (await storage()).id, relation: 'related_to' });
  await act({ type: 'answer', questionId: questions[1].id, answer: 'The field team.' });
  assert.equal(await reusable(questions[0].id, EXPLAIN), jobId, 'its packet has neither');
  await act({ type: 'set-guidance', mode: 'decide', objective: 'Pick a sync model.' });
  assert.equal(await reusable(questions[0].id, EXPLAIN), null, 'its packet carries the goal');
});

test('the content is the same at claim and at check, even when the glossary is cut by room', async () => {
  const { store, map, act } = await setup();
  for (let i = 0; i < 60; i++) await act({ type: 'glossary-add', term: `T${i}`, definition: `Short meaning ${i}.` });
  const saved = await store.get(map.id), job = { id: 'job-probe', type: 'probe', reason: 'Test.' };
  // A type whose own content uses nearly all its room, as trimmed research does.
  const definition = { label: 'Probe', packet: ({ budget }) => ({ filler: 'x'.repeat(budget - 1300), instruction: 'Do the probe work.' }) };
  const claimed = await store.typedPacket(saved, job, definition, null, { claimKey: 'c'.repeat(36) });
  const checked = await store.typedPacket({ ...saved, revision: saved.revision + 991 }, job, definition, null);
  assert.ok(claimed.glossary.length > 0 && claimed.glossary.length < 60, `the glossary was cut by room (${claimed.glossary.length} of 60)`);
  assert.equal(JSON.stringify(checked[contentKey]), JSON.stringify(claimed[contentKey]), 'no claim key and a longer revision change nothing');
});

test('nearby ideas give way in one pass exactly as measuring after each removal would', () => {
  const nodes = [{ id: 'root', title: 'Root', prompt: 'The idea.', body: 'The idea.', summary: 'Short.', questions: [{ id: 'q1', text: 'Which sync model fits?' }], status: 'explored', reviewState: 'unreviewed' },
    ...Array.from({ length: 90 }, (_, i) => ({ id: `n${i}`, title: `Idea ${i}`, prompt: 'p'.repeat(40 + (i * 37) % 500), body: 'b', summary: 's'.repeat(20 + (i * 53) % 400), questions: [], status: 'explored', reviewState: 'unreviewed', parentId: 'root' }))];
  const map = { rootId: 'root', nodes, edges: nodes.slice(1).map(node => ({ from: 'root', to: node.id, type: 'related_to' })) };
  const { packet } = questionJobTypes[RESEARCH], job = { subjectId: 'q1' };
  for (let budget = 2500; budget <= 40000; budget += 250) {
    const fast = packet({ map, job, node: nodes[0], budget }), slow = packet({ map, job, node: nodes[0], budget: 1e9 });
    while (JSON.stringify(slow).length > budget - 800 && slow.context.length) { slow.context.pop(); slow.omittedContext++; }
    assert.equal(fast.context.length, slow.context.length, `budget ${budget}`);
  }
});

test('each question keeps its own result; only the newest is offered; waiting, stale, cancelled and pre-feature work never is', async () => {
  const { store, map, act, ask, reusable, questions, rewrite } = await setup();
  const failing = Object.assign(Object.create(store), { typedPacket: async () => { throw new Error('Too long now.'); } });
  const first = await ask(questions[0].id), other = await ask(questions[1].id);
  assert.equal((await reusableResult(failing, map.id, { type: RESEARCH, nodeId: map.rootId, questionId: questions[0].id })).jobId, null, 'a packet that cannot be built now is no match');
  assert.equal(await reusable(questions[0].id), first.jobId); assert.equal(await reusable(questions[1].id), other.jobId, 'two questions on one idea');
  const second = await ask(questions[0].id); // Ask again: new work on the same map.
  assert.equal(await reusable(questions[0].id), second.jobId, 'only the newest');
  await act({ type: 'request-research', questionId: questions[0].id });
  assert.equal(await reusable(questions[0].id), null, 'queued');
  let packet = await store.claim('agent', map.id);
  assert.equal(await reusable(questions[0].id), null, 'running');
  await store.fail(map.id, packet.jobId, packet.claimKey, 'No sources.');
  assert.equal(await reusable(questions[0].id), second.jobId, 'a failure leaves the earlier result as it was');
  await rewrite(raw => raw.jobs.push({ id: 'job-interrupted', type: RESEARCH, nodeId: map.rootId, subjectId: questions[0].id, status: 'interrupted', createdAt: new Date().toISOString() }));
  assert.equal(await reusable(questions[0].id), second.jobId, 'so does an interrupted one');
  const saved = await act({ type: 'request-research', questionId: questions[0].id });
  await act({ type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal(await reusable(questions[0].id), second.jobId, 'and a stopped one');
  // Stale: the question's context changed while the research ran.
  await act({ type: 'request-research', questionId: questions[0].id });
  packet = await store.claim('agent', map.id);
  await act({ type: 'answer', questionId: questions[2].id, answer: 'Older Android phones.' });
  await store.complete(map.id, packet.jobId, packet.claimKey, research);
  assert.equal(store.view(await store.get(map.id)).jobs.find(job => job.id === packet.jobId).stale, true);
  assert.equal(await reusable(questions[0].id), null, 'stale');
  // A job saved before this feature has no key.
  const fresh = await ask(questions[1].id);
  await rewrite(raw => { for (const job of raw.jobs) delete job.reuseKey; });
  assert.equal(await reusable(questions[1].id), null, `pre-feature (${fresh.jobId})`);
});

test('the browser asks the server only when the user asks again, and the answer names a result or none', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const app = await startServer({ workspace: await mkdtemp(path.join(root, 'reuse-http-')), port: 0 });
  try {
    const map = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
    let packet = await app.store.claim('agent', map.id);
    await app.store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Depends.', body: 'Sync.', questions: ['Which sync model fits?'] });
    const question = (await app.store.get(map.id)).nodes[0].questions[0];
    await app.store.action(map.id, { expectedRevision: (await app.store.get(map.id)).revision, nodeId: map.rootId, type: 'request-research', questionId: question.id });
    packet = await app.store.claim('agent', map.id);
    await app.store.complete(map.id, packet.jobId, packet.claimKey, research);
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const get = async query => (await fetch(`${app.address}/api/maps/${map.id}/reusable?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const revision = (await app.store.get(map.id)).revision;
    assert.deepEqual(await get({ type: RESEARCH, node: map.rootId, question: question.id }), { jobId: packet.jobId });
    assert.deepEqual(await get({ type: EXPLAIN, node: map.rootId, question: question.id }), { jobId: null });
    assert.deepEqual(await get({ type: 'clean-answer', node: map.rootId, question: question.id }), { jobId: null }, 'Tidy my wording is not reusable');
    assert.equal((await app.store.get(map.id)).revision, revision, 'checking writes nothing');
  } finally { await app.close(); }
});

test('every result ends with a quiet Ask again, named for what it asks', () => {
  const question = { id: 'q1', text: 'Which sync model fits?', answer: null };
  const job = { id: 'job-r1', type: RESEARCH, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', result: research };
  const html = questionResearchHtml({ question, jobs: [job], listening: false, seen: new Set(), esc });
  assert.match(html, /<summary>Research from your agent, not your answer · [^<]*2026<\/summary><p class="question-help-text">Two workable models\.<\/p>/, 'the content comes first');
  assert.match(html, /<p class="reuse-again"><button type="button" class="text-button" data-reuse-again="research" data-node-id="n1" data-question-id="q1" aria-label="Ask again for research">Ask again<\/button><\/p><\/details>$/);
  assert.match(questionResearchHtml({ question, jobs: [{ ...job, stale: true }], listening: false, seen: new Set(), esc }), /Ask again for current research\.<\/p>[\s\S]*data-reuse-again="research"/, 'earlier research says Ask again, and has it');
  const explained = { id: 'job-h1', type: EXPLAIN, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', result: help };
  assert.match(questionHelpHtml({ question, jobs: [explained], listening: false, seen: new Set(), esc }), /<summary>Help from your agent, not an answer · [^<]*2026<\/summary><p class="question-help-text">It asks how edits combine\.<\/p><p class="reuse-again"><button [^>]*data-reuse-again="help" data-node-id="n1" data-question-id="q1" aria-label="Ask again for an explanation">Ask again<\/button><\/p><\/details>$/);
});

test('asking again opens and focuses the earlier result and writes nothing; Ask again queues new work and keeps focus on the question', async () => {
  const job = { id: 'job-r1', type: RESEARCH, nodeId: 'n1', subjectId: 'q1', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', result: research };
  const calls = [], toasts = [], focused = [], asked = [];
  let answer = { jobId: 'job-r1' }, control = null;
  const details = { open: false, scrollIntoView() { focused.push('scrolled'); }, querySelector: selector => (selector === 'summary' ? { focus() { focused.push('summary'); } } : null) };
  globalThis.document = { querySelector: selector => (selector === '[data-help="job-r1"]' ? details : selector === '[data-menu="q1"]' ? { focus() { focused.push('menu'); } } : null) };
  const state = { visibleMap: { jobs: [job] }, map: { id: 'map-1', jobs: [job] }, drafts: {}, helpSeen: new Set(['job-r1']) };
  const api = async route => { asked.push(route); if (answer instanceof Error) throw answer; return answer; };
  const app = { state, api, act: async (...args) => { calls.push([...args, control.disabled]); return true; }, toast: message => toasts.push(message), renderDetail: () => {}, closeMenus: () => {}, agentListening: () => false, loadRestartPreview: () => {} };
  // A control with `dataset`, found by the handler that names its data attribute.
  const click = dataset => {
    const attribute = `data-${Object.keys(dataset)[0].replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
    control = { dataset, disabled: false };
    return questionClick({ target: { closest: selector => (selector.split(', ').includes(`[${attribute}]`) ? control : null) } }, app);
  };
  try {
    assert.equal(await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' }), true);
    assert.deepEqual(asked, ['/maps/map-1/reusable?type=question-research&node=n1&question=q1'], 'the Store checks when asked');
    assert.deepEqual(calls, [], 'no job is queued');
    assert.equal(details.open, true); assert.equal(state.helpSeen.has('job-r1'), false, 'it opens'); assert.deepEqual(focused, ['scrolled', 'summary'], 'and takes focus');
    assert.match(toasts.at(-1), /Nothing it read has changed since this was asked/);
    focused.length = 0;
    await click({ reuseAgain: 'research', nodeId: 'n1', questionId: 'q1' });
    assert.equal(asked.length, 1, 'Ask again never checks');
    assert.deepEqual(calls, [['n1', 'request-research', { questionId: 'q1' }, true]], 'Ask again queues new work, disabled while it sends');
    assert.equal(control.disabled, false); assert.deepEqual(focused, ['menu'], 'focus stays on the question');
    assert.equal(toasts.at(-1), 'Queued. Connect your agent to get the research.');
    await click({ reuseAgain: 'help', nodeId: 'n1', questionId: 'q1' });
    assert.deepEqual(calls.at(-1).slice(0, 3), ['n1', 'request-help', { questionId: 'q1' }]); assert.equal(toasts.at(-1), 'Queued. Connect your agent to get the explanation.');
    // A result that arrived since the last poll: the browser refreshes once and opens it.
    const arrived = { ...job, id: 'job-r2' }, later = { ...details, open: false };
    answer = { jobId: 'job-r2' }; const before = calls.length;
    app.refresh = async () => { state.visibleMap = { jobs: [job, arrived] }; };
    globalThis.document = { querySelector: selector => (selector === '[data-help="job-r2"]' ? later : selector === '[data-menu="q1"]' ? { focus() {} } : null) };
    await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' });
    assert.equal(calls.length, before, 'nothing queued'); assert.equal(later.open, true, 'the new result opens');
    // One the browser still shows as queued, finished since the last poll: refreshed too, then opened.
    const finished = { ...job, id: 'job-r3' }, third = { ...details, open: false };
    answer = { jobId: 'job-r3' }; state.visibleMap = { jobs: [job, { ...finished, status: 'queued', result: undefined }] };
    let refreshes = 0;
    app.refresh = async () => { refreshes++; state.visibleMap = { jobs: [job, finished] }; };
    // As the page renders it: a queued job shows its status, not a result to open.
    globalThis.document = { querySelector: selector => (selector === '[data-help="job-r3"]' && state.visibleMap.jobs.find(item => item.id === 'job-r3')?.status === 'completed' ? third : selector === '[data-menu="q1"]' ? { focus() {} } : null) };
    await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' });
    assert.equal(refreshes, 1, 'the queued copy is refreshed'); assert.equal(calls.length, before, 'still nothing queued'); assert.equal(third.open, true, 'the finished result opens');
    answer = { jobId: null };
    await click({ qHelp: '', nodeId: 'n1', questionId: 'q1' });
    assert.match(asked.at(-1), /type=question-help/); assert.deepEqual(calls.at(-1).slice(0, 3), ['n1', 'request-help', { questionId: 'q1' }], 'nothing to reuse: it queues as before');
    answer = new Error('offline');
    await click({ qResearch: '', nodeId: 'n1', questionId: 'q1' });
    assert.deepEqual(calls.at(-1).slice(0, 3), ['n1', 'request-research', { questionId: 'q1' }], 'a failed check asks anew');
  } finally { delete globalThis.document; }
});
