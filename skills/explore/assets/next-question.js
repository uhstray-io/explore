import { downstreamOf, branchIds, branchComplete } from './graph.js';
import { isWaiting, importanceRank, importanceLabel } from './questions.js';

// Suggest the next question (B3): one open question to answer next, and why. Worked out in the browser from the
// saved map: no agent, no job, no change to the map. Navigation only.

// How much builds on an idea: none, some (1–5 ideas) or many (6 or more). Exact counts explain, bands rank.
const band = count => (count >= 6 ? 2 : count >= 1 ? 1 : 0);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// A dismissal holds only while the question, its idea's status and its review flag stay as they were.
const keyOf = (node, question) => `${node.id}:${question.id}`;
const signatureOf = (node, question) => JSON.stringify([question.text, node.status, !!node.stale]);

// Open questions on unfinished branches: unanswered, not superseded, dismissed, saved for later or being replaced.
function candidates(map) {
  return map.nodes.flatMap((node, order) => {
    if (branchComplete(node)) return [];
    const open = node.questions.filter(question => isWaiting(question) && !question.replacedBy);
    return open.map(question => ({ node, question, order, openOnNode: open.length }));
  });
}

// { status: 'suggested', candidate, reasons, counts } or { status: 'none-open' | 'all-dismissed' }.
// `dismissed` is what nextQuestionDismiss returned; it lives in browser memory only.
export function suggestNextQuestion(map, { dismissed = new Map() } = {}) {
  const all = candidates(map);
  if (!all.length) return { status: 'none-open' };
  const shown = all.filter(item => dismissed.get(keyOf(item.node, item.question)) !== signatureOf(item.node, item.question));
  if (!shown.length) return { status: 'all-dismissed' };
  const impact = new Map();
  const downstream = node => {
    if (!impact.has(node.id)) {
      const total = downstreamOf(map, [node.id]).size - 1, below = branchIds(map, node.id).size - 1;
      impact.set(node.id, { total, below, linked: Math.max(0, total - below) });
    }
    return impact.get(node.id);
  };
  // Impact band, then a flagged branch, then the last open question on its idea, then the agent's importance,
  // then map order and question ID.
  const rank = item => [-band(downstream(item.node).total), item.node.stale ? 0 : 1, item.openOnNode === 1 ? 0 : 1, importanceRank(item.question.importance), item.order];
  const compare = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.question.id.localeCompare(b.question.id); };
  const best = [...shown].sort(compare)[0], { node, question } = best, counts = downstream(node);
  const reasons = [
    ...(counts.total ? [`${plural(counts.total, 'idea')} ${counts.total === 1 ? 'builds' : 'build'} on this branch (${counts.below} below it, ${counts.linked} linked as depending on it).`] : []),
    ...(node.stale ? ['This branch is flagged for review; answering lets it run again.'] : []),
    best.openOnNode === 1 ? `Last open question on “${node.title}”; answering lets your agent continue.` : `One of ${best.openOnNode} open questions on “${node.title}”.`,
    ...(importanceLabel(question.importance) ? [`Your agent’s assessment: ${importanceLabel(question.importance)}.`] : []),
  ];
  return { status: 'suggested', candidate: { nodeId: node.id, questionId: question.id, title: node.title, question: question.text },
    reasons, counts: { downstream: counts, openOnNode: best.openOnNode, signature: signatureOf(node, question) } };
}

// "Not now": a new dismissal map with this suggestion set aside.
export function nextQuestionDismiss(dismissed, result) {
  return new Map(dismissed).set(`${result.candidate.nodeId}:${result.candidate.questionId}`, result.counts.signature);
}

// The first item of the "Needs your answer" list. Open question reuses the list's navigation.
export function nextQuestionHtml(result, esc) {
  if (result.status !== 'suggested') return '';
  const { candidate } = result;
  return `<div class="overview-idea next-question"><small>Suggested next</small><strong>${esc(candidate.question)}</strong><span>${esc(candidate.title)}</span>`
    + `<ul>${result.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><div class="next-question-actions"><button type="button" class="secondary" data-focus-node="${esc(candidate.nodeId)}">Open question</button>`
    + `<button type="button" class="text-button" data-next-dismiss="${esc(candidate.nodeId)}:${esc(candidate.questionId)}">Not now</button></div></div>`;
}
