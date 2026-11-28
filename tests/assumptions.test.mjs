import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { downstreamOf } from '../skills/explore/assets/graph.js';
import { assumptionRegister, assumptionsHtml } from '../skills/explore/assets/assumptions.js';
import { assumptionsDialog } from '../skills/explore/assets/assumptions-dialog.js';

// The assumptions register (K6, #53). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

async function asked(questions = ['Who decides?', 'When?'], extra = {}) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'assumptions-')), 'ideas'));
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions, ...extra });
  return { store, map: await store.get(map.id) };
}
const act = async (store, mapId, input) => store.action(mapId, { expectedRevision: (await store.get(mapId)).revision, ...input });
const answer = (store, map, question, text, answerState) => act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: question.id, answer: text, answerState });

test('a result can record the agent\'s interpretations; invalid ones reject it unchanged, and a stale result keeps them on its job', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'assumptions-')), 'ideas'));
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  let job = await store.claim('test');
  const before = await readFile(store.file(map.id), 'utf8');
  // A question keeps the branch open, so its premise can still be revised.
  const deliver = assumptions => store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', assumptions, questions: ['Which phones?'] });
  for (const [bad, message] of [[[{ statement: 'x' }], /what would change/i], [{ statement: 'x' }, /must be a list/], [[{ statement: '', wouldChangeIf: 'y' }], /statement is required/i],
    [[{ statement: 'x'.repeat(601), wouldChangeIf: 'y' }], /at most 600/], [Array.from({ length: 9 }, () => ({ statement: 's', wouldChangeIf: 'w' })), /at most 8/], [['text'], /must be an object/]]) {
    await assert.rejects(deliver(bad), error => error.status === 400 && message.test(error.message), JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  let saved = await deliver([{ statement: 'Volunteers sync once a day.', wouldChangeIf: 'Field reports show weekly syncs.' }]);
  assert.deepEqual(saved.nodes[0].assumptions, [{ statement: 'Volunteers sync once a day.', wouldChangeIf: 'Field reports show weekly syncs.' }]);
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /## Interpretations\n\n_The agent's interpretations: unverified\._\n\n- Volunteers sync once a day\.\n  - Would change if: Field reports show weekly syncs\./);
  // A later result without them clears them, like the rest of the findings.
  saved = await act(store, map.id, { type: 'revise', nodeId: map.rootId, body: 'Works offline, in the field.' });
  assert.equal(saved.nodes[0].assumptions, undefined, 'a revised premise clears the old interpretations');
  saved = await act(store, map.id, { type: 'activate', nodeId: map.rootId }); // Its old questions belong to the earlier premise.
  job = await store.claim('test');
  await act(store, map.id, { type: 'revise', nodeId: map.rootId, body: 'Changed while it ran.' }); // The running result goes stale.
  saved = await deliver([{ statement: 'Stale reading.', wouldChangeIf: 'Anything.' }]);
  assert.equal(saved.nodes[0].assumptions, undefined, 'a stale result does not apply them');
  assert.deepEqual(saved.jobs.find(item => item.id === job.jobId).result.assumptions, [{ statement: 'Stale reading.', wouldChangeIf: 'Anything.' }], 'they stay on its job');
});

test('the user can say what would disprove an assumption, on a finished branch too, without changing the answer', async () => {
  const { store, map } = await asked(['Who decides?']);
  const [q] = map.nodes[0].questions;
  await answer(store, map, q, 'The team lead.', 'assumption');
  const job = await store.claim('test'); // The answer continues the branch; its next result finishes it.
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Finished.' });
  let saved = await act(store, map.id, { type: 'accept', nodeId: map.rootId });
  const revision = saved.nodes[0].contentRevision;
  saved = await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: '  Two leads disagree in a pilot.  ' });
  assert.equal(saved.nodes[0].questions[0].disproveIf, 'Two leads disagree in a pilot.', 'allowed on a finished, accepted branch');
  assert.equal(saved.nodes[0].contentRevision, revision, 'an annotation, not a change of content'); assert.equal(saved.nodes[0].questions[0].answer, 'The team lead.');
  assert.equal(saved.nodes[0].reviewState, 'accepted', 'the finding stays accepted'); assert.equal(saved.history.at(-1).type, 'disprove-if-set');
  saved = await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: 'A pilot shows two leads.' });
  assert.equal(saved.nodes[0].questions[0].disproveIf, 'A pilot shows two leads.', 'edited');
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /_Certainty: Assumption_\n\n_Would be disproved if: A pilot shows two leads\._/);
  saved = await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: '' });
  assert.equal(Object.hasOwn(saved.nodes[0].questions[0], 'disproveIf'), false, 'empty text removes it');
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: 'x'.repeat(1001) }), /at most 1000/);
});

test('only a current answer marked Assumption takes a note on what would disprove it', async () => {
  const { store, map } = await asked(['Who decides?', 'When?', 'Where?']);
  const [decided, open] = map.nodes[0].questions;
  await answer(store, map, decided, 'The lead.', 'decided');
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: decided.id, text: 'x' }), error => error.status === 409 && /Assumption/.test(error.message));
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: open.id, text: 'x' }), error => error.status === 409);
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: 'q-none', text: 'x' }), error => error.status === 404);
});

// root ─ a ─ a1, b depends on a; the register reads the map as the app shows it.
const idea = (id, parentId, extra = {}) => ({ id, parentId, kind: 'idea', title: `Idea ${id}`, summary: `Summary ${id}`, status: 'explored', reviewState: 'unreviewed', questions: [], sources: [], ...extra });
const question = (id, answerState, extra = {}) => ({ id, text: `Question ${id}?`, answer: `Answer ${id}.`, answerState, ...extra });
const registerMap = () => ({ id: 'map-1', rootId: 'root', jobs: [], nodes: [
  idea('root', null, { questions: [question('q-root', 'assumption', { disproveIf: 'A field test fails.' }), question('q-decided', 'decided'), question('q-old', 'assumption', { supersededAt: '2026-01-01' }),
    question('q-gone', 'assumption', { dismissedAt: '2026-01-01' }), { id: 'q-open', text: 'Open?', answer: null }] }),
  idea('a', 'root', { assumptions: [{ statement: 'Phones have storage.', wouldChangeIf: 'Most devices are full.' }], stale: true }),
  idea('a1', 'a', { questions: [question('q-a1', 'assumption')] }), idea('b', 'root'), idea('c', 'root', { reviewState: 'cleared', assumptions: [{ statement: 'Cleared.', wouldChangeIf: 'x' }] })],
  edges: [{ from: 'root', to: 'a', type: 'contains' }, { from: 'a', to: 'a1', type: 'contains' }, { from: 'root', to: 'b', type: 'contains' }, { from: 'root', to: 'c', type: 'contains' }, { from: 'b', to: 'a', type: 'depends_on' }] });

test('the register lists current Assumption answers and the agent\'s interpretations, most dependents first, each with what rests on it', () => {
  const map = registerMap(), entries = assumptionRegister(map);
  assert.deepEqual(entries.map(entry => [entry.kind, entry.nodeId, entry.questionId ?? null]), [['answer', 'root', 'q-root'], ['interpretation', 'a', null], ['answer', 'a1', 'q-a1']],
    'decided, superseded, dismissed and open answers never appear; nor do interpretations on a cleared finding');
  const [root, a, a1] = entries;
  assert.deepEqual(root, { kind: 'answer', nodeId: 'root', title: 'Idea root', questionId: 'q-root', question: 'Question q-root?', text: 'Answer q-root.', disproveIf: 'A field test fails.', stale: false, dependents: root.dependents });
  assert.equal(a.text, 'Phones have storage.'); assert.equal(a.disproveIf, 'Most devices are full.'); assert.equal(a.stale, true);
  for (const entry of entries) assert.deepEqual([...entry.dependents].sort(), [...downstreamOf(map, entry.nodeId)].filter(id => id !== entry.nodeId).sort(), `${entry.nodeId}: what a change would reach`);
  assert.deepEqual(root.dependents, ['a', 'b', 'c', 'a1'], 'nearest first, then in reading order'); assert.deepEqual(a.dependents, ['a1', 'b']); assert.deepEqual(a1.dependents, []);
  assert.equal(a1.disproveIf, null);
  map.nodes[0].questions[0].answerState = 'decided';
  assert.equal(assumptionRegister(map).some(entry => entry.questionId === 'q-root'), false, 'marking it Decided removes it');
  assert.deepEqual(assumptionRegister({ id: 'm', rootId: 'r', jobs: [], edges: [], nodes: [idea('r', null)] }), [], 'a map without these fields has an empty register');
});

test('the dialog groups the entries, says what would change each one, and offers a note only on the user\'s own', () => {
  const map = registerMap(), entries = assumptionRegister(map);
  map.nodes[0].questions[0].text = 'Who <decides>?';
  const html = assumptionsHtml(assumptionRegister(map), { esc, live: true, editing: null, map });
  const [yours, agents] = html.split('<h3 class="section-label">Agent interpretations</h3>');
  assert.match(yours, /^<h3 class="section-label">Your assumptions<\/h3>/);
  assert.match(yours, /<p class="assumption-question">Who &lt;decides&gt;\?<\/p><p class="assumption-text">Answer q-root\.<\/p><p class="assumption-change">Would change if: A field test fails\. <button type="button" class="text-button" data-assumption-edit="root q-root">Edit<\/button><\/p>/);
  assert.match(yours, /data-assumption-edit="root q-root">Edit<\/button>/); assert.match(yours, /Would change if: Not stated <button type="button" class="text-button" data-assumption-edit="a1 q-a1">Add<\/button>/);
  assert.match(yours, /<details class="assumption-dependents"><summary>4 ideas rest on this<\/summary><button type="button" class="relationship" data-focus-node="a"><strong>Idea a<\/strong><\/button>/);
  assert.match(yours, /No other ideas rest on this\./); assert.match(agents, /<summary>2 ideas rest on this<\/summary>/);
  assert.match(yours, /data-focus-node="root">Show “Idea root”<\/button><\/article>/);
  assert.match(agents, /An earlier premise changed\. Review this finding before relying on it\./); assert.doesNotMatch(agents, /data-assumption-edit/);
  assert.doesNotMatch(assumptionsHtml(entries, { esc, live: false, editing: null, map }), /data-assumption-edit/, 'read-only history offers no edits');
  const editing = assumptionsHtml(entries, { esc, live: true, editing: 'root q-root', map });
  assert.match(editing, /<textarea id="assumption-disprove" maxlength="1000" rows="3">A field test fails\.<\/textarea>/); assert.match(editing, /data-assumption-remove="root q-root"/);
  const empty = assumptionsHtml([], { esc, live: true, editing: null, map });
  assert.match(empty, /No answers are marked Assumption\./); assert.match(empty, /None recorded\. Your agent records its interpretations in results saved from now on\./);
});

// A small fake DOM for the dialog: elements by ID, with listeners and a modal state.
function fakeDialog({ map, live = () => true, reply = true }) {
  const elements = new Map(), calls = [], toasts = [], chosen = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', open: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, querySelector() { return { focus() {} }; } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const dialog = assumptionsDialog({ act: async (...args) => { calls.push(args); return reply; }, map, live, esc, toast: message => toasts.push(message), focusNode: id => chosen.push(id) });
  const click = dataset => element('assumptions-body').fire('click', { target: { closest: () => ({ dataset }) } });
  return { element, calls, toasts, chosen, dialog, click };
}

test('the dialog opens from Map tools, saves and removes a note through the action, keeps an open editor across map changes, and focuses an idea', async () => {
  let map = registerMap();
  const io = fakeDialog({ map: () => map });
  try {
    io.element('tools-dialog').open = true;
    await io.element('assumptions-open').fire('click');
    assert.equal(io.element('assumptions-dialog').open, true); assert.equal(io.element('tools-dialog').open, false);
    assert.match(io.element('assumptions-summary').textContent, /^Your assumptions: 2 · Agent interpretations: 1\. Opening this never starts work\.$/);
    await io.click({ assumptionEdit: 'a1 q-a1' });
    assert.match(io.element('assumptions-body').innerHTML, /<textarea id="assumption-disprove"/);
    map = { ...map }; io.dialog.mapChanged();
    assert.match(io.element('assumptions-body').innerHTML, /<textarea id="assumption-disprove"/, 'a poll never closes the editor');
    io.element('assumption-disprove').value = 'A second lead appears.';
    await io.click({ assumptionSave: 'a1 q-a1' });
    assert.deepEqual(io.calls.at(-1), ['a1', 'set-disprove-if', { questionId: 'q-a1', text: 'A second lead appears.' }]);
    assert.doesNotMatch(io.element('assumptions-body').innerHTML, /<textarea/); assert.equal(io.toasts.at(-1), 'Saved.');
    await io.click({ assumptionRemove: 'root q-root' });
    assert.deepEqual(io.calls.at(-1), ['root', 'set-disprove-if', { questionId: 'q-root', text: '' }]);
    await io.click({ focusNode: 'a' });
    assert.equal(io.element('assumptions-dialog').open, false); assert.deepEqual(io.chosen, ['a']);
  } finally { delete globalThis.document; }
});

test('the brief has a bounded section of assumptions and interpretations, kept apart from accepted findings', async () => {
  const { store, map } = await asked(Array.from({ length: 5 }, (_, i) => `Question ${i}?`), { assumptions: [{ statement: 'Phones have storage.', wouldChangeIf: 'Most devices are full.' }] });
  const questions = map.nodes[0].questions;
  for (const q of questions.slice(0, 4)) await answer(store, map, q, `Guess ${q.text}`, 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: questions[0].id, text: 'A pilot says otherwise.' });
  let brief = mapBrief(await store.get(map.id)), section = brief.sections.find(s => s.id === 'assumptions');
  assert.equal(section.label, 'Assumptions and interpretations — unverified'); assert.equal(section.total, 5); assert.equal(section.omitted, 0);
  assert.equal(brief.sections.some(s => s.id === 'unsettled'), false, 'the register replaces the old unsettled-answers section');
  assert.match(brief.markdown, /## Assumptions and interpretations — unverified\n/);
  assert.match(brief.markdown, /Your assumption: Guess Question 0\? — question: Question 0\? — would change if: A pilot says otherwise\./);
  assert.match(brief.markdown, /Your assumption: Guess Question 1\? — question: Question 1\? — would change if: not stated/);
  assert.match(brief.markdown, /Agent interpretation: Phones have storage\. — would change if: Most devices are full\./);
  assert.ok(brief.markdown.indexOf('## Assumptions and interpretations') > brief.markdown.indexOf('## Accepted and current findings'), 'its own section');
  await answer(store, map, questions[4], 'Guess five.', 'assumption');
  brief = mapBrief(await store.get(map.id)); section = brief.sections.find(s => s.id === 'assumptions');
  assert.equal(section.total, 6); assert.equal(section.items.length, 5); assert.equal(section.omitted, 1);
  assert.match(brief.markdown, /## Assumptions and interpretations — unverified\n\n(- .*\n){5}_1 more records omitted\./, 'bounded, and says what it left out');
});

test('a pulled map with a malformed note or interpretation is reported, and the register skips what it cannot read', () => {
  const map = { schemaVersion: 1, id: 'map-1', title: 'T', rootId: 'root', edges: [], jobs: [], history: [],
    nodes: [idea('root', null, { questions: [question('q', 'assumption', { disproveIf: 3 })], assumptions: [{ statement: 5 }, 'text', { statement: 'Fine.', wouldChangeIf: 'Readable.' }] })] };
  const { errors } = validateMap(map);
  assert.ok(errors.some(error => /disproveIf/.test(error.at)), 'disproveIf must be text'); assert.ok(errors.some(error => /assumptions/.test(error.at)), 'interpretations must be records of text');
  assert.deepEqual(assumptionRegister(map).map(entry => [entry.kind, entry.disproveIf]), [['answer', null], ['interpretation', 'Readable.']]);
});
