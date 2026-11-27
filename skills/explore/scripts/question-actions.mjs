import { isOpen, isBlocking, normalizeQuestion } from '../assets/questions.js';

// The question ⋯ menu (B7): rate a question, dismiss it, bring it back, or ask for a better one.
// Ratings and dismissals are the user's feedback, never content: they don't re-run research, and
// they travel with later work on the map so the agent asks fewer questions like the bad ones.
export const REGENERATE = 'regenerate-question';

class QuestionProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new QuestionProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const now = () => new Date().toISOString();
const reasonText = value => {
  if (value === undefined || value === null || value === '') return undefined;
  need(typeof value === 'string' && value.length <= 600, 'A reason must be at most 600 characters.');
  return value.trim() || undefined;
};
function findQuestion(node, questionId) {
  const question = node.questions.find(q => q.id === questionId);
  need(question, 'Question not found.', 404);
  return question;
}
const by = actor => actor?.name ? { name: actor.name } : undefined;

// The map's most recent question feedback, newest first: what the user rated, dismissed or replaced.
export function questionFeedback(map, limit = 10) {
  const all = map.nodes.flatMap(node => node.questions.filter(q => q.rating || q.dismissedAt || (q.replacedBy && q.replacedBy !== 'pending')).map(q => ({
    at: q.ratedAt || q.dismissedAt || q.askedAt || '', text: clip(q.text, 200),
    ...(q.rating ? { rating: q.rating } : {}), ...(q.ratingReason ? { reason: clip(q.ratingReason, 300) } : {}),
    ...(q.dismissedAt ? { dismissed: true } : {}), ...(q.replacedBy && q.replacedBy !== 'pending' ? { regenerated: true } : {}),
  })));
  all.sort((a, b) => b.at.localeCompare(a.at));
  return { items: all.slice(0, limit).map(({ at, ...item }) => item), omitted: Math.max(0, all.length - limit) };
}

// A stopped or failed regeneration gives the user the original question back.
function restoreOriginal(node, questionId) {
  const original = node?.questions.find(q => q.id === questionId);
  if (original?.replacedBy !== 'pending') return;
  delete original.replacedBy; delete original.dismissedAt; delete original.dismissedBy;
}

export const questionActions = {
  'rate-question': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const question = findQuestion(node, input.questionId);
    need(!question.supersededAt, 'This question belongs to an earlier premise.', 409);
    need(input.rating === null || ['good', 'bad'].includes(input.rating), 'Rate a question good or bad, or clear the rating.');
    for (const field of ['rating', 'ratingReason', 'ratedAt', 'ratedBy']) delete question[field];
    if (input.rating) {
      const reason = reasonText(input.reason);
      Object.assign(question, { rating: input.rating, ...(reason ? { ratingReason: reason } : {}), ratedAt: now(), ...(by(actor) ? { ratedBy: by(actor) } : {}) });
    }
    store.event(map, 'question-rated', node.id, `${question.id}: ${input.rating ?? 'cleared'}`);
  } },
  'dismiss-question': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    need(!store.isComplete(map, node), 'This branch is complete. Add a new direction instead.', 409);
    const question = findQuestion(node, input.questionId);
    need(isOpen(question), 'Only an open question can be dismissed.', 409);
    Object.assign(question, { dismissedAt: now(), ...(by(actor) ? { dismissedBy: by(actor) } : {}) });
    store.event(map, 'question-dismissed', node.id, question.id);
    if (!node.questions.some(isBlocking)) store.enqueue(map, node, 'The user dismissed the remaining questions. Continue without them and do not ask them again.');
  } },
  'restore-question': { target: 'node', apply: ({ map, node, input, store }) => {
    const question = findQuestion(node, input.questionId);
    need(question.dismissedAt && !question.replacedBy, 'Only a dismissed question can be brought back.', 409);
    need(node.status === 'awaiting-answer' && !store.isComplete(map, node), 'A question can be brought back only while its branch is waiting for answers.', 409);
    delete question.dismissedAt; delete question.dismissedBy;
    store.event(map, 'question-restored', node.id, question.id);
  } },
  // Replace an unhelpful question: the original is set aside and the branch waits for the new one.
  'regenerate-question': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    need(!store.isComplete(map, node), 'This branch is complete. Add a new direction instead.', 409);
    const question = findQuestion(node, input.questionId);
    need(isOpen(question), 'Only an open question can be regenerated.', 409);
    const reason = reasonText(input.reason);
    Object.assign(question, { dismissedAt: now(), ...(by(actor) ? { dismissedBy: by(actor) } : {}), replacedBy: 'pending',
      ...(reason ? { rating: 'bad', ratingReason: reason, ratedAt: now(), ...(by(actor) ? { ratedBy: by(actor) } : {}) } : {}) });
    store.enqueueJob(map, { type: REGENERATE, nodeId: node.id, subjectId: question.id, reason: 'The user asked for a better question.', input: reason ? { reason } : {} });
  } },
};

const regenerateInstruction = 'Ask one replacement question that serves the same purpose better. Take the user\'s reason into account. Do not repeat the original or any dismissed question, and do not answer it. Return {"question": {"text": "…", "importance": "low|medium|high", "why": "…"}} through the CLI; importance and why are optional, and importance needs why.';

export const questionJobTypes = {
  [REGENERATE]: {
    label: 'Regenerate a question', target: 'node',
    packet: ({ map, job, node }) => {
      const original = node.questions.find(q => q.id === job.subjectId);
      return {
        question: { id: original?.id, text: clip(original?.text, 600), ...(original?.why ? { why: clip(original.why, 600) } : {}) }, userReason: job.input?.reason ?? null,
        node: { id: node.id, title: clip(node.title, 100), premise: clip(node.prompt || node.body, 600), summary: clip(node.summary, 400) },
        answeredQuestions: node.questions.filter(q => q.answer && !q.supersededAt).slice(-6).map(q => ({ question: clip(q.text, 200), answer: clip(q.answer, 300) })),
        openQuestions: node.questions.filter(isOpen).map(q => clip(q.text, 200)),
        questionFeedback: questionFeedback(map, 10).items, instruction: regenerateInstruction,
      };
    },
    validate: result => {
      return { question: normalizeQuestion(result.question, message => need(false, message)) };
    },
    // A replacement only makes sense while the original is still waiting to be replaced.
    isStale: ({ job, node }) => { const original = node?.questions.find(q => q.id === job.subjectId); return !original || original.replacedBy !== 'pending' || !!original.supersededAt; },
    store: ({ job, result, stale, makeId, at, map }) => {
      const node = map.nodes.find(n => n.id === job.nodeId), original = node?.questions.find(q => q.id === job.subjectId);
      if (stale) { if (original?.replacedBy === 'pending') delete original.replacedBy; return; }
      const fresh = { id: makeId('q'), ...result.question, answer: null, askedAt: at, jobId: job.id, replaces: original.id };
      node.questions.push(fresh); original.replacedBy = fresh.id; node.contentRevision++;
    },
    release: ({ map, job }) => restoreOriginal(map.nodes.find(n => n.id === job.nodeId), job.subjectId),
  },
};
