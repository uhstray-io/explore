import { isOpen, isBlocking, normalizeQuestion, canResearch, EXPLAIN, RESEARCH, TIDY } from '../assets/questions.js';
import { normalizeComparison } from './options.mjs';
import { textField, sourceList } from './fields.mjs';
import { nearbyIdeas, nearbyBrief, answerBrief, ownFindings, signature } from './neighbourhood.mjs';

// The question ⋯ menu (B7): rate a question, dismiss it, bring it back, or ask for a better one.
// Ratings and dismissals are the user's feedback, never content: they don't re-run research, and
// they travel with later work on the map so the agent asks fewer questions like the bad ones.
export const REGENERATE = 'regenerate-question';
// Explain this question (B4) explains what a question asks; Help me answer (B9) researches it. Neither answers.
export { EXPLAIN, RESEARCH, TIDY };

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
// An open question on an unfinished branch: the only kind that can be explained, dismissed or regenerated.
function openQuestion(map, node, questionId, store, verb) {
  need(!store.isComplete(map, node), 'This branch is complete. Add a new direction instead.', 409);
  const question = findQuestion(node, questionId);
  need(isOpen(question), `Only an open question can be ${verb}.`, 409);
  return question;
}
// The question a job is about, if its idea still has it.
const subjectOf = (job, node) => node?.questions.find(q => q.id === job.subjectId);
// An idea as a packet shows it, clipped to the given lengths.
const nodeBrief = (node, { premise, summary }) => ({ id: node.id, title: clip(node.title, 100), premise: clip(node.prompt || node.body, premise), summary: clip(node.summary, summary) });

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
    const question = openQuestion(map, node, input.questionId, store, 'dismissed');
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
  // Explain an open question. The help stays on its job; the branch keeps waiting for the user's answer.
  'request-help': { target: 'node', apply: ({ map, node, input, store }) => {
    const question = openQuestion(map, node, input.questionId, store, 'explained');
    store.enqueueJob(map, { type: EXPLAIN, nodeId: node.id, subjectId: question.id, reason: 'The user asked what this question means.', input: { question: question.text } });
  } },
  // Research a question the user is still deciding, answered or not. The research stays on its job.
  'request-research': { target: 'node', apply: ({ map, node, input, store }) => {
    const completed = store.isComplete(map, node);
    need(!completed, 'This branch is complete. Add a new direction instead.', 409);
    const question = findQuestion(node, input.questionId);
    need(canResearch(question, { completed }), 'Only a current question can be researched.', 409);
    store.enqueueJob(map, { type: RESEARCH, nodeId: node.id, subjectId: question.id, reason: 'The user asked for help answering this question.', input: { question: question.text } });
  } },
  // Tidy my wording: the draft goes to the agent; the branch keeps waiting and nothing is answered.
  'clean-answer': { target: 'node', apply: ({ map, node, input, store }) => {
    const question = openQuestion(map, node, input.questionId, store, 'tidied');
    const text = textField(input.text, 'Your answer', 12000, message => need(false, message));
    need(JSON.stringify(text).length <= 11000, 'This answer is too long to tidy in one go. Tidy part of it, or save it as it is.'); // So the packet fits its budget.
    store.enqueueJob(map, { type: TIDY, nodeId: node.id, subjectId: question.id, reason: 'The user asked to tidy the wording of their answer.', input: { text }, transient: true });
  } },
  // The user used the tidied wording or kept their own. Either way the draft and the proposal leave the map. No
  // event is recorded, so neither text reaches the event log.
  'resolve-clean': { target: 'map', apply: ({ map, input }) => {
    need(['applied', 'rejected'].includes(input.outcome), 'Choose whether you used the tidied wording (applied) or kept yours (rejected).');
    const job = map.jobs.find(j => j.id === input.jobId && j.type === TIDY);
    need(job, 'This tidied wording was not found.', 404);
    need(job.status === 'completed' && !job.outcome, 'This tidied wording was already used or set aside.', 409);
    Object.assign(job, { outcome: input.outcome, resolvedAt: now() }); delete job.input; delete job.result;
  } },
  // Replace an unhelpful question: the original is set aside and the branch waits for the new one.
  'regenerate-question': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const question = openQuestion(map, node, input.questionId, store, 'regenerated');
    need(!question.deferredAt, 'A question saved for later cannot be regenerated. Answer it, or ask for research to help.', 409);
    const reason = reasonText(input.reason);
    Object.assign(question, { dismissedAt: now(), ...(by(actor) ? { dismissedBy: by(actor) } : {}), replacedBy: 'pending',
      ...(reason ? { rating: 'bad', ratingReason: reason, ratedAt: now(), ...(by(actor) ? { ratedBy: by(actor) } : {}) } : {}) });
    store.enqueueJob(map, { type: REGENERATE, nodeId: node.id, subjectId: question.id, reason: 'The user asked for a better question.', input: reason ? { reason } : {} });
  } },
};

const regenerateInstruction = 'Ask one replacement question that serves the same purpose better. Take the user\'s reason into account. Do not repeat the original or any dismissed question, and do not answer it. Return {"question": {"text": "…", "importance": "low|medium|high", "why": "…"}} through the CLI; importance and why are optional, and importance needs why.';

const explainInstruction = 'Explain what this question asks and why it matters, define unfamiliar terms, and give one clearly illustrative example. Do not answer it or recommend an answer. Return {"help": "…"} through the CLI (at most 3,000 characters).';

const researchInstruction = 'Research this question so the user can answer it. Return options and a recommendation in the options format. Do not answer for the user; suggested answers are drafts they may copy. Do not ask questions or propose branches. Research only as deep as choosing needs, prefer primary sources and cite only sources you read. When the evidence does not settle it, use optionId null and say what is missing rather than force a winner. Return {"options": […], "recommendation": {…}, "summary": "…", "sources": […]} through the CLI; optionsLimit only with a single option, summary and sources optional.';
const researchFields = new Set(['options', 'optionsLimit', 'recommendation', 'summary', 'sources']);
// Research belongs to the question and its context as the agent read them: a changed premise or answer
// nearby, or a question set aside, makes it earlier research, whether that happened before or after it arrived.
export function researchIsStale(map, job) {
  const node = map.nodes.find(n => n.id === job.nodeId), question = subjectOf(job, node);
  return !question || !canResearch(question) || job.inputSignature !== signature(map, node);
}

const tidyInstruction = 'Tidy the user\'s draft answer: fix punctuation, spelling and grammar, make it clearer and remove repetition. Keep the meaning, any uncertainty, names, numbers and the user\'s voice. Add nothing and answer nothing new, and do no research or tool use. Return {"text": "…", "changes": "…"} through the CLI: text at most 12,000 characters, changes an optional short note of what you changed (at most 300).';

export const questionJobTypes = {
  [TIDY]: {
    label: 'Tidy an answer', target: 'node',
    // The question and the draft only: no nearby ideas, findings or file paths.
    packet: ({ job, node }) => ({ question: { id: job.subjectId, text: clip(subjectOf(job, node)?.text ?? '', 1600) }, draft: job.input?.text ?? '', instruction: tidyInstruction }),
    validate: result => {
      const fail = message => need(false, message);
      need(Object.keys(result).every(key => key === 'text' || key === 'changes'), 'Return {"text": "…", "changes": "…"} and nothing else. Never answer for the user.');
      const changes = textField(result.changes, 'Changes', 300, fail, { optional: true });
      return { text: textField(result.text, 'Tidied wording', 12000, fail), ...(changes ? { changes } : {}) };
    },
    // A tidied wording only fits a question still waiting for this answer.
    isStale: ({ job, node }) => { const question = subjectOf(job, node); return !question || !isOpen(question); },
    recheck: true,
    release: ({ job }) => { delete job.input; }, // Stopped, failed or interrupted: the draft leaves the map.
    // Only the newest unresolved request of a question still open keeps the user's texts. Every other one gives
    // them up, and a queued one whose question was answered or set aside is stopped before an agent reads it.
    beforeSave: map => {
      const newest = new Map();
      for (const job of map.jobs) if (job.type === TIDY && !job.outcome && ['queued', 'running', 'completed'].includes(job.status)) newest.set(job.subjectId, job);
      for (const job of map.jobs) {
        if (job.type !== TIDY || (!job.input && !job.result)) continue;
        const question = subjectOf(job, map.nodes.find(n => n.id === job.nodeId));
        if (newest.get(job.subjectId) === job && question && isOpen(question)) continue;
        if (job.status === 'queued') Object.assign(job, { status: 'cancelled', finishedAt: now() });
        delete job.input; delete job.result;
      }
    },
  },
  [RESEARCH]: {
    label: 'Research a question', target: 'node',
    // The question (with its current answer, if any), its idea with findings and the user's other answers there,
    // and the same nearby ideas an investigation reads, nearest first; the farthest are left out first when the
    // packet would be too long, and counted.
    packet: ({ map, job, node, budget }) => {
      const question = subjectOf(job, node), findings = ownFindings(node);
      const packet = {
        question: { id: job.subjectId, text: clip(question?.text ?? job.input?.question, 1600), ...(question?.why ? { why: clip(question.why, 600) } : {}), ...(question?.answer ? { currentAnswer: clip(question.answer, 1200) } : {}) },
        node: { ...nodeBrief(node, { premise: 2400, summary: 700 }), findings: clip(findings, 4000), status: node.status, reviewState: node.reviewState, stale: !!node.stale,
          answers: node.questions.filter(q => q.answer && q.id !== job.subjectId).slice(-8).map(q => answerBrief(q, { question: 300, answer: 600 })) },
        context: nearbyIdeas(map, node).map(nearbyBrief),
        omittedContext: 0,
        retrieval: 'Use CLI read --map MAP --node NODE --section premise|findings|questions|sources to read more of any idea named here.',
        instruction: researchInstruction,
      };
      // 800 characters stay free for the fields every packet carries.
      const limit = budget - 800, size = () => JSON.stringify(packet).length;
      while (size() > limit && packet.context.length) { packet.context.pop(); packet.omittedContext++; }
      if (size() > limit) packet.node.findings = clip(findings, 1500);
      while (size() > limit && packet.node.answers.length) packet.node.answers.shift(); // The oldest answers are dropped first.
      return packet;
    },
    validate: result => {
      const extra = Object.keys(result).filter(key => !researchFields.has(key)), fail = message => need(false, message);
      need(!extra.length, `Research returns options, a recommendation and optionally a summary and sources; remove ${extra.join(', ')}. Never answer for the user or ask questions.`);
      need(result.options !== undefined, 'Return options and a recommendation, or optionId null with what is missing.');
      const summary = textField(result.summary, 'Summary', 800, fail, { optional: true });
      return { ...normalizeComparison(result, fail), ...(summary ? { summary } : {}), sources: sourceList(result.sources, fail) };
    },
    isStale: ({ map, job }) => researchIsStale(map, job),
    recheck: true, // Checked again whenever the map is shown, so research reads as earlier as soon as its context changes.
  },
  [EXPLAIN]: {
    label: 'Explain a question', target: 'node',
    // The question, its idea and the path up to the root; nothing from other branches, drafts or research.
    packet: ({ map, job, node, budget }) => {
      const question = subjectOf(job, node), ancestors = [];
      // Parent loops are refused when a map is read, so this walk ends at the root.
      for (let at = map.nodes.find(n => n.id === node.parentId); at; at = map.nodes.find(n => n.id === at.parentId)) ancestors.push({ title: clip(at.title, 100), summary: clip(at.summary, 400) });
      const packet = { question: { id: job.subjectId, text: clip(question?.text ?? job.input?.question, 1600) },
        node: nodeBrief(node, { premise: 1200, summary: 600 }), ancestors, omittedAncestors: 0, instruction: explainInstruction };
      // The farthest ancestors go first; 800 characters stay free for the fields every packet carries.
      const limit = Math.min(budget, 6000) - 800;
      while (JSON.stringify(packet).length > limit && packet.ancestors.length) { packet.ancestors.pop(); packet.omittedAncestors++; }
      return packet;
    },
    validate: result => {
      need(Object.keys(result).length === 1 && typeof result.help === 'string' && result.help.trim(), 'Return {"help": "…"}: an explanation and an example, and nothing else.');
      need(result.help.trim().length <= 3000, 'Help must be at most 3,000 characters.');
      return { help: result.help.trim() };
    },
    // Help belongs to the question as it was asked; once it is answered, set aside or reworded, it is history.
    isStale: ({ job, node }) => { const question = subjectOf(job, node); return !question || !isOpen(question) || question.text !== job.input?.question; },
  },
  [REGENERATE]: {
    label: 'Regenerate a question', target: 'node',
    packet: ({ map, job, node }) => {
      const original = subjectOf(job, node);
      return {
        question: { id: original?.id, text: clip(original?.text, 600), ...(original?.why ? { why: clip(original.why, 600) } : {}) }, userReason: job.input?.reason ?? null,
        node: nodeBrief(node, { premise: 600, summary: 400 }),
        answeredQuestions: node.questions.filter(q => q.answer && !q.supersededAt).slice(-6).map(q => ({ question: clip(q.text, 200), answer: clip(q.answer, 300) })),
        openQuestions: node.questions.filter(isOpen).map(q => clip(q.text, 200)),
        questionFeedback: questionFeedback(map, 10).items, instruction: regenerateInstruction,
      };
    },
    validate: result => {
      return { question: normalizeQuestion(result.question, message => need(false, message)) };
    },
    // A replacement only makes sense while the original is still waiting to be replaced.
    isStale: ({ job, node }) => { const original = subjectOf(job, node); return !original || original.replacedBy !== 'pending' || !!original.supersededAt; },
    store: ({ job, result, stale, makeId, at, map }) => {
      const node = map.nodes.find(n => n.id === job.nodeId), original = subjectOf(job, node);
      if (stale) { if (original?.replacedBy === 'pending') delete original.replacedBy; return; }
      const fresh = { id: makeId('q'), ...result.question, answer: null, askedAt: at, jobId: job.id, replaces: original.id };
      node.questions.push(fresh); original.replacedBy = fresh.id; node.contentRevision++;
    },
    release: ({ map, job }) => restoreOriginal(map.nodes.find(n => n.id === job.nodeId), job.subjectId),
  },
};
