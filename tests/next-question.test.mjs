import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestNextQuestion, nextQuestionHtml, nextQuestionDismiss } from '../skills/explore/assets/next-question.js';
import { downstreamOf } from '../skills/explore/assets/graph.js';

// Suggest the next question (B3, #5). Pure fixtures; nothing touches ideas/ or a store.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const q = (id, fields = {}) => ({ id, text: `Question ${id}?`, answer: null, ...fields });
const node = (id, parentId, questions = [], fields = {}) => ({ id, parentId, title: `Idea ${id}`, status: questions.some(x => !x.answer) ? 'awaiting-answer' : 'explored', questions, ...fields });
// root ─┬─ a (one open question) ─ a1 … a6 below it
//       └─ b (one open question) ─ b1 below it, and c depends on b
function map() {
  const nodes = [node('root', null), node('a', 'root', [q('qa')]), ...[1, 2, 3, 4, 5, 6].map(i => node(`a${i}`, 'a')), node('b', 'root', [q('qb')]), node('b1', 'b'), node('c', 'root')];
  const edges = nodes.filter(n => n.parentId).map(n => ({ from: n.parentId, to: n.id, type: 'contains' }));
  edges.push({ from: 'c', to: 'b', type: 'depends_on' });
  return { id: 'm', rootId: 'root', nodes, edges, jobs: [] };
}
const pick = (source, options) => { const result = suggestNextQuestion(source, options); return result.status === 'suggested' ? result.candidate.questionId : result.status; };

test('with no open question there is no suggestion', () => {
  const source = map(); for (const n of source.nodes) n.questions = n.questions.map(x => ({ ...x, answer: 'Done.' }));
  assert.deepEqual(suggestNextQuestion(source), { status: 'none-open' });
  assert.equal(nextQuestionHtml(suggestNextQuestion(source), esc), '');
});

test('a branch more ideas build on comes first, and the reasons give exact counts below it and depending on it', () => {
  const result = suggestNextQuestion(map());
  assert.equal(result.candidate.questionId, 'qa', 'six below a (many) beats two for b (some)');
  assert.deepEqual(result.counts.downstream, { total: 6, below: 6, linked: 0 });
  assert.match(result.reasons[0], /^6 ideas build on this branch \(6 below it, 0 linked as depending on it\)/);
  const b = suggestNextQuestion(map(), { dismissed: nextQuestionDismiss(new Map(), result) });
  assert.equal(b.candidate.questionId, 'qb');
  assert.match(b.reasons[0], /^2 ideas build on this branch \(1 below it, 1 linked as depending on it\)/);
});

test('within a band a flagged branch comes first, then the last open question on its idea, then the agent’s importance', () => {
  const source = map(); source.nodes = source.nodes.filter(n => !/^a\d/.test(n.id)); source.edges = source.edges.filter(e => !/^a\d/.test(e.to));
  source.nodes.find(n => n.id === 'a').questions = [q('qa')]; source.nodes.push(node('a1', 'a')); source.edges.push({ from: 'a', to: 'a1', type: 'contains' });
  // Both in the "some" band now. A flag wins over everything after it.
  source.nodes.find(n => n.id === 'b').stale = true;
  assert.equal(pick(source), 'qb');
  delete source.nodes.find(n => n.id === 'b').stale;
  // The last open question on an idea outranks one whose idea still has several open.
  source.nodes.find(n => n.id === 'a').questions = [q('qa'), q('qa2')];
  assert.equal(pick(source), 'qb');
  const result = suggestNextQuestion(source);
  assert.ok(result.reasons.some(reason => /Last open question on “Idea b”; answering lets your agent continue\./.test(reason)));
  // Importance decides only when everything before it is equal, and is labelled as the agent's view.
  source.nodes.find(n => n.id === 'a').questions = [q('qa', { importance: 'low' })];
  source.nodes.find(n => n.id === 'b').questions = [q('qb', { importance: 'high' })];
  const ranked = suggestNextQuestion(source);
  assert.equal(ranked.candidate.questionId, 'qb'); assert.ok(ranked.reasons.some(reason => /Your agent’s assessment: High importance/.test(reason)));
  source.nodes.find(n => n.id === 'b').questions = [q('qb')];
  assert.equal(pick(source), 'qa', 'without importance, map order decides');
  assert.match(suggestNextQuestion(source).reasons[0], /^1 idea builds on this branch \(1 below it, 0 linked/);
});

test('only open questions on unfinished branches are suggested', () => {
  const source = map();
  const a = source.nodes.find(n => n.id === 'a'), b = source.nodes.find(n => n.id === 'b');
  a.questions = [q('answered', { answer: 'Yes.' }), q('old', { supersededAt: '2026-11-27T10:00:00Z' }), q('gone', { dismissedAt: '2026-11-27T10:00:00Z' }), q('later', { deferredAt: '2026-11-27T10:00:00Z' }), q('regen', { replacedBy: 'pending' })];
  b.completed = true; b.status = 'explored';
  assert.equal(pick(source), 'none-open');
  b.completed = false; b.status = 'awaiting-answer';
  assert.equal(pick(source), 'qb');
});

test('Not now hides one question until it, its idea’s status or flag changes', () => {
  const source = map(), first = suggestNextQuestion(source);
  let dismissed = nextQuestionDismiss(new Map(), first);
  dismissed = nextQuestionDismiss(dismissed, suggestNextQuestion(source, { dismissed }));
  assert.deepEqual(suggestNextQuestion(source, { dismissed }), { status: 'all-dismissed' });
  source.nodes.find(n => n.id === 'a').stale = true;
  assert.equal(pick(source, { dismissed }), 'qa', 'a changed flag brings it back');
  delete source.nodes.find(n => n.id === 'a').stale;
  source.nodes.find(n => n.id === 'b').questions[0].text = 'A reworded question?';
  assert.equal(pick(source, { dismissed }), 'qb', 'a reworded question comes back');
});

test('the shared downstream walk follows contains edges down and depends_on edges to dependants', () => {
  assert.deepEqual([...downstreamOf(map(), ['b'])].sort(), ['b', 'b1', 'c']);
  assert.deepEqual([...downstreamOf(map(), ['c'])], ['c'], 'depending on b does not make b depend on c');
});

test('the panel item names the question, its idea and the reasons, opens the idea and offers Not now', () => {
  const source = map(); source.nodes.find(n => n.id === 'a').questions[0].text = 'Is <this> safe?';
  const html = nextQuestionHtml(suggestNextQuestion(source), esc);
  assert.match(html, /Suggested next/); assert.match(html, /Is &lt;this&gt; safe\?/); assert.doesNotMatch(html, /<this>/);
  assert.match(html, /data-focus-node="a"[^>]*>Open question</); assert.match(html, /data-next-dismiss="a:qa"[^>]*>Not now</);
  assert.match(html, /<li>6 ideas build on this branch/);
});
