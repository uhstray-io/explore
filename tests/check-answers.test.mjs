import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, publicMap } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { toolsDialog } from '../skills/explore/assets/tools-dialog.js';

// A map with two answered questions on the root and one on a child, plus one still open.
async function answered() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'check-')), 'ideas'));
  let map = await store.create({ title: 'Workshop', idea: 'Plan a cheap community workshop.' });
  let job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Scoped.', body: 'Two questions.', questions: ['Budget?', 'Audience?'], suggestions: [{ title: 'Venue', body: 'Where?' }] });
  const act = async input => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, ...input }); };
  map = await act({ type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Nothing at all.', answerState: 'decided' });
  map = await act({ type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[1].id, answer: 'Everyone, with catering.', answerState: 'assumption' });
  job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Finished.' });
  const venue = map.nodes[1];
  map = await act({ type: 'activate', nodeId: venue.id });
  job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Halls.', body: 'Options.', questions: ['Which hall?', 'Parking?'] });
  map = await act({ type: 'answer', nodeId: venue.id, questionId: map.nodes[1].questions[0].id, answer: 'The church hall.' });
  return { store, map: await store.get(map.id), act, venue };
}
const finding = (refs, extra = {}) => ({ category: 'possible-tension', explanation: 'Catering for everyone costs money.', resolution: 'Decide whether food is needed.', refs, ...extra });

test('nothing is checked until the user asks, and asking twice returns the same check', async () => {
  const { store, map, act } = await answered();
  assert.equal(await store.claim('test'), null, 'opening and polling create no map job');
  let saved = await act({ type: 'request-map-job', jobType: 'check-answers' });
  const job = saved.jobs.at(-1);
  assert.equal(job.type, 'check-answers'); assert.equal(job.nodeId, null);
  saved = await act({ type: 'request-map-job', jobType: 'check-answers' });
  assert.equal(saved.jobs.filter(j => j.type === 'check-answers').length, 1);
  await assert.rejects(act({ type: 'request-map-job', jobType: 'investigate' }), error => error.status === 400);
});

test('the packet reads current answers root first, leaves out earlier premises, and stays in budget', async () => {
  const { store, map, act } = await answered();
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  const preview = await store.previewMapJob(map.id, 'check-answers');
  const packet = await store.claim('test');
  assert.equal(packet.jobType, 'check-answers');
  assert.ok(JSON.stringify(packet).length < 16000);
  const answers = packet.records.filter(r => r.kind === 'answer');
  assert.deepEqual(answers.map(r => r.answer), ['Nothing at all.', 'Everyone, with catering.', 'The church hall.']);
  assert.equal(answers[1].certainty, 'Assumption');
  assert.ok(packet.records.some(r => r.kind === 'open-question' && r.question === 'Parking?'));
  assert.equal(packet.records[0].kind, 'idea');
  for (const field of ['records', 'omittedRecords', 'resultFormat', 'instruction', 'jobType']) assert.deepEqual(preview[field], packet[field], field);
  assert.equal(preview.claimKey, undefined);
  const stored = (await store.get(map.id)).jobs.find(j => j.id === packet.jobId);
  assert.equal(stored.included.length, 4, 'three answers and one open question were read');
});

test('a check can be narrowed to chosen answers, and an impossible choice is refused', async () => {
  const { store, map, act } = await answered();
  const chosen = [{ nodeId: map.rootId, questionId: map.nodes[0].questions[0].id }];
  await act({ type: 'request-map-job', jobType: 'check-answers', selection: chosen });
  const packet = await store.claim('test');
  assert.deepEqual(packet.records.filter(r => r.kind === 'answer').map(r => r.answer), ['Nothing at all.']);
  await assert.rejects(act({ type: 'request-map-job', jobType: 'check-answers', selection: [{ nodeId: map.rootId, questionId: 'q-missing' }] }), /not a saved answer/);
});

test('invalid results are refused and the map stays as it was', async () => {
  const { store, map, act } = await answered();
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  const packet = await store.claim('test');
  const before = await readFile(store.file(map.id), 'utf8');
  const ref = { nodeId: map.rootId, questionId: map.nodes[0].questions[0].id };
  for (const [result, message] of [
    [{ findings: [finding([ref], { category: 'wrong-answer' })] }, /category/],
    [{ findings: Array.from({ length: 13 }, () => finding([ref])) }, /at most 12/],
    [{ findings: [finding([{ nodeId: map.rootId, questionId: 'q-elsewhere' }])] }, /was not read/],
    [{ findings: [finding([])] }, /1–8/],
  ]) await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, result), error => error.status === 400 && message.test(error.message), String(message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('a valid result becomes a proposal to review and changes nothing else', async () => {
  const { store, map, act } = await answered();
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  const packet = await store.claim('test');
  const before = await store.get(map.id);
  const refs = [{ nodeId: map.rootId, questionId: map.nodes[0].questions[0].id }, { nodeId: map.rootId, questionId: map.nodes[0].questions[1].id }];
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'One tension.', findings: [finding(refs), { ...finding([refs[1]]), category: 'untested-assumption' }] });
  for (const field of ['nodes', 'edges', 'growth']) assert.deepEqual(saved[field], before[field], field);
  const [proposal] = saved.proposals;
  assert.equal(proposal.type, 'check-answers'); assert.equal(proposal.items.length, 2);
  assert.ok(proposal.items.every(item => item.review === 'unreviewed'));
  // With answer certainty, a "tension" that rests on an answer not Decided is really an unresolved choice.
  assert.equal(proposal.items[0].category, 'unresolved-choice');
  saved = await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'accepted' });
  saved = await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[1].id, decision: 'dismissed' });
  const reread = await new Store(store.directory).get(map.id);
  assert.deepEqual(reread.proposals[0].items.map(item => item.review), ['accepted', 'dismissed'], 'decisions survive a restart');
  assert.deepEqual(reread.nodes, before.nodes, 'keeping a point never changes an answer');
  assert.match(mapBrief(saved).markdown, /Agent reviews waiting for you — not conclusions/);
});

test('revising a referenced idea marks the check stale', async () => {
  const { store, map, act, venue } = await answered();
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  const packet = await store.claim('test');
  const ref = { nodeId: venue.id, questionId: map.nodes[1].questions[0].id };
  await store.complete(map.id, packet.jobId, packet.claimKey, { findings: [finding([ref])] });
  assert.equal(publicMap(await store.get(map.id)).proposals[0].stale, false);
  await act({ type: 'revise', nodeId: venue.id, body: 'A different venue question.' });
  assert.equal(publicMap(await store.get(map.id)).proposals[0].stale, true);
});

test('failing, stopping or restarting a check leaves every idea alone and never reruns it', async () => {
  const { store, map, act } = await answered();
  const before = (await store.get(map.id)).nodes;
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  let packet = await store.claim('test');
  await store.fail(map.id, packet.jobId, packet.claimKey, 'Could not finish.');
  let saved = await act({ type: 'request-map-job', jobType: 'check-answers' });
  saved = await act({ type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  await act({ type: 'request-map-job', jobType: 'check-answers' });
  packet = await store.claim('test');
  const restarted = new Store(store.directory);
  await restarted.recover();
  saved = await restarted.get(map.id);
  assert.deepEqual(saved.nodes.map(n => n.status), before.map(n => n.status));
  assert.equal(await restarted.claim('test'), null, 'an interrupted check is not rerun by itself');
});

test('the browser can preview a check without starting it', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'check-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const map = await app.store.create({ title: 'Workshop', idea: 'Plan it.' });
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const get = route => fetch(app.address + '/api' + route, { headers: { Authorization: `Bearer ${token}` } });
    const response = await get(`/maps/${map.id}/job-preview?type=check-answers`);
    assert.equal(response.status, 200);
    const preview = await response.json();
    assert.equal(preview.jobType, 'check-answers'); assert.equal(preview.claimKey, undefined);
    assert.equal((await get(`/maps/${map.id}/job-preview?type=nope`)).status, 400);
    assert.equal((await app.store.get(map.id)).jobs.filter(j => j.type).length, 0, 'previewing queues nothing');
  } finally { await app.close(); }
});

// Map tools' Check answers in the browser, with a small fake page.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
test('Map tools checks chosen answers, stops and reviews through the app, and redraws only while open', async () => {
  const elements = {}, element = id => (elements[id] ??= { id, innerHTML: '', open: false, handlers: {}, addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }, showModal() { this.open = true; }, close() { this.open = false; } });
  const boxes = [{ dataset: { choiceNode: 'root', choiceQuestion: 'q-1' } }];
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), querySelectorAll: () => boxes };
  const calls = [], routes = [], map = { id: 'map-1', revision: 2, rootId: 'root', nodes: [{ id: 'root', title: 'Root <a>', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }] }], jobs: [], proposals: [] }; let opened = 0;
  try {
    const tools = toolsDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; }, api: async route => { routes.push(route); return { records: [], omittedRecords: [] }; }, esc, toast: () => {}, listening: () => false, onOpen: () => opened++ });
    await tools.mapChanged();
    assert.equal(routes.length, 0, 'nothing drawn while closed');
    element('show-tools').handlers.click[0]();
    assert.equal(element('tools-dialog').open, true); assert.equal(opened, 1);
    assert.match(element('tools-choices').innerHTML, /<input type="checkbox" data-choice-node="root" data-choice-question="q-1"> Who &lt;edits&gt;\?/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(routes, ['/maps/map-1/job-preview?type=check-answers']); assert.match(element('tools-body').innerHTML, /data-check-answers/);
    const click = dataset => element('tools-dialog').handlers.click[0]({ target: { closest: () => ({ dataset, disabled: false }) } });
    await click({ checkAnswers: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: 'check-answers', selection: [{ nodeId: 'root', questionId: 'q-1' }] }]);
    await click({ cancelJob: 'job-1' }); assert.deepEqual(calls.at(-1), [null, 'cancel-job', { jobId: 'job-1' }]);
    await click({ reviewItem: 'item-1', proposal: 'proposal-1', decision: 'dismissed' }); assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'dismissed' }]);
    await click({ select: 'root' }); assert.equal(element('tools-dialog').open, false, 'a reference closes it for the page to open that idea');
  } finally { delete globalThis.document; }
});
