import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { challengeDialogHtml, directionFrom, CHALLENGE } from '../skills/explore/assets/challenge.js';
import { challengeDialog } from '../skills/explore/assets/challenge-dialog.js';

// Challenge decisions (F2, #25). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

// A map with three saved answers on an idea that still has an open question, so its answers can change.
async function setup(store) {
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Depends.', body: 'Sync is the hard part.', questions: ['Who edits notes?', 'How often do teams sync?', 'Which phones?', 'Who pays?'] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input });
  const questions = (await store.get(map.id)).nodes[0].questions;
  for (const [i, answer] of ['The field team.', 'Once a day.', 'Older Android phones.'].entries()) await act({ type: 'answer', questionId: questions[i].id, answer });
  return { map, act, questions };
}
async function memoryStore() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = path.join(await mkdtemp(path.join(root, 'challenge-')), 'ideas');
  return { dir, store: new Store(dir) };
}
const finding = (questions, map, extra = {}) => ({ category: 'assumption', explanation: 'It assumes one team edits each note.', resolution: 'Ask whether two teams ever share a notebook.', refs: [{ nodeId: map.rootId, questionId: questions[0].id }], ...extra });
const content = map => JSON.stringify([map.nodes, map.edges, map.growth]);

test('a challenge needs 1–40 saved, current answers, and its packet holds those and the original idea alone', async () => {
  const { store } = await memoryStore(), { map, act, questions } = await setup(store);
  const before = await store.get(map.id);
  for (const [selection, message] of [[[], /Choose 1 to 40/], [undefined, /Choose 1 to 40/], [[{ nodeId: map.rootId, questionId: questions[3].id }], /not a saved, current answer/],
    [[{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[0].id }], /chosen twice/]]) {
    await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, ...(selection ? { selection } : {}) }), message, message.source);
  }
  assert.equal((await store.get(map.id)).revision, before.revision, 'the map is unchanged');
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[1].id }] });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, CHALLENGE);
  assert.deepEqual(packet.records.map(record => record.kind), ['idea', 'answer']);
  assert.equal(packet.records[1].answer, 'Once a day.'); assert.ok(['status', 'reviewState', 'stale', 'certainty', 'nodeTitle', 'question'].every(key => key in packet.records[1]));
  const text = JSON.stringify(packet);
  assert.equal(text.includes('The field team.'), false, 'an unselected answer never appears'); assert.equal(text.includes('Older Android phones.'), false);
  assert.match(packet.instruction, /good faith/); assert.match(packet.instruction, /Do not manufacture objections/); assert.match(packet.instruction, /never ask the user to change an answer/);
  // A premise revision sets the idea's answers aside: an earlier premise's answer cannot be chosen.
  await store.fail(map.id, packet.jobId, packet.claimKey, 'Stopped for the test.');
  await act({ type: 'revise', body: 'Notes for one field team.' });
  assert.ok((await store.get(map.id)).nodes[0].questions[1].supersededAt);
  await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[1].id }] }), /not a saved, current answer/);
});

test('results are checked: four categories, refs from what was read, at most 12, valid sources; a valid one adds one unreviewed proposal and changes no idea', async () => {
  const { store } = await memoryStore(), { map, act, questions } = await setup(store);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[1].id }] });
  const packet = await store.claim('agent', map.id), before = await readFile(store.file(map.id), 'utf8'), shape = content(await store.get(map.id));
  const good = finding(questions, map);
  for (const [bad, message] of [[{ findings: [{ ...good, category: 'objection' }] }, /category must be/], [{ findings: [{ ...good, refs: [{ nodeId: map.rootId, questionId: questions[2].id }] }] }, /not read in this challenge/],
    [{ findings: Array.from({ length: 13 }, () => good) }, /at most 12/], [{ findings: [{ ...good, sources: [{ title: 'T', url: 'javascript:alert(1)', note: 'N' }] }] }, /URL|http/i],
    [{ findings: [{ ...good, sources: Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, url: `https://example.org/${i}`, note: 'N' })) }] }, /at most 3 sources/],
    [{ findings: [{ ...good, refs: [] }] }, /cites 1–8/], [{ findings: [{ ...good, explanation: 'x'.repeat(1001) }] }, /at most 1000/], [{ findings: [{ ...good, severity: 'high' }] }, /does not take: severity/], [{ findings: [], summary: 'S' }, /remove summary/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { findings: [good, { ...good, category: 'evidence-gap', sources: [{ title: 'Field survey', url: 'https://example.org/survey', note: 'Teams share notebooks.' }] }] });
  const proposal = saved.proposals.at(-1);
  assert.equal(proposal.type, CHALLENGE); assert.equal(saved.proposals.length, 1);
  assert.deepEqual(proposal.items.map(item => [item.category, item.review]), [['assumption', 'unreviewed'], ['evidence-gap', 'unreviewed']]);
  assert.deepEqual(proposal.items[1].sources, [{ title: 'Field survey', url: 'https://example.org/survey', note: 'Teams share notebooks.' }]); assert.equal(proposal.items[0].sources, undefined);
  assert.equal(content(saved), shape, 'ideas, questions, links and growth are unchanged');
  const empty = await (async () => { await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }] }); const next = await store.claim('agent', map.id); return store.complete(map.id, next.jobId, next.claimKey, { findings: [] }); })();
  assert.deepEqual(empty.proposals.at(-1).items, [], 'nothing that matters is a fine result');
});

test('keep and dismiss persist after a reload; changing a challenged answer marks the proposal stale', async () => {
  const { dir, store } = await memoryStore(), { map, act, questions } = await setup(store);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }] });
  const packet = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { findings: [finding(questions, map), finding(questions, map, { category: 'alternative' })] });
  const proposal = saved.proposals.at(-1);
  await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'accepted' });
  await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[1].id, decision: 'dismissed' });
  const reloaded = await new Store(dir).get(map.id);
  assert.deepEqual(reloaded.proposals.at(-1).items.map(item => item.review), ['accepted', 'dismissed']);
  assert.notEqual(store.view(reloaded).proposals.at(-1).stale, true);
  await act({ type: 'change-answer', questionId: questions[0].id, answer: 'Two field teams.' });
  assert.equal(store.view(await store.get(map.id)).proposals.at(-1).stale, true);
});

test('the browser previews exactly the answers it will send', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const app = await startServer({ workspace: await mkdtemp(path.join(root, 'challenge-http-')), port: 0 });
  try {
    const { map, questions } = await setup(app.store);
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const selection = [{ nodeId: map.rootId, questionId: questions[1].id }];
    const preview = await (await fetch(`${app.address}/api/maps/${map.id}/job-preview?type=${CHALLENGE}&selection=${encodeURIComponent(JSON.stringify(selection))}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    await app.store.action(map.id, { expectedRevision: (await app.store.get(map.id)).revision, type: 'request-map-job', jobType: CHALLENGE, selection });
    const claimed = await app.store.claim('agent', map.id);
    assert.deepEqual(preview.records, claimed.records, 'the preview is what the agent reads'); assert.equal(JSON.stringify(preview).includes('The field team.'), false);
  } finally { await app.close(); }
});

const fixture = () => {
  const map = { id: 'map-1', revision: 2, rootId: 'root', nodes: [{ id: 'root', title: 'Root <a>', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }] }], jobs: [], proposals: [] };
  map.proposals.push({ id: 'proposal-1', type: CHALLENGE, items: [{ id: 'item-1', category: 'assumption', explanation: 'It <assumes> one team.', resolution: 'Ask.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'unreviewed' },
    { id: 'item-2', category: 'evidence-gap', explanation: 'No survey.', resolution: 'Survey.', refs: [{ nodeId: 'root', questionId: 'q-1' }], sources: [{ title: 'Survey <1>', url: 'https://example.org/s', note: 'Says so.' }], review: 'accepted' },
    { id: 'item-3', category: 'counterargument', explanation: 'Teams rotate.', resolution: 'Check rosters.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'dismissed' }] });
  return map;
};

test('the dialog labels each hypothesis and says when it is reasoning; a kept one can be explored as a direction', () => {
  const map = fixture(), html = challengeDialogHtml({ map, esc, listening: false });
  assert.match(html, /<h3 class="section-label">Hypotheses to consider<\/h3><p class="form-note">Your agent's challenge, not findings: your answers stay as they are\.<\/p>/);
  assert.match(html, /<strong>Hidden assumption<\/strong><p>It &lt;assumes&gt; one team\.<\/p><p class="form-note">What would settle it: Ask\.<\/p>/);
  assert.match(html, /data-select="root">Root &lt;a&gt; · Who &lt;edits&gt;\?<\/button>/, 'refs select the idea');
  assert.match(html, /<p class="form-note">Reasoning, not research\.<\/p>/); assert.match(html, /<a href="https:\/\/example\.org\/s" target="_blank" rel="noopener noreferrer">Survey &lt;1&gt;<\/a> · Says so\./);
  assert.match(html, /data-challenge-review="item-1" data-proposal="proposal-1" data-decision="accepted">Keep<\/button>/);
  assert.match(html, /Kept\. <button type="button" class="text-button" data-challenge-direction="item-2">Explore this as a direction<\/button>/); assert.doesNotMatch(html, /data-challenge-direction="item-1"/, 'only a kept one'); assert.doesNotMatch(html, /data-challenge-direction="item-3"/); assert.match(html, /<strong>Counter-argument<\/strong>[\s\S]*<p class="form-note">Dismissed\.<\/p>/);
  assert.match(html, /<input type="checkbox" data-challenge-node="root" data-challenge-question="q-1"> Who &lt;edits&gt;\?/); assert.match(html, /data-challenge-preview="" disabled>/);
  assert.match(challengeDialogHtml({ map: { ...map, proposals: [{ ...map.proposals[0], stale: true }] }, esc, listening: false }), /Some of the challenged answers changed since/);
  const history = challengeDialogHtml({ map, esc, listening: false, live: false });
  assert.match(history, /return to the live map/); assert.doesNotMatch(history, /data-challenge-(review|preview|direction)/);
  assert.deepEqual(directionFrom(map.proposals[0].items[1]), { nodeId: 'root', title: 'Evidence gap: No survey.', body: 'No survey.\n\nWhat would settle it: Survey.' });
});

function fakeDialog({ map, act, api, explored }) {
  const elements = new Map(), focused = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false, addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); }, contains: () => false,
        querySelector(selector) {
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1)}"`) : this.innerHTML.includes(selector.slice(1, -1).replace(/^([\w-]+)$/, '$1='));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), activeElement: null };
  const dialog = challengeDialog({ map, act, api, esc, toast: () => {}, live: () => true, listening: () => false, select: () => {}, exploreAsDirection: direction => explored.push(direction) });
  const body = element('challenge-body');
  const click = dataset => body.fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  return { element, body, dialog, click, focused };
}

test('the dialog previews and queues the chosen answers, and Explore this as a direction prefills the form without queueing anything', async () => {
  const map = fixture(), calls = [], routes = [], explored = [];
  const io = fakeDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; }, api: async route => { routes.push(route); return { records: [{ kind: 'idea' }, { kind: 'answer' }], mapRevision: map.revision }; }, explored });
  try {
    await io.element('challenge-open').fire('click');
    assert.equal(io.element('challenge-dialog').open, true); assert.equal(io.focused.at(-1), '[data-challenge-review]');
    await io.body.fire('change', { target: { closest: () => ({ dataset: { challengeNode: 'root', challengeQuestion: 'q-1' }, checked: true }) } });
    await io.click({ challengePreview: '' });
    assert.equal(routes.at(-1), `/maps/map-1/job-preview?type=challenge&selection=${encodeURIComponent(JSON.stringify([{ nodeId: 'root', questionId: 'q-1' }]))}`);
    assert.match(io.body.innerHTML, /Your agent will read 1 answer and the original idea, nothing else/); assert.equal(io.focused.at(-1), '[data-challenge-send]');
    await io.click({ challengeSend: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: CHALLENGE, selection: [{ nodeId: 'root', questionId: 'q-1' }] }]);
    await io.click({ challengeReview: 'item-1', proposal: 'proposal-1', decision: 'dismissed' });
    assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'dismissed' }]);
    const before = calls.length;
    await io.click({ challengeDirection: 'item-2' });
    assert.deepEqual(explored, [{ nodeId: 'root', title: 'Evidence gap: No survey.', body: 'No survey.\n\nWhat would settle it: Survey.' }]); assert.equal(calls.length, before, 'nothing queued or written');
    assert.equal(io.element('challenge-dialog').open, false, 'the dialog makes way for the form');
  } finally { delete globalThis.document; }
});

test('a direction from a hypothesis is added only when the user submits Add a direction, and stays inactive', async () => {
  const { store } = await memoryStore(), { map, act } = await setup(store);
  const jobs = (await store.get(map.id)).jobs.length;
  const direction = directionFrom({ category: 'alternative', explanation: 'Paper backup.', resolution: 'Test a flat phone.', refs: [{ nodeId: map.rootId, questionId: 'q' }] });
  const saved = await act({ type: 'suggest', title: direction.title, body: direction.body });
  const added = saved.nodes.at(-1);
  assert.deepEqual([added.title, added.status, added.parentId], ['Overlooked alternative: Paper backup.', 'suggested', map.rootId]); assert.equal(saved.jobs.length, jobs, 'no job queued');
});
