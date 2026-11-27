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
export function importanceName(level) { return Object.hasOwn(importanceWords, level) ? importanceWords[level] : 'Unranked'; }
export function importanceLabel(level) { return Object.hasOwn(importanceWords, level) ? `${importanceWords[level]} importance` : null; }
// Unranked sorts last. Sorting by rank is stable, so map order holds within a level.
export function importanceRank(level) { const index = importanceLevels.indexOf(level); return index < 0 ? importanceLevels.length : index; }
export function highestImportance(questions) { return importanceLevels[Math.min(importanceLevels.length, ...questions.filter(isOpen).map(q => importanceRank(q.importance)))] ?? null; }
// A question as an agent sends it: a string, or { text, importance, why } where null means not given.
// A rank always comes with its reason. `fail(message)` must throw, as in normalizeComparison.
export function normalizeQuestion(value, fail) {
  const asked = typeof value === 'string' ? { text: value } : value;
  if (!asked || typeof asked !== 'object' || Array.isArray(asked)) fail('A question must be text or { text, importance, why }.');
  const text = typeof asked.text === 'string' ? asked.text.trim() : '';
  if (!text) fail('A question needs its text.');
  if (text.length > 1600) fail('A question must be at most 1,600 characters.');
  const question = { text };
  if (asked.why != null) {
    if (typeof asked.why !== 'string' || !asked.why.trim()) fail("A question's why must be text.");
    if (asked.why.trim().length > 600) fail("A question's why must be at most 600 characters.");
    question.why = asked.why.trim();
  }
  if (asked.importance != null) {
    if (!importanceLevels.includes(asked.importance)) fail('Importance must be low, medium or high.');
    if (!question.why) fail('Importance needs a reason: add why, saying what the answer would change.');
    question.importance = asked.importance;
  }
  return question;
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
