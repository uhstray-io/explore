import { downstreamOf, branchIds, branchComplete } from './graph.js';
import { isBlocking, importanceRank, importanceLabel } from './questions.js';
import { questionSequence, overviewFilters } from './workspace-view.js';

// Suggest the next question (B3): one idea waiting for an answer, and the question its inspector shows first, with
// the reasons. Worked out in the browser from the saved map: no agent, no job, no change to the map.

// How much builds on an idea: none, some (1–5 ideas) or many (6 or more). Exact counts explain; bands rank.
const band = count => (count >= 6 ? 2 : count >= 1 ? 1 : 0);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// What builds on an idea, split into its branch below it and ideas linked as depending on it. "Below" counts only
// ideas the walk reached, so the two always add up.
export function downstreamCounts(map, nodeId) {
  const downstream = downstreamOf(map, [nodeId]);
  const below = [...branchIds(map, nodeId)].filter(id => id !== nodeId && downstream.has(id)).length;
  return { total: downstream.size - 1, below, linked: downstream.size - 1 - below };
}

// { status: 'suggested', candidate, reasons, counts } or { status: 'none-open' | 'all-dismissed' }. Candidates are
// the ideas the "Needs your answer" filter lists; each offers the question its inspector shows first. `dismissed`
// holds candidate keys set aside with Not now.
const waitingForAnswer = overviewFilters.find(filter => filter.id === 'answer').matches;
export function suggestNextQuestion(map, { dismissed = new Set() } = {}) {
  const all = map.nodes.flatMap((node, order) => {
    if (!waitingForAnswer(node) || branchComplete(node)) return [];
    const question = questionSequence(node).current;
    if (!question) return [];
    // A dismissal holds while the question, its idea's status and its review flag stay as they were.
    const key = JSON.stringify([map.id, node.id, question.id, question.text, node.status, !!node.stale]);
    // The branch continues only once nothing blocks it, so this unblocks it only when it is the last blocker.
    return [{ node, question, order, key, blocking: node.questions.filter(isBlocking).length }];
  });
  if (!all.length) return { status: 'none-open' };
  const shown = all.filter(item => !dismissed.has(item.key));
  if (!shown.length) return { status: 'all-dismissed' };
  const counts = new Map(shown.map(item => [item.node.id, downstreamCounts(map, item.node.id)]));
  // Impact band, then a flagged branch, then unblocking it, then the agent's importance, then map order.
  const rank = item => [-band(counts.get(item.node.id).total), item.node.stale ? 0 : 1, item.blocking === 1 ? 0 : 1, importanceRank(item.question.importance), item.order];
  const compare = (a, b) => { const x = rank(a), y = rank(b); return x.map((value, i) => value - y[i]).find(Boolean) ?? 0; };
  const best = shown.sort(compare)[0], { node, question } = best, downstream = counts.get(node.id);
  const reasons = [
    ...(downstream.total ? [`${plural(downstream.total, 'idea')} ${downstream.total === 1 ? 'builds' : 'build'} on this branch (${downstream.below} below it, ${downstream.linked} linked as depending on it).`] : []),
    ...(node.stale ? ['This branch is flagged for review; answering lets it run again.'] : []),
    best.blocking === 1 ? `Last open question on “${node.title}”; answering lets your agent continue.` : `One of ${best.blocking} questions still open on “${node.title}”.`,
    ...(importanceLabel(question.importance) ? [`Your agent’s assessment: ${importanceLabel(question.importance)}.`] : []),
  ];
  return { status: 'suggested', candidate: { nodeId: node.id, questionId: question.id, title: node.title, question: question.text, key: best.key }, reasons, counts: { downstream, blocking: best.blocking } };
}

// The suggestion at the top of "Needs your answer". It owns the Not now set, which lives in browser memory only.
//   html(map)    the card, or '' when there is nothing to suggest.
//   click(event) Open question and Not now; returns true when it handled the click.
export function nextQuestionPanel({ esc, focusNode, rerender }) {
  const dismissed = new Set();
  return {
    html(map) {
      const result = suggestNextQuestion(map, { dismissed });
      if (result.status !== 'suggested') return '';
      const { candidate } = result;
      return `<div class="overview-idea next-question"><small>Suggested next</small><strong>${esc(candidate.question)}</strong><span>${esc(candidate.title)}</span>`
        + `<ul>${result.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul><div class="next-question-actions"><button type="button" class="secondary" data-next-open="${esc(candidate.nodeId)}">Open question</button>`
        + `<button type="button" class="text-button" data-next-dismiss="${esc(candidate.key)}">Not now</button></div></div>`;
    },
    click(event) {
      const open = event.target.closest('[data-next-open]');
      if (open) { focusNode(open.dataset.nextOpen); return true; }
      const dismiss = event.target.closest('[data-next-dismiss]');
      if (!dismiss) return false;
      dismissed.add(dismiss.dataset.nextDismiss); rerender();
      return true;
    },
  };
}
