// Compare options with your own criteria (C9): the user's criteria on an idea with options (C1), and a reconsider job
// in which the agent judges every option against them from the saved evidence and may revise its recommendation. The
// proposal stays on its job beside the original; the user adopts it or keeps the original, and nothing is overwritten.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { normalizeRecommendation } from './options.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { RECONSIDER, priorities, priorityWords, sortCriteria, maxCriteria, criterionMax, reconsiderationsOf, proposalState, reconsiderationOutdated, assessmentBases } from '../assets/criteria.js';

class ReconsiderProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new ReconsiderProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const isOpenJob = job => job.status === 'queued' || job.status === 'running';

// The user's criteria, as sent: up to 8 { id?, label, priority }. A known id is kept; a new criterion gets one.
function normalizeCriteria(value, node) {
  need(Array.isArray(value) && value.length <= maxCriteria, `Criteria must be a list of at most ${maxCriteria}.`);
  const known = new Set((node.criteria ?? []).map(item => item.id)), seen = new Set();
  return sortCriteria(value.map((item, index) => {
    need(item && typeof item === 'object' && !Array.isArray(item), `Criterion ${index + 1} must be an object.`);
    const label = textField(typeof item.label === 'string' ? item.label.trim() : item.label, `Criterion ${index + 1}`, criterionMax, message => need(false, message));
    need(priorities.includes(item.priority), 'Give each criterion a priority: High, Normal or Low.');
    const id = known.has(item.id) && !seen.has(item.id) ? item.id : `crit-${randomUUID().slice(0, 8)}`;
    seen.add(id);
    return { id, label, priority: item.priority };
  }));
}

export const reconsiderActions = {
  // Criteria are the user's: saving them queues nothing and changes no findings.
  'set-criteria': { target: 'node', apply: ({ map, node, input, store }) => {
    need(node.options?.length, 'This idea has no options to compare yet.', 409);
    const criteria = normalizeCriteria(input.criteria, node);
    if (criteria.length) node.criteria = criteria; else delete node.criteria;
    store.event(map, 'criteria-set', node.id, `${criteria.length} criteria`);
  } },
  // Ask the agent to reconsider. Allowed on a finished branch: it never changes the idea's status or findings.
  reconsider: { target: 'node', apply: ({ map, node, store }) => {
    need(node.options?.length, 'This idea has no options to compare yet.', 409);
    need(node.criteria?.length, 'Add at least one criterion first.', 409);
    need(!node.stale, 'This idea\'s findings need review after a premise changed. Review them, then reconsider.', 409);
    need(!map.jobs.some(job => job.type === RECONSIDER && job.nodeId === node.id && isOpenJob(job)), 'A reconsideration is already waiting for your agent.', 409);
    store.enqueueJob(map, { type: RECONSIDER, nodeId: node.id, reason: 'The user asked to reconsider the recommendation with their criteria.', input: { criteria: node.criteria, contentRevision: node.contentRevision } });
  } },
  // Use the revised comparison: at most one adopted per idea. Only a current proposal can be adopted.
  'adopt-reconsideration': { target: 'node', apply: ({ map, node, input, store }) => {
    const job = proposalFor(map, node, input.jobId), state = proposalState(node, job);
    need(state !== 'earlier-criteria', 'This comparison is based on earlier criteria. Ask again with your current ones.', 409);
    need(state !== 'outdated', 'This comparison is outdated: the idea changed since you asked.', 409);
    for (const other of map.jobs) if (other.type === RECONSIDER && other.nodeId === node.id && other.outcome === 'adopted') delete other.outcome;
    job.outcome = 'adopted';
    store.event(map, 'reconsideration-adopted', node.id, job.id);
  } },
  // Keep the original: the proposal stays in the job history, unused.
  'dismiss-reconsideration': { target: 'node', apply: ({ map, node, input, store }) => {
    const job = proposalFor(map, node, input.jobId);
    need(job.outcome !== 'dismissed', 'Nothing changed.', 409);
    job.outcome = 'dismissed';
    store.event(map, 'reconsideration-dismissed', node.id, job.id);
  } },
};
function proposalFor(map, node, jobId) {
  const job = map.jobs.find(item => item.id === jobId && item.type === RECONSIDER && item.nodeId === node.id);
  need(job, 'Reconsideration not found.', 404);
  need(job.status === 'completed' && job.result, 'This reconsideration has no result yet.', 409);
  return job;
}

// The agent's result: one assessment per option and criterion, a recommendation by C1's rules, and what changed.
export function normalizeReconsideration(result, { options, criteria, blocked }, fail) {
  const extra = Object.keys(result).filter(key => !['assessments', 'recommendation', 'changed'].includes(key));
  if (extra.length) fail(`A reconsideration returns assessments, a recommendation and what changed; remove extra fields: ${extra.join(', ')}.`);
  const optionIds = new Set(options.map(option => option.id)), criterionIds = new Set(criteria.map(item => item.id)), pairs = new Set();
  if (!Array.isArray(result.assessments) || result.assessments.length !== options.length * criteria.length) fail(`Give exactly one assessment for every option and criterion: ${options.length * criteria.length} in all.`);
  const assessments = result.assessments.map((item, index) => {
    const label = `Assessment ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object.`);
    if (!optionIds.has(item.optionId) || !criterionIds.has(item.criterionId)) fail(`${label} names an option or criterion that is not in this comparison.`);
    const key = `${item.optionId} ${item.criterionId}`;
    if (pairs.has(key)) fail(`${label} repeats an option and criterion; give exactly one assessment for every option and criterion.`);
    pairs.add(key);
    if (!assessmentBases.includes(item.basis)) fail(`${label}: basis must be evidence, reasoning or unknown.`);
    return { optionId: item.optionId, criterionId: item.criterionId, text: textField(item.text, `${label} text`, 300, fail), basis: item.basis };
  });
  const recommendation = normalizeRecommendation(result.recommendation, optionIds, fail);
  if (blocked && recommendation.optionId !== null) fail('A limitation on this idea blocks a recommendation, so the recommendation must stay optionId null with what is missing.');
  const changed = textField(result.changed, 'What changed', 600, fail);
  return { assessments, recommendation, changed };
}

const instruction = 'Reconsider the recommendation against the user\'s criteria. Do no new research: judge from the saved evidence in this packet. The priorities are the user\'s preferences, not facts, and a high priority cannot fill an evidence gap: keep optionId null with what is missing when the evidence does not settle it. Return assessments (exactly one { optionId, criterionId, text, basis } per option and criterion; basis evidence, reasoning or unknown), a recommendation by the same rules as a comparison, and changed: what changed from the original recommendation and why, said plainly.';

export const reconsiderJobTypes = {
  [RECONSIDER]: {
    label: 'Reconsider with your criteria', target: 'node',
    // The idea, its answers, all its options, the original recommendation, the criteria as the user saved them, and
    // the claims and limitations a comparison rests on. The oldest answers go first if the packet would be too long.
    packet: ({ job, node, budget }) => {
      const packet = { node: { id: node.id, title: clip(node.title, 100), premise: clip(node.prompt || node.body, 2400), summary: clip(node.summary, 700),
        answers: node.questions.filter(q => q.answer && !q.supersededAt).slice(-8).map(q => ({ question: clip(q.text, 300), answer: clip(q.answer, 600) })) },
        options: node.options, ...(node.optionsLimit ? { optionsLimit: node.optionsLimit } : {}), recommendation: node.recommendation, criteria: job.input.criteria,
        ...(node.claims?.length ? { claims: node.claims.map(({ id, text }) => ({ id, text: clip(text, 300) })) } : {}),
        ...(node.limitations?.length ? { limitations: node.limitations.map(({ id, kind, summary, blocksRecommendation }) => ({ id, kind, summary: clip(summary, 300), ...(blocksRecommendation ? { blocksRecommendation } : {}) })) } : {}),
        instruction };
      const limit = budget - 800;
      while (JSON.stringify(packet).length > limit && packet.node.answers.length) packet.node.answers.shift();
      return packet;
    },
    validate: (result, { job, node }) => normalizeReconsideration(result, { options: node?.options ?? [], criteria: job.input?.criteria ?? [], blocked: !!node?.limitations?.some(record => record.blocksRecommendation) }, message => need(false, message)),
    // Outdated once the idea changed or needs review after the request.
    isStale: ({ job, node }) => reconsiderationOutdated(job, node),
    recheck: true,
  },
};

// Node Markdown and section reads: the criteria, and the adopted reconsideration beside the original.
export function reconsiderationLines(map, node, { level = 3, format = markdownText } = {}) {
  if (!node.criteria?.length && !reconsiderationsOf(map, node.id).adopted) return [];
  const heading = '#'.repeat(level), lines = [];
  if (node.criteria?.length) lines.push('', `${heading} Your criteria`, '', ...sortCriteria(node.criteria).map(item => `- ${priorityWords[item.priority]}: ${format(item.label)}`));
  const adopted = reconsiderationsOf(map, node.id).adopted;
  if (adopted) {
    const r = adopted.result.recommendation, chosen = node.options?.find(option => option.id === r.optionId);
    lines.push('', `${heading} Reconsidered with your criteria`, '', '_The agent\'s judgement against your priorities, not a decision._', '',
      chosen ? `Recommended: ${format(chosen.title)} (${chosen.id}). ${format(r.rationale)} Main trade-off: ${format(r.mainTradeoff)}` : `No recommendation yet: ${format(r.missing ?? '')}`,
      '', `What changed: ${format(adopted.result.changed)}`);
  }
  return lines;
}
// The brief's recommendations line when a reconsideration was adopted.
export function reconsideredBriefText(map, node) {
  const adopted = reconsiderationsOf(map, node.id).adopted; if (!adopted) return null;
  const title = id => node.options?.find(option => option.id === id)?.title;
  const revised = title(adopted.result.recommendation.optionId), original = title(node.recommendation?.optionId);
  return `Reconsidered with your criteria: ${revised ?? 'no recommendation yet'}. Original: ${original ?? 'no recommendation yet'}. What changed: ${adopted.result.changed}`;
}
