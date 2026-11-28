import test from 'node:test';
import assert from 'node:assert/strict';
import { questionFilters, moreFiltersHtml, isQuestionFilter } from '../skills/explore/assets/more-filters.js';

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
const byId = groups => Object.fromEntries(groups.map(group => [group.id, group]));

test('each answer state lists the ideas with a current answer in that state, older answers under Tentative', () => {
  const groups = byId(questionFilters(map()).groups);
  assert.deepEqual(groups['state:decided'].nodes.map(n => n.id), ['a']);
  assert.deepEqual(groups['state:tentative'].nodes.map(n => n.id), ['a']);
  assert.deepEqual(groups['state:assumption'].nodes.map(n => n.id), ['b'], 'a superseded Assumption does not count');
  assert.deepEqual(groups['state:later'].nodes.map(n => n.id), ['b']);
  assert.deepEqual(groups['state:tentative'].lines(map().nodes[0]), ['Question a2? — An older answer. · Tentative (not recorded)']);
  assert.deepEqual(groups['state:decided'].lines(map().nodes[0]), ['Question a1? — We decided.']);
});

test('importance counts only open questions on unfinished branches, and unranked ones have their own group', () => {
  const groups = byId(questionFilters(map()).groups);
  assert.deepEqual(groups['importance:high'].nodes.map(n => n.id), ['a'], 'not the dismissed one, not the complete branch');
  assert.deepEqual(groups['importance:medium'].nodes, []);
  assert.deepEqual(groups['importance:low'].nodes.map(n => n.id), ['b'], 'a question saved for later is still open');
  assert.deepEqual(groups['importance:unranked'].nodes.map(n => n.id), ['b']);
  assert.deepEqual(groups['importance:high'].lines(map().nodes[0]), ['Question a3?']);
  for (const id of ['importance:high', 'importance:medium', 'importance:low', 'importance:unranked']) {
    assert.ok(!groups[id].nodes.some(n => n.questions.some(question => question.answer && groups[id].lines(n).includes(question.text))), `${id} has no answered question`);
  }
});

test('long answers are shortened in the list, empty groups explain themselves, and nothing is changed', () => {
  const source = map(); source.nodes[0].questions[0].answer = 'x'.repeat(400);
  const before = JSON.stringify(source);
  const { groups } = questionFilters(source);
  assert.equal(JSON.stringify(source), before, 'read-only');
  const [line] = byId(groups)['state:decided'].lines(source.nodes[0]);
  assert.ok(line.length < 200 && line.endsWith('…'));
  assert.match(byId(groups)['importance:medium'].empty, /No open questions/);
  const empty = questionFilters({ nodes: [] });
  assert.ok(empty.groups.every(group => group.nodes.length === 0 && group.empty));
  assert.deepEqual(questionFilters(null).groups.map(group => group.nodes.length), empty.groups.map(() => 0));
});

test('the panel shows both groups with counts, marks the active choice, and knows its own filter ids', () => {
  const { groups } = questionFilters(map());
  const html = moreFiltersHtml(groups, { esc, active: 'state:assumption' });
  assert.match(html, /How settled answers are/); assert.match(html, /Importance of open questions/);
  assert.match(html, /data-more-filter="state:assumption" aria-pressed="true"><span>Assumption<\/span><strong>1<\/strong>/);
  assert.match(html, /data-more-filter="importance:unranked" aria-pressed="false"><span>Unranked<\/span><strong>1<\/strong>/);
  assert.equal(isQuestionFilter('state:assumption'), true); assert.equal(isQuestionFilter('importance:high'), true);
  assert.equal(isQuestionFilter('answer'), false); assert.equal(isQuestionFilter(null), false);
});
