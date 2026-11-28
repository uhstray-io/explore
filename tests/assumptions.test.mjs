import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { downstreamOf } from '../skills/explore/assets/graph.js';
import { assumptionRegister, assumptionsHtml, dependentsHtml, interpretationsOf } from '../skills/explore/assets/assumptions.js';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
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

test('the register lists current Assumption answers and the agent\'s interpretations, most dependents first, each with how much rests on it', () => {
  const map = registerMap(), entries = assumptionRegister(map);
  assert.deepEqual(entries.map(entry => [entry.kind, entry.nodeId, entry.questionId ?? null]), [['answer', 'root', 'q-root'], ['interpretation', 'a', null], ['answer', 'a1', 'q-a1']],
    'decided, superseded, dismissed and open answers never appear; nor do interpretations on a cleared finding');
  const [root, a, a1] = entries;
  assert.deepEqual(root, { kind: 'answer', nodeId: 'root', title: 'Idea root', questionId: 'q-root', question: 'Question q-root?', text: 'Answer q-root.', wouldChangeIf: 'A field test fails.', stale: false, dependents: 4 });
  assert.equal(a.text, 'Phones have storage.'); assert.equal(a.wouldChangeIf, 'Most devices are full.'); assert.equal(a.stale, true); assert.equal(a1.wouldChangeIf, null);
  for (const entry of entries) assert.equal(entry.dependents, downstreamOf(map, entry.nodeId).size - 1, entry.nodeId + ': what a change would reach');
  assert.match(dependentsHtml(map, 'root', { esc }), /^<button type="button" class="relationship" data-focus-node="a"><strong>Idea a<\/strong><\/button><button type="button" class="relationship" data-focus-node="b">/, 'listed nearest first when opened');
  map.nodes[0].questions[0].answerState = 'decided';
  assert.equal(assumptionRegister(map).some(entry => entry.questionId === 'q-root'), false, 'marking it Decided removes it');
  assert.deepEqual(assumptionRegister({ id: 'm', rootId: 'r', jobs: [], edges: [], nodes: [idea('r', null)] }), [], 'a map without these fields has an empty register');
  // Equal counts keep reading order (r, p, q, z), not the order the map lists the ideas in (r, z, p, q).
  const ties = { id: 'm', rootId: 'r', jobs: [], edges: [{ from: 'r', to: 'p', type: 'contains' }, { from: 'r', to: 'q', type: 'contains' }, { from: 'q', to: 'z', type: 'contains' }],
    nodes: [idea('r', null), idea('z', 'q', { questions: [question('q-z', 'assumption')] }), idea('p', 'r', { questions: [question('q-p', 'assumption')] }), idea('q', 'r')] };
  assert.deepEqual(assumptionRegister(ties).map(entry => entry.nodeId), ['p', 'z']);
});

test('the dialog groups the entries, says what would change each one, and offers a note only on the user\'s own', () => {
  const map = registerMap();
  Object.assign(map.nodes[0].questions[0], { text: 'Who <decides>?', answer: 'The <lead>.', disproveIf: 'A <test> fails.' });
  Object.assign(map.nodes[1], { title: 'Storage <a>' }); map.nodes[1].assumptions[0].statement = 'Phones have <storage>.';
  const entries = assumptionRegister(map), html = assumptionsHtml(entries, { esc, live: true, editing: null });
  const [yours, agents] = html.split('<h3 class="section-label">Agent interpretations</h3>');
  assert.match(yours, /^<h3 class="section-label">Your assumptions<\/h3>/); assert.doesNotMatch(html, /<(lead|test|storage|a)>/, 'everything is escaped');
  assert.match(yours, /<p class="assumption-question">Who &lt;decides&gt;\?<\/p><p class="assumption-text">The &lt;lead&gt;\.<\/p><p class="assumption-change">Would change if: A &lt;test&gt; fails\. <button type="button" class="text-button" data-assumption-edit="root q-root" aria-label="Edit what would change your answer to: Who &lt;decides&gt;\?">Edit<\/button><\/p>/);
  assert.match(yours, /Would change if: Not stated <button type="button" class="text-button" data-assumption-edit="a1 q-a1" aria-label="Add what would change your answer to: Question q-a1\?">Add<\/button>/);
  assert.match(yours, /<details class="assumption-dependents" data-dependents="root"><summary>4 ideas rest on this<\/summary><div class="assumption-dependent-list"><\/div><\/details>/);
  assert.match(yours, /No other ideas rest on this\./); assert.match(agents, /<summary>2 ideas rest on this<\/summary>/);
  assert.match(yours, /data-focus-node="root">Show “Idea root”<\/button><\/article>/); assert.match(agents, /Show “Storage &lt;a&gt;”/);
  assert.match(agents, /<p class="assumption-text">Phones have &lt;storage&gt;\.<\/p>/); assert.match(agents, /Needs review: an earlier premise changed\./); assert.doesNotMatch(agents, /data-assumption-edit/);
  const readOnly = assumptionsHtml(entries, { esc, live: false, editing: null });
  assert.doesNotMatch(readOnly, /data-assumption-edit/, 'read-only history offers no edits'); assert.doesNotMatch(readOnly, /rest on this/, 'nor impact, which is live-only');
  const editing = assumptionsHtml(entries, { esc, live: true, editing: 'root q-root' });
  assert.match(editing, /<textarea id="assumption-disprove" maxlength="1000" rows="3">A &lt;test&gt; fails\.<\/textarea>/); assert.match(editing, /data-assumption-remove="root q-root"/);
  assert.doesNotMatch(assumptionsHtml(entries, { esc, live: true, editing: 'a1 q-a1' }), /data-assumption-remove/, 'nothing to remove without a note');
  const empty = assumptionsHtml([], { esc, live: true, editing: null });
  assert.match(empty, /No answers are marked Assumption\./); assert.match(empty, /None recorded\. Your agent records its interpretations in results saved from now on\./);
});

// A small fake DOM for the dialog: elements by ID, with listeners, a modal state and focus.
function fakeDialog({ map, note = () => '', reply = true }) {
  const elements = new Map(), calls = [], toasts = [], chosen = [], focused = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      let html = '';
      elements.set(id, { id, textContent: '', value: '', open: false, writes: 0,
        get innerHTML() { return html; }, set innerHTML(value) { html = value; this.writes++; },
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(id); },
        querySelector(selector) { return { focus() { focused.push(selector); } }; } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const state = { reply };
  const dialog = assumptionsDialog({ act: async (...args) => { calls.push(args); return state.reply; }, map, note, esc, toast: message => toasts.push(message), focusNode: id => chosen.push(id) });
  const click = dataset => element('assumptions-body').fire('click', { target: { closest: () => ({ dataset }) } });
  return { element, calls, toasts, chosen, focused, dialog, click, state };
}

test('the dialog opens from Map tools, saves and removes a note, keeps an open editor and the page across map changes, and focuses an idea', async () => {
  let map = registerMap();
  const io = fakeDialog({ map: () => map });
  try {
    io.element('tools-dialog').open = true;
    await io.element('assumptions-open').fire('click');
    assert.equal(io.element('assumptions-dialog').open, true); assert.equal(io.element('tools-dialog').open, false);
    assert.match(io.element('assumptions-summary').textContent, /^Your assumptions: 2 · Agent interpretations: 1\. Opening this never starts work\.$/);
    const writes = io.element('assumptions-body').writes;
    map = { ...map }; io.dialog.mapChanged();
    assert.equal(io.element('assumptions-body').writes, writes, 'a refresh that changes nothing leaves the page as it is');
    await io.click({ assumptionEdit: 'a1 q-a1' });
    assert.match(io.element('assumptions-body').innerHTML, /<textarea id="assumption-disprove"/);
    map = { ...map }; io.dialog.mapChanged();
    assert.match(io.element('assumptions-body').innerHTML, /<textarea id="assumption-disprove"/, 'a poll never closes the editor');
    await io.click({ assumptionCancel: 'a1 q-a1' });
    assert.doesNotMatch(io.element('assumptions-body').innerHTML, /<textarea/, 'Cancel closes it'); assert.equal(io.focused.at(-1), '[data-assumption-edit="a1 q-a1"]', 'focus returns to Add');
    await io.click({ assumptionEdit: 'a1 q-a1' });
    io.element('assumption-disprove').value = 'A second lead appears.'; io.state.reply = false;
    await io.click({ assumptionSave: 'a1 q-a1' });
    assert.match(io.element('assumptions-body').innerHTML, /<textarea id="assumption-disprove"/, 'a refused save keeps the editor open'); assert.deepEqual(io.toasts, []);
    io.state.reply = true;
    await io.click({ assumptionSave: 'a1 q-a1' });
    assert.deepEqual(io.calls.at(-1), ['a1', 'set-disprove-if', { questionId: 'q-a1', text: 'A second lead appears.' }]);
    assert.doesNotMatch(io.element('assumptions-body').innerHTML, /<textarea/); assert.equal(io.toasts.at(-1), 'Saved.'); assert.equal(io.focused.at(-1), '[data-assumption-edit="a1 q-a1"]');
    await io.click({ assumptionRemove: 'root q-root' });
    assert.deepEqual(io.calls.at(-1), ['root', 'set-disprove-if', { questionId: 'q-root', text: '' }]); assert.equal(io.toasts.at(-1), 'Removed.');
    const list = { innerHTML: '' }, details = { open: true, dataset: { dependents: 'a' }, querySelector: () => list };
    await io.element('assumptions-body').fire('toggle', { target: details });
    assert.match(list.innerHTML, /data-focus-node="a1"><strong>Idea a1<\/strong>/, 'what rests on an entry is listed when opened');
    await io.click({ focusNode: 'a' });
    assert.equal(io.element('assumptions-dialog').open, false); assert.deepEqual(io.chosen, ['a']);
  } finally { delete globalThis.document; }
});

test('in growth history or a saved version the dialog shows the inspector\'s read-only note and offers no edits', async () => {
  const map = registerMap(), io = fakeDialog({ map: () => map, note: () => 'Read-only growth history. These are today’s findings and status, not a past version of the research.' });
  try {
    await io.element('assumptions-open').fire('click');
    assert.match(io.element('assumptions-body').innerHTML, /^<p class="form-note">Read-only growth history\. [^<]*<\/p><h3 class="section-label">Your assumptions<\/h3>/);
    assert.doesNotMatch(io.element('assumptions-body').innerHTML, /data-assumption-edit/);
  } finally { delete globalThis.document; }
});

test('the brief has a bounded section of assumptions and interpretations, kept apart from accepted findings and scoped to a branch', async () => {
  const { store, map } = await asked(Array.from({ length: 5 }, (_, i) => 'Question ' + i + '?'), { assumptions: [{ statement: 'Phones have storage.', wouldChangeIf: 'Most devices are full.' }] });
  const questions = map.nodes[0].questions;
  for (const q of questions.slice(0, 4)) await answer(store, map, q, 'Guess ' + q.text, 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: questions[0].id, text: 'A pilot says otherwise.' });
  let brief = mapBrief(await store.get(map.id)), section = brief.sections.find(s => s.id === 'assumptions');
  assert.equal(section.label, 'Assumptions and interpretations — unverified'); assert.equal(section.total, 5); assert.equal(section.omitted, 0);
  assert.equal(brief.sections.some(s => s.id === 'unsettled'), false, 'the register replaces the old unsettled-answers section');
  assert.match(brief.markdown, /— question q-[0-9a-f]+: User assumption — Question: Question 0\? Answer: Guess Question 0\? — would change if: A pilot says otherwise\./);
  assert.match(brief.markdown, /User assumption — Question: Question 1\? Answer: Guess Question 1\? — would change if: not stated/);
  assert.match(brief.markdown, /: Agent interpretation — Phones have storage\. — would change if: Most devices are full\./);
  assert.ok(brief.markdown.indexOf('## Assumptions and interpretations') > brief.markdown.indexOf('## Accepted and current findings'), 'its own section');
  await answer(store, map, questions[4], 'x'.repeat(400), 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: questions[4].id, text: 'A long answer still shows this.' });
  brief = mapBrief(await store.get(map.id)); section = brief.sections.find(s => s.id === 'assumptions');
  assert.equal(section.total, 6); assert.equal(section.items.length, 5); assert.equal(section.omitted, 1);
  assert.match(brief.markdown, /## Assumptions and interpretations — unverified\n\n(- .*\n){5}_1 more records omitted\./, 'bounded, and says what it left out');
  const saved = await act(store, map.id, { type: 'suggest', nodeId: map.rootId, title: 'Elsewhere', body: 'Another branch.' });
  assert.equal(mapBrief(saved, saved.nodes.at(-1).id).sections.find(s => s.id === 'assumptions').total, 0, 'a branch brief lists only its branch');
});

test('a long answer keeps what would change it in the brief', () => {
  const nodes = [{ id: 'root', parentId: null, kind: 'idea', title: 'Root', summary: 'S', status: 'awaiting-answer', reviewState: 'unreviewed', sources: [],
    questions: [{ id: 'q-1', text: 'Who?', answer: 'x'.repeat(400), answerState: 'assumption', disproveIf: 'A pilot disagrees.' }] }];
  const brief = mapBrief({ id: 'map-1', title: 'T', revision: 1, rootId: 'root', nodes, edges: [], jobs: [] });
  assert.match(brief.markdown, /— would change if: A pilot disagrees\./);
});

test('the next packet carries the interpretations so a continuing branch can resend them, and a section read lists them', async () => {
  const { store, map } = await asked(['Who decides?'], { assumptions: [{ statement: 'Volunteers sync daily.', wouldChangeIf: 'Weekly syncs in reports.' }] });
  await answer(store, map, map.nodes[0].questions[0], 'The lead.', 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, text: 'Two leads disagree.' });
  const packet = await store.claim('test');
  assert.deepEqual(packet.selected.assumptions, [{ statement: 'Volunteers sync daily.', wouldChangeIf: 'Weekly syncs in reports.' }]);
  assert.match(packet.instruction, /--section options\|limitations\|claims\|assumptions and resend in full those that still hold/);
  assert.equal(packet.selected.questions[0].disproveIf, 'Two leads disagree.', 'the user\'s note reaches the agent');
  const read = contextExcerpt(await store.get(map.id), map.rootId, { section: 'assumptions' });
  assert.match(read.excerpt, /- Volunteers sync daily\.\n  - Would change if: Weekly syncs in reports\./);
});

test('a note is refused on a superseded or dismissed answer and on a change that changes nothing, and records no version then', async () => {
  const { store, map } = await asked(['Who decides?', 'When?']);
  const [first, second] = map.nodes[0].questions;
  await answer(store, map, first, 'The lead.', 'assumption'); await answer(store, map, second, 'Soon.', 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: first.id, text: 'A pilot disagrees.' });
  const before = (await store.get(map.id)).revision;
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: first.id, text: ' A pilot disagrees. ' }), error => error.status === 409 && /Nothing changed/.test(error.message));
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: second.id, text: '' }), error => error.status === 409 && /Nothing changed/.test(error.message), 'removing a note that is not there');
  assert.equal((await store.get(map.id)).revision, before, 'no save, so no version');
  const raw = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  raw.nodes[0].questions[1].supersededAt = '2026-01-01T00:00:00.000Z'; raw.nodes[0].questions[0].dismissedAt = '2026-01-01T00:00:00.000Z';
  const { writeFile } = await import('node:fs/promises'); await writeFile(store.file(map.id), JSON.stringify(raw));
  for (const q of [first, second]) await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: 'New note.' }), error => error.status === 409 && /Assumption/.test(error.message));
});

test('the note follows its answer: Markdown hides it once the answer is Decided, and a changed answer keeps it with the earlier answer', async () => {
  const { store, map } = await asked(['Who decides?']);
  const [q] = map.nodes[0].questions;
  await answer(store, map, q, 'The lead.', 'assumption');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: q.id, text: 'Two leads\n\n## Injected heading\n- bullet' });
  const page = async () => readFile(path.join(path.dirname(store.file(map.id)), 'nodes', map.rootId + '.md'), 'utf8');
  assert.match(await page(), /_Would be disproved if: Two leads \\#\\# Injected heading - bullet_/); assert.doesNotMatch(await page(), /^## Injected heading/m, 'kept on one line');
  await act(store, map.id, { type: 'set-answer-state', nodeId: map.rootId, questionId: q.id, answerState: 'decided' });
  assert.doesNotMatch(await page(), /Would be disproved if/, 'a Decided answer is no assumption');
  await act(store, map.id, { type: 'set-answer-state', nodeId: map.rootId, questionId: q.id, answerState: 'assumption' });
  const saved = await act(store, map.id, { type: 'change-answer', nodeId: map.rootId, questionId: q.id, answer: 'The whole team.' });
  const changed = saved.nodes[0].questions[0];
  assert.equal(Object.hasOwn(changed, 'disproveIf'), false, 'the note was about the old answer'); assert.match(changed.previousAnswers.at(-1).disproveIf, /^Two leads/);
});

test('node Markdown writes interpretations on one line each, escaped, and says when what would change one is missing', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'assumptions-')), 'ideas'));
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  const edited = structuredClone(map);
  edited.nodes[0].assumptions = [{ statement: 'Line one\n## Not a heading <b>', wouldChangeIf: 'Reports *say* so.' }, { statement: 'No change given.' }, null, 'text'];
  const pageText = store.renderViews(edited).nodes.get(map.rootId);
  assert.match(pageText, /## Interpretations\n\n_The agent's interpretations: unverified\._\n\n- Line one \\#\\# Not a heading \\<b\\>\n  - Would change if: Reports \\\*say\\\* so\.\n- No change given\.\n  - Would change if: not stated/);
  assert.deepEqual(interpretationsOf({ assumptions: 'abc' }), []); assert.deepEqual(interpretationsOf({ assumptions: {} }), []);
});

test('a pulled map with a malformed note or interpretation is reported, and the register and brief skip what they cannot read', () => {
  const map = { schemaVersion: 1, id: 'map-1', title: 'T', revision: 1, rootId: 'root', edges: [], jobs: [], history: [],
    nodes: [idea('root', null, { questions: [question('q', 'assumption', { disproveIf: 3 })], assumptions: [{ statement: 5 }, 'text', { statement: 'Fine.', wouldChangeIf: 'Readable.' }] })] };
  const { errors } = validateMap(map);
  assert.ok(errors.some(error => /disproveIf/.test(error.at)), 'disproveIf must be text'); assert.ok(errors.some(error => /assumptions/.test(error.at)), 'interpretations must be records of text');
  assert.deepEqual(assumptionRegister(map).map(entry => [entry.kind, entry.wouldChangeIf]), [['answer', null], ['interpretation', 'Readable.']]);
  for (const bad of ['abc', {}]) assert.doesNotThrow(() => mapBrief({ ...map, nodes: [{ ...map.nodes[0], assumptions: bad }] }), JSON.stringify(bad));
});

test('a wording fix keeps the note on its answer, a Decided answer sends no note, and removal needs text', async () => {
  const { store, map } = await asked(['Who decides?', 'When?']);
  const [first, second] = map.nodes[0].questions;
  await answer(store, map, first, 'The lead.', 'assumption'); await answer(store, map, second, 'Soon.', 'decided');
  await act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: first.id, text: 'A pilot disagrees.' });
  await assert.rejects(act(store, map.id, { type: 'set-disprove-if', nodeId: map.rootId, questionId: first.id }), /Give the note as text/);
  const saved = await act(store, map.id, { type: 'change-answer', nodeId: map.rootId, questionId: first.id, answer: 'The team lead.', rerun: false });
  assert.equal(saved.nodes[0].questions[0].disproveIf, 'A pilot disagrees.', 'a wording fix is the same answer');
  assert.equal(Object.hasOwn(saved.nodes[0].questions[0].previousAnswers.at(-1), 'disproveIf'), false);
  const raw = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  raw.nodes[0].questions[1].disproveIf = 'A stray note.'; // Left on a Decided answer by a hand edit.
  const { writeFile } = await import('node:fs/promises'); await writeFile(store.file(map.id), JSON.stringify(raw));
  const packet = await store.claim('test');
  assert.equal(packet.selected.questions[0].disproveIf, 'A pilot disagrees.'); assert.equal(Object.hasOwn(packet.selected.questions[1], 'disproveIf'), false, 'only an Assumption carries its note');
});

test('an empty list of interpretations is stored as none', async () => {
  const { map } = await asked(['Who decides?'], { assumptions: [] });
  assert.equal(Object.hasOwn(map.nodes[0], 'assumptions'), false);
});
