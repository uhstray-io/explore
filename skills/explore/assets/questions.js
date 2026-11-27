// Shared by the Store, the agent-facing views and the browser: which questions are open, which
// still block their branch, and how sure a saved answer is. Keep these pure; later features
// (suggest the next question, assumptions register, filters, usage) build on them.
export const answerStates = ['tentative', 'decided', 'assumption'];
export const answerStateLabels = { tentative: 'Tentative', decided: 'Decided', assumption: 'Assumption' };

// Open: still waiting for an answer and not set aside by a changed premise or a dismissal.
export function isOpen(question) { return !question.answer && !question.supersededAt && !question.dismissedAt; }
// Blocking: open and not saved for later. Only blocking questions pause a branch.
// A question being regenerated also blocks: the branch waits for its replacement.
export function isBlocking(question) { return (isOpen(question) && !question.deferredAt) || (question.replacedBy === 'pending' && !question.supersededAt); }
// Older answers have no recorded certainty; they count as Tentative and say so.
export function effectiveAnswerState(question) {
  if (!question.answer) return null;
  return answerStates.includes(question.answerState) ? { state: question.answerState, recorded: true } : { state: 'tentative', recorded: false };
}
export function certaintyText(question) {
  const certainty = effectiveAnswerState(question);
  return certainty ? `${answerStateLabels[certainty.state]}${certainty.recorded ? '' : ' (not recorded)'}` : null;
}

// How much an answer matters (B2): the agent's judgement of its impact on the decision, recorded with
// the question as asked. It is not confidence or urgency, and it is never reassessed.
export const importanceLevels = ['high', 'medium', 'low'];
const importanceWords = { high: 'High', medium: 'Medium', low: 'Low' };
export function importanceName(question) { return importanceWords[question.importance] ?? 'Unranked'; }
export function importanceLabel(question) { return importanceLevels.includes(question.importance) ? `${importanceWords[question.importance]} importance` : null; }
// Unranked questions come last. Sorting by rank is stable, so map order holds within a level.
export function importanceRank(question) { const index = importanceLevels.indexOf(question.importance); return index < 0 ? importanceLevels.length : index; }
export function highestImportance(questions) { return importanceLevels[Math.min(importanceLevels.length, ...questions.filter(isOpen).map(importanceRank))] ?? null; }
