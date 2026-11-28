import test from 'node:test';
import assert from 'node:assert/strict';
import { moreFiltersHtml, moreFiltersPanel } from '../skills/explore/assets/more-filters.js';
import { mapOverview } from '../skills/explore/assets/workspace-view.js';

// More map filters (Z9, #67): answer state and importance. Pure fixtures; nothing touches ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const q = (id, fields = {}) => ({ id, text: `Question ${id}?`, answer: null, ...fields });
const node = (id, questions, fields = {}) => ({ id, title: `Idea ${id}`, status: 'awaiting-answer', questions, ...fields });
const map = () => ({ id: 'map-1', nodes: [
  node('a', [q('a1', { answer: 'We decided.', answerState: 'decided' }), q('a2', { answer: 'An older answer.' }), q('a3', { importance: 'high' })]),
  node('b', [q('b1', { answer: 'Probably.', answerState: 'assumption' }), q('b2', { importance: 'low', deferredAt: '2026-11-27T10:00:00Z' }), q('b3')]),
  // Superseded and dismissed questions never match; a complete branch's open questions have no importance to act on.
  node('c', [q('c1', { answer: 'Old premise.', answerState: 'assumption', supersededAt: '2026-11-27T10:00:00Z' }), q('c2', { importance: 'high', dismissedAt: '2026-11-27T10:00:00Z' }), q('c3', { answer: 'Dropped.', answerState: 'decided', dismissedAt: '2026-11-27T10:00:00Z' })]),
  node('d', [q('d1', { importance: 'high' })], { status: 'explored', completed: true }),
] });
const groupsOf = source => Object.fromEntries(mapOverview(source).groups.map(group => [group.id, group]));
const ids = group => group.nodes.map(n => n.id);

test('the overview builds the progress and question filters alike; the bar keeps only the progress ones', () => {
  const groups = mapOverview(map()).groups;
  assert.deepEqual(groups.filter(group => group.kind === 'progress').map(group => group.id), ['answer', 'queued', 'unexplored', 'stale']);
  assert.deepEqual(groups.filter(group => group.kind !== 'progress').map(group => group.id), ['state:decided', 'state:tentative', 'state:assumption', 'state:later', 'importance:high', 'importance:medium', 'importance:low', 'importance:unranked']);
  for (const group of groups) assert.equal(typeof group.lines, 'function', `${group.id} lists its rows one way`);
  assert.deepEqual(groupsOf({ nodes: [node('x', [], { summary: 'A summary.' })] }).answer.lines(node('x', [], { summary: 'A summary.' })), [{ text: 'A summary.' }]);
});

test('each answer state lists the ideas with a current answer in that state, older answers under Tentative', () => {
  const groups = groupsOf(map()), [a, b] = map().nodes;
  assert.deepEqual(ids(groups['state:decided']), ['a']);
  assert.deepEqual(ids(groups['state:tentative']), ['a']);
  assert.deepEqual(ids(groups['state:assumption']), ['b'], 'a superseded Assumption does not count');
  assert.deepEqual(ids(groups['state:later']), ['b']);
  // The question and the start of the answer are separate rows, so a long question never hides the answer.
  assert.deepEqual(groups['state:tentative'].lines(a), [{ text: 'Question a2?', detail: 'An older answer. · Tentative (not recorded)' }]);
  assert.deepEqual(groups['state:decided'].lines(a), [{ text: 'Question a1?', detail: 'We decided.' }]);
  assert.deepEqual(groups['state:later'].lines(b), [{ text: 'Question b2?' }]);
  assert.equal(groups['state:assumption'].label, 'Ideas with answers marked Assumption', 'the count is of ideas, and so is the title');
});

test('importance counts only open questions on unfinished branches, and unranked ones have their own group', () => {
  const groups = groupsOf(map()), [a, b] = map().nodes;
  assert.deepEqual(ids(groups['importance:high']), ['a'], 'not the dismissed one, not the complete branch');
  assert.deepEqual(groups['importance:high'].lines(a), [{ text: 'Question a3?' }], 'never an answered question');
  assert.deepEqual(groups['importance:medium'].nodes, []);
  assert.deepEqual(ids(groups['importance:low']), ['b'], 'a question saved for later is still open');
  assert.deepEqual(groups['importance:unranked'].lines(b), [{ text: 'Question b3?' }]);
  assert.equal(groups['importance:unranked'].label, 'Ideas with unranked open questions');
});

test('long text is shortened per row, empty groups explain themselves, and nothing is changed', () => {
  const source = map(); source.nodes[0].questions[0].text = 'q'.repeat(400); source.nodes[0].questions[0].answer = 'x'.repeat(400);
  const before = JSON.stringify(source);
  const [row] = groupsOf(source)['state:decided'].lines(source.nodes[0]);
  assert.equal(JSON.stringify(source), before, 'read-only');
  assert.ok(row.text.length <= 201 && row.text.endsWith('…') && row.detail.startsWith('x') && row.detail.length <= 201);
  assert.match(groupsOf(source)['importance:medium'].empty, /No open questions/);
  for (const group of mapOverview({ nodes: [] }).groups) assert.ok(group.nodes.length === 0 && group.empty, group.id);
});

test('the panel shows both groups with counts and marks the active choice', () => {
  const groups = mapOverview(map()).groups.filter(group => group.kind !== 'progress');
  const html = moreFiltersHtml(groups, { esc, active: 'state:assumption' });
  assert.match(html, /How settled answers are/); assert.match(html, /Importance of open questions/);
  assert.match(html, /data-more-filter="state:assumption" aria-pressed="true"><span>Assumption<\/span><strong>1<\/strong>/);
  assert.match(html, /data-more-filter="importance:unranked" aria-pressed="false"><span>Unranked<\/span><strong>1<\/strong>/);
});

// A small fake DOM: the wrapper, button, Clear filter and panel, whose chips come from its markup.
function fakePanel() {
  const doc = { activeElement: null, handlers: {}, addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); } };
  const element = (name, parent = null) => {
    const handlers = {};
    return { name, parent, hidden: false, textContent: '', attributes: {}, dataset: {},
      addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event) { for (const fn of handlers[type] || []) fn(event); },
      setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key] ?? null; },
      focus() { doc.activeElement = this; }, closest(selector) { return selector === '[data-more-filter]' && this.dataset.moreFilter ? this : null; },
      contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; } };
  };
  const wrap = element('wrap'), button = element('button', wrap), clear = element('clear', wrap), panel = element('panel', wrap), outside = element('outside');
  panel.hidden = true; let chips = [];
  Object.defineProperty(panel, 'innerHTML', { set(html) {
    chips = [...html.matchAll(/data-more-filter="([^"]+)" aria-pressed="(true|false)"/g)].map(([, id, pressed]) => Object.assign(element('chip', panel), { dataset: { moreFilter: id }, pressed }));
  } });
  panel.querySelector = selector => (selector === 'button' ? chips[0] : selector === '[aria-pressed="true"]' ? chips.find(chip => chip.pressed === 'true') : chips.find(chip => selector === `[data-more-filter="${chip.dataset.moreFilter}"]`)) ?? null;
  doc.querySelector = selector => ({ '.more-filters': wrap, '#more-filters': button, '#more-filters-panel': panel, '#clear-filter': clear })[selector];
  return { doc, wrap, button, clear, panel, outside, chip: id => chips.find(item => item.dataset.moreFilter === id) };
}
const key = (target, name) => { const event = { key: name, target, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } }; return event; };

test('the panel opens on the active choice, chooses, keeps focus through a redraw, and Escape only closes it', () => {
  const dom = fakePanel(), chosen = [], listed = [];
  globalThis.document = dom.doc;
  try {
    const panel = moreFiltersPanel({ esc, openFilter: filter => chosen.push(filter), focusList: () => listed.push(true) });
    let groups = mapOverview(map()).groups.filter(group => group.kind !== 'progress');
    panel.render(groups, 'state:assumption');
    assert.equal(dom.button.textContent, 'Filter: Assumption'); assert.equal(dom.clear.hidden, false);
    dom.button.fire('click');
    assert.equal(dom.panel.hidden, false); assert.equal(dom.button.attributes['aria-expanded'], 'true');
    assert.equal(dom.doc.activeElement, dom.chip('state:assumption'), 'opens on the active choice');
    // Counts change under the focused chip: the panel redraws and focus stays on the same choice.
    const source = map(); source.nodes.push(node('e', [q('e1', { answer: 'Maybe.', answerState: 'assumption' })]));
    groups = mapOverview(source).groups.filter(group => group.kind !== 'progress');
    panel.render(groups, 'state:assumption');
    assert.equal(dom.doc.activeElement?.dataset.moreFilter, 'state:assumption');
    // Escape on the button while the panel is open closes only the panel; the page never sees it.
    const escape = key(dom.button, 'Escape'); dom.wrap.fire('keydown', escape);
    assert.equal(dom.panel.hidden, true); assert.equal(escape.stopped, true); assert.deepEqual(chosen, []); assert.equal(dom.doc.activeElement, dom.button);
    // Arrow Down from the button enters the list while one of these filters is active.
    dom.wrap.fire('keydown', key(dom.button, 'ArrowDown')); assert.equal(listed.length, 1);
    // Choosing: the active one again clears it; another sets it.
    dom.button.fire('click'); dom.panel.fire('click', { target: dom.chip('state:assumption') });
    assert.deepEqual(chosen, [null]); assert.equal(dom.panel.hidden, true); assert.equal(dom.doc.activeElement, dom.button);
    dom.button.fire('click'); dom.panel.fire('click', { target: dom.chip('importance:high') });
    assert.deepEqual(chosen, [null, 'importance:high']);
    dom.clear.fire('click'); assert.deepEqual(chosen, [null, 'importance:high', null]);
  } finally { delete globalThis.document; }
});

test('the panel closes when focus or a click goes elsewhere, not when focus has nowhere to go', () => {
  const dom = fakePanel();
  globalThis.document = dom.doc;
  try {
    const panel = moreFiltersPanel({ esc, openFilter() {}, focusList() {} });
    panel.render(mapOverview(map()).groups.filter(group => group.kind !== 'progress'), 'answer');
    assert.equal(dom.button.textContent, 'More filters', 'a progress filter is not one of these');
    dom.wrap.fire('keydown', key(dom.button, 'ArrowDown'));
    dom.button.fire('click');
    dom.wrap.fire('focusout', { relatedTarget: null }); assert.equal(dom.panel.hidden, false, 'a click that moves no focus');
    dom.wrap.fire('focusout', { relatedTarget: dom.chip('state:decided') }); assert.equal(dom.panel.hidden, false, 'still inside');
    dom.wrap.fire('focusout', { relatedTarget: dom.outside }); assert.equal(dom.panel.hidden, true, 'Tab left the panel');
    dom.button.fire('click');
    for (const fn of dom.doc.handlers.click) fn({ target: dom.outside });
    assert.equal(dom.panel.hidden, true, 'a click elsewhere');
  } finally { delete globalThis.document; }
});
