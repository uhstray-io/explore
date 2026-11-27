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

// A saved answer that still stands: not from an earlier premise and not set aside.
export function hasCurrentAnswer(question) { return !!question.answer && !question.supersededAt && !question.dismissedAt; }
// When the current answer was given: a changed answer counts from its change.
export function answeredSince(question) { return question.changedAt ?? question.answeredAt ?? null; }
// When a question was asked. Questions from before `askedAt` was recorded are dated by the run that asked them.
export function askedAt(map, question) { return question.askedAt ?? map.jobs.find(job => job.result?.questions?.some(asked => asked.id === question.id))?.startedAt ?? null; }
// Follow-ups asked after `question` was answered, which a changed answer no longer fits.
// Without both dates nothing counts as later.
export function laterQuestions(map, node, question) {
  const since = answeredSince(question);
  return since ? node.questions.filter(other => other !== question && !other.supersededAt && (askedAt(map, other) ?? '') > since) : [];
}
// Replaces an answer and keeps the old one in `previousAnswers`; `mark` says why, e.g. { wordingFix: true }.
export function replaceAnswer(question, { answer, answerState, actor, at, mark = {} }) {
  const since = answeredSince(question);
  question.previousAnswers = [...(question.previousAnswers || []), { answer: question.answer, ...(question.answerState ? { answerState: question.answerState } : {}), ...(since ? { answeredAt: since } : {}), replacedAt: at, ...mark }];
  Object.assign(question, { answer, changedAt: at }, answerState ? { answerState } : {}, actor?.name ? { answeredBy: { name: actor.name } } : {});
}
