import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestNextQuestion, nextQuestionPanel, downstreamCounts } from '../skills/explore/assets/next-question.js';
import { downstreamOf } from '../skills/explore/assets/graph.js';
import { questionSequence } from '../skills/explore/assets/workspace-view.js';

// Suggest the next question (B3, #5). Pure fixtures; nothing touches ideas/ or a store.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const q = (id, fields = {}) => ({ id, text: `Question ${id}?`, answer: null, ...fields });
const node = (id, parentId, questions = [], fields = {}) => ({ id, parentId, title: `Idea ${id}`, status: questions.some(x => !x.answer && !x.dismissedAt) ? 'awaiting-answer' : 'explored', questions, ...fields });
// root ─┬─ a (one open question) ─ a1 … a6 below it
//       └─ b (one open question) ─ b1 below it, and c depends on b
function map(id = 'm') {
  const nodes = [node('root', null), node('a', 'root', [q('qa')]), ...[1, 2, 3, 4, 5, 6].map(i => node(`a${i}`, 'a')), node('b', 'root', [q('qb')]), node('b1', 'b'), node('c', 'root')];
  const edges = nodes.filter(n => n.parentId).map(n => ({ from: n.parentId, to: n.id, type: 'contains' }));
  edges.push({ from: 'c', to: 'b', type: 'depends_on' });
  return { id, rootId: 'root', nodes, edges, jobs: [] };
}
const pick = (source, options) => { const result = suggestNextQuestion(source, options); return result.status === 'suggested' ? result.candidate.questionId : result.status; };

test('with no open question there is no suggestion', () => {
  const source = map(); for (const n of source.nodes) { n.questions = n.questions.map(x => ({ ...x, answer: 'Done.' })); n.status = 'explored'; }
  assert.deepEqual(suggestNextQuestion(source), { status: 'none-open' });
  assert.equal(nextQuestionPanel({ esc, focusNode() {}, rerender() {} }).html(source), '');
});

test('a branch more ideas build on comes first, and the reasons give exact counts below it and depending on it', () => {
  const result = suggestNextQuestion(map());
  assert.equal(result.candidate.questionId, 'qa', 'six below a (many) beats two for b (some)');
  assert.deepEqual(result.counts.downstream, { total: 6, below: 6, linked: 0 });
  assert.match(result.reasons[0], /^6 ideas build on this branch \(6 below it, 0 linked as depending on it\)/);
  const b = suggestNextQuestion(map(), { dismissed: new Set([result.candidate.key]) });
  assert.equal(b.candidate.questionId, 'qb');
  assert.match(b.reasons[0], /^2 ideas build on this branch \(1 below it, 1 linked as depending on it\)/);
});

test('the card offers the question the inspector shows first, whatever the question ids', () => {
  const source = map();
  source.nodes.find(n => n.id === 'a').questions = [q('q-f00d'), q('q-0abc', { importance: 'high' })];
  const result = suggestNextQuestion(source);
  assert.equal(result.candidate.questionId, questionSequence(source.nodes.find(n => n.id === 'a')).current.id);
  assert.equal(result.candidate.questionId, 'q-f00d');
});

test('within a band a flagged branch comes first, then the branch it unblocks, then the agent’s importance', () => {
  const source = map(); source.nodes = source.nodes.filter(n => !/^a\d/.test(n.id)); source.edges = source.edges.filter(e => !/^a\d/.test(e.to));
  source.nodes.push(node('a1', 'a')); source.edges.push({ from: 'a', to: 'a1', type: 'contains' });
  const a = source.nodes.find(n => n.id === 'a'), b = source.nodes.find(n => n.id === 'b');
  b.stale = true;
  assert.equal(pick(source), 'qb', 'both in the some band: the flag wins');
  delete b.stale;
  // A sibling being regenerated still blocks the branch: answering this one would not let it continue.
  a.questions = [q('qa'), q('qa2', { dismissedAt: '2026-11-27T10:00:00Z', replacedBy: 'pending' })];
  assert.equal(pick(source), 'qb');
  b.questions = [q('qb'), q('qb2', { dismissedAt: '2026-11-27T10:00:00Z', replacedBy: 'pending' })];
  const both = suggestNextQuestion(source);
  assert.equal(both.candidate.questionId, 'qa'); assert.ok(both.reasons.includes('One of 2 questions still open on “Idea a”.'));
  b.questions = [q('qb')];
  assert.ok(suggestNextQuestion(source).reasons.includes('Last open question on “Idea b”; answering lets your agent continue.'));
  // Importance decides only when everything before it is equal, and is labelled as the agent's view.
  a.questions = [q('qa', { importance: 'low' })]; b.questions = [q('qb', { importance: 'high' })];
  const ranked = suggestNextQuestion(source);
  assert.equal(ranked.candidate.questionId, 'qb'); assert.ok(ranked.reasons.includes('Your agent’s assessment: High importance.'));
  b.questions = [q('qb')];
  assert.equal(pick(source), 'qa', 'without importance, map order decides');
  assert.match(suggestNextQuestion(source).reasons[0], /^1 idea builds on this branch \(1 below it, 0 linked/);
});

test('only ideas waiting for an answer are suggested, and only their open questions', () => {
  const source = map();
  const a = source.nodes.find(n => n.id === 'a'), b = source.nodes.find(n => n.id === 'b');
  a.questions = [q('answered', { answer: 'Yes.' }), q('old', { supersededAt: '2026-11-27T10:00:00Z' }), q('gone', { dismissedAt: '2026-11-27T10:00:00Z' }), q('later', { deferredAt: '2026-11-27T10:00:00Z' })];
  a.status = 'queued';
  b.completed = true; b.status = 'explored';
  assert.equal(pick(source), 'none-open');
  b.completed = false; b.status = 'awaiting-answer';
  assert.equal(pick(source), 'qb');
});

test('Not now hides one question until it, its idea’s status or flag changes, and only on that map', () => {
  const source = map(), panel = nextQuestionPanel({ esc, focusNode() {}, rerender() {} });
  const dismiss = () => { const key = panel.html(source).match(/data-next-dismiss="([^"]+)"/)[1].replace(/&quot;/g, '"'); return panel.click({ target: { closest: selector => (selector === '[data-next-dismiss]' ? { dataset: { nextDismiss: key } } : null) } }); };
  assert.equal(dismiss(), true); assert.match(panel.html(source), /Question qb\?/);
  dismiss(); assert.equal(panel.html(source), '', 'all set aside');
  assert.match(panel.html(map('a-copy')), /Question qa\?/, 'a copy of the map keeps its own suggestions');
  source.nodes.find(n => n.id === 'a').stale = true;
  assert.match(panel.html(source), /Question qa\?/, 'a changed flag brings it back');
  delete source.nodes.find(n => n.id === 'a').stale;
  source.nodes.find(n => n.id === 'b').questions[0].text = 'A reworded question?';
  assert.match(panel.html(source), /A reworded question\?/, 'so does new wording');
});

test('the counts come from one walk: contains edges down and depends_on edges to dependants', () => {
  assert.deepEqual([...downstreamOf(map(), ['b'])].sort(), ['b', 'b1', 'c']);
  assert.deepEqual([...downstreamOf(map(), ['c'])], ['c'], 'depending on b does not make b depend on c');
  const source = map(); source.nodes.push(node('orphan', 'b')); // A parent with no contains edge.
  assert.deepEqual(downstreamCounts(source, 'b'), { total: 2, below: 1, linked: 1 }, 'the parent-only child is not counted twice or negatively');
});

test('the card names the question, its idea and the reasons; Open question navigates', () => {
  const source = map(); source.nodes.find(n => n.id === 'a').questions[0].text = 'Is <this> safe?';
  const opened = [], panel = nextQuestionPanel({ esc, focusNode: id => opened.push(id), rerender() {} });
  const html = panel.html(source);
  assert.match(html, /Suggested next/); assert.match(html, /Is &lt;this&gt; safe\?/); assert.doesNotMatch(html, /<this>/);
  assert.match(html, /data-next-open="a"[^>]*>Open question</); assert.match(html, /data-next-dismiss="[^"]+"[^>]*>Not now</);
  assert.match(html, /<li>6 ideas build on this branch/);
  assert.equal(panel.click({ target: { closest: selector => (selector === '[data-next-open]' ? { dataset: { nextOpen: 'a' } } : null) } }), true);
  assert.deepEqual(opened, ['a']);
  assert.equal(panel.click({ target: { closest: () => null } }), false);
});
