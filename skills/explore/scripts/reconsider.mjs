// Compare options with your own criteria (C9): the user's criteria on an idea with options (C1), and a reconsider job
// in which the agent judges every option against them from the saved evidence and may revise its recommendation. The
// proposal stays on its job beside the original; the user adopts it or keeps the original, and nothing is overwritten.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { normalizeRecommendation, recommendationLines } from './options.mjs';
import { answerBrief } from './neighbourhood.mjs';
import { isOpenJob } from './map-validation.mjs';
import { markdownText, isInvestigationJob } from '../assets/workspace-view.js';
import { RECONSIDER, priorities, priorityWords, sortCriteria, criteriaKey, maxCriteria, criterionMax, proposalState, adoptedReconsideration, reconsiderationOutdated, assessmentBases } from '../assets/criteria.js';

class ReconsiderProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new ReconsiderProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const blocksRecommendation = node => !!node?.limitations?.some(record => record.blocksRecommendation);

// The user's criteria, as sent: up to 8 { id?, label, priority }, each label once (ignoring case). A known id is
// kept once; a new criterion, or a repeated id, gets a new one.
function normalizeCriteria(value, node) {
  need(Array.isArray(value) && value.length <= maxCriteria, `Criteria must be a list of at most ${maxCriteria}.`);
  const known = new Set((node.criteria ?? []).map(item => item.id)), seen = new Set(), labels = new Set();
  return sortCriteria(value.map((item, index) => {
    need(item && typeof item === 'object' && !Array.isArray(item), `Criterion ${index + 1} must be an object.`);
    const label = textField(typeof item.label === 'string' ? item.label.trim() : item.label, `Criterion ${index + 1}`, criterionMax, message => need(false, message));
    need(!labels.has(label.toLowerCase()), `“${label}” is already a criterion. Give each one once.`);
    labels.add(label.toLowerCase());
    need(priorities.includes(item.priority), 'Give each criterion a priority: High, Normal or Low.');
    const id = known.has(item.id) && !seen.has(item.id) ? item.id : `crit-${randomUUID().slice(0, 8)}`;
    seen.add(id);
    return { id, label, priority: item.priority };
  }));
}

export const reconsiderActions = {
  // Criteria are the user's: saving them queues nothing and changes no findings. They can always be cleared, even
  // after the idea's options went away.
  'set-criteria': { target: 'node', apply: ({ map, node, input, store }) => {
    const criteria = normalizeCriteria(input.criteria, node);
    need(!criteria.length || node.options?.length, 'This idea has no options to compare yet.', 409);
    need(criteriaKey(criteria) !== criteriaKey(node.criteria), 'Nothing changed.', 409);
    if (criteria.length) node.criteria = criteria; else delete node.criteria;
    store.event(map, 'criteria-set', node.id, `${criteria.length} criteria`);
  } },
  // Ask the agent to reconsider. Allowed on a finished branch: it never changes the idea's status or findings. It waits
  // while the idea's own investigation is open, since that result may bring different options.
  reconsider: { target: 'node', apply: ({ map, node, store }) => {
    need(node.options?.length, 'This idea has no options to compare yet.', 409);
    need(node.criteria?.length, 'Add at least one criterion first.', 409);
    need(!node.stale, 'This idea\'s findings need review after a premise changed. Review them, then reconsider.', 409);
    need(!map.jobs.some(job => job.nodeId === node.id && isOpenJob(job) && isInvestigationJob(job)), 'Your agent is still exploring this idea. Reconsider once its result is in.', 409);
    need(!map.jobs.some(job => job.type === RECONSIDER && job.nodeId === node.id && isOpenJob(job)), 'A reconsideration is already waiting for your agent.', 409);
    // What it is asked about, kept on the job: the criteria, the options and whether a limitation blocks a recommendation.
    store.enqueueJob(map, { type: RECONSIDER, nodeId: node.id, reason: 'The user asked to reconsider the recommendation with their criteria.',
      input: { criteria: node.criteria, contentRevision: node.contentRevision, options: node.options.map(({ id, title }) => ({ id, title })), blocked: blocksRecommendation(node) } });
  } },
  // Use the revised comparison: at most one adopted per idea. Only a current proposal can be adopted.
  'adopt-reconsideration': { target: 'node', apply: ({ map, node, input, store }) => {
    const job = proposalFor(map, node, input.jobId), state = proposalState(node, job);
    need(state !== 'earlier-criteria', 'This comparison is based on earlier criteria. Ask again with your current ones.', 409);
    need(state !== 'outdated', 'This comparison is outdated: the idea changed since you asked.', 409);
    need(job.outcome !== 'adopted', 'Nothing changed.', 409);
    dropAdoption(map, node);
    job.outcome = 'adopted';
    store.event(map, 'reconsideration-adopted', node.id, job.id);
  } },
  // Keep the original: the original leads again, and the proposal stays in the job history, unused.
  'dismiss-reconsideration': { target: 'node', apply: ({ map, node, input, store }) => {
    const job = proposalFor(map, node, input.jobId);
    need(job.outcome !== 'dismissed', 'Nothing changed.', 409);
    dropAdoption(map, node);
    job.outcome = 'dismissed';
    store.event(map, 'reconsideration-dismissed', node.id, job.id);
  } },
};
const dropAdoption = (map, node) => { for (const job of map.jobs) if (job.type === RECONSIDER && job.nodeId === node.id && job.outcome === 'adopted') delete job.outcome; };
function proposalFor(map, node, jobId) {
  const job = map.jobs.find(item => item.id === jobId && item.type === RECONSIDER && item.nodeId === node.id);
  need(job, 'Reconsideration not found.', 404);
  need(job.status === 'completed' && job.result, 'This reconsideration has no result yet.', 409);
  return job;
}

// The agent's result: one assessment per option and criterion it was asked about, a recommendation by C1's rules, and
// what changed. Any field beyond these, at any level, rejects it.
const assessmentFields = new Set(['optionId', 'criterionId', 'text', 'basis']), recommendationFields = new Set(['optionId', 'rationale', 'mainTradeoff', 'reconsiderIf', 'missing']);
export function normalizeReconsideration(result, { optionIds, criteria, blocked }, fail) {
  const extra = Object.keys(result).filter(key => !['assessments', 'recommendation', 'changed'].includes(key));
  if (extra.length) fail(`A reconsideration returns assessments, a recommendation and what changed; remove extra fields: ${extra.join(', ')}.`);
  const ids = new Set(optionIds), criterionIds = new Set(criteria.map(item => item.id)), pairs = new Set();
  if (!Array.isArray(result.assessments) || result.assessments.length !== ids.size * criterionIds.size) fail(`Give exactly one assessment for every option and criterion: ${ids.size * criterionIds.size} in all.`);
  const assessments = result.assessments.map((item, index) => {
    const label = `Assessment ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object.`);
    const unknown = Object.keys(item).filter(key => !assessmentFields.has(key));
    if (unknown.length) fail(`${label} has fields an assessment does not take: ${unknown.join(', ')}.`);
    if (!ids.has(item.optionId) || !criterionIds.has(item.criterionId)) fail(`${label} names an option or criterion that is not in this comparison.`);
    const key = `${item.optionId} ${item.criterionId}`;
    if (pairs.has(key)) fail(`${label} repeats an option and criterion; give exactly one assessment for every option and criterion.`);
    pairs.add(key);
    if (!assessmentBases.includes(item.basis)) fail(`${label}: basis must be evidence, reasoning or unknown.`);
    return { optionId: item.optionId, criterionId: item.criterionId, text: textField(item.text, `${label} text`, 300, fail), basis: item.basis };
  });
  const unknown = result.recommendation && typeof result.recommendation === 'object' ? Object.keys(result.recommendation).filter(key => !recommendationFields.has(key)) : [];
  if (unknown.length) fail(`The recommendation has fields it does not take: ${unknown.join(', ')}.`);
  const recommendation = normalizeRecommendation(result.recommendation, ids, fail);
  if (blocked && recommendation.optionId !== null) fail('A limitation on this idea blocks a recommendation, so the recommendation must stay optionId null with what is missing.');
  const changed = textField(result.changed, 'What changed', 600, fail);
  return { assessments, recommendation, changed };
}

const instruction = 'Reconsider the recommendation against the user\'s criteria. Do no new research: judge from the saved evidence in this packet. The priorities are the user\'s preferences, not facts, and a high priority cannot fill an evidence gap: keep optionId null with what is missing when the evidence does not settle it. Weigh each answer by how sure the user is of it. Return assessments (exactly one { optionId, criterionId, text, basis } per option and criterion; basis evidence, reasoning or unknown), a recommendation by the same rules as a comparison, and changed: what changed from the original recommendation and why, said plainly.';
const sameOptions = (node, job) => !job.input?.options || JSON.stringify(node.options?.map(option => option.id)) === JSON.stringify(job.input.options.map(option => option.id));

export const reconsiderJobTypes = {
  [RECONSIDER]: {
    label: 'Reconsider with your criteria', target: 'node',
    // The idea, its answers with how sure each is, its options (without suggested answers), the original recommendation,
    // the criteria as the user saved them, and the claims and limitations a comparison rests on. When the packet would
    // be too long, the oldest answers go first, then claims, then limitations that block nothing, and last the options'
    // own wording is shortened; what was left out is counted.
    packet: ({ job, node, budget }) => {
      need(sameOptions(node, job), 'The idea\'s options changed since the user asked, so this reconsideration was not sent. Ask again.');
      const packet = { node: { id: node.id, title: clip(node.title, 100), premise: clip(node.prompt || node.body, 2400), summary: clip(node.summary, 700),
        answers: node.questions.filter(q => q.answer && !q.supersededAt).slice(-8).map(q => answerBrief(q, { question: 300, answer: 600 })) },
        options: node.options.map(({ suggestedAnswer, ...option }) => option), ...(node.optionsLimit ? { optionsLimit: node.optionsLimit } : {}), recommendation: node.recommendation, criteria: job.input.criteria,
        ...(node.claims?.length ? { claims: node.claims.map(({ id, text }) => ({ id, text: clip(text, 300) })) } : {}),
        ...(node.limitations?.length ? { limitations: node.limitations.map(({ id, kind, summary, blocksRecommendation: blocks }) => ({ id, kind, summary: clip(summary, 300), ...(blocks ? { blocksRecommendation: blocks } : {}) })) } : {}),
        instruction };
      const limit = budget - 800, size = () => JSON.stringify(packet).length, omitted = { answers: 0, claims: 0, limitations: 0 };
      while (size() > limit && packet.node.answers.length) { packet.node.answers.shift(); omitted.answers++; }
      while (size() > limit && packet.claims?.length) { packet.claims.pop(); omitted.claims++; }
      while (size() > limit && packet.limitations?.some(record => !record.blocksRecommendation)) { packet.limitations.splice(packet.limitations.findLastIndex(record => !record.blocksRecommendation), 1); omitted.limitations++; }
      if (size() > limit) packet.options = packet.options.map(option => ({ ...option, description: clip(option.description, 240), fit: clip(option.fit, 160), pros: option.pros.map(item => clip(item, 100)), cons: option.cons.map(item => clip(item, 100)) }));
      if (size() > limit) packet.node.premise = clip(packet.node.premise, 1000);
      if (Object.values(omitted).some(Boolean)) packet.omitted = omitted;
      return packet;
    },
    // Checked against what it was asked about, so a result for options that changed since is kept and marked outdated.
    validate: (result, { job, node }) => normalizeReconsideration(result, { optionIds: (job.input?.options ?? node?.options ?? []).map(option => option.id), criteria: job.input?.criteria ?? [],
      blocked: job.input?.blocked ?? blocksRecommendation(node) }, message => need(false, message)),
    // Outdated once the idea changed or needs review after the request.
    isStale: ({ job, node }) => reconsiderationOutdated(job, node),
    recheck: true,
    // An adoption that no longer holds (the idea changed, or the criteria were edited) ends, so map.json, exports and
    // every reader agree that the original leads again.
    beforeSave: map => {
      for (const job of map.jobs) if (job.type === RECONSIDER && job.outcome === 'adopted' && proposalState(map.nodes.find(n => n.id === job.nodeId), job) !== 'current') delete job.outcome;
    },
  },
};

// Node Markdown and section reads: the criteria, and the reconsideration in use beside the original.
export function reconsiderationLines(map, node, { level = 3, format = markdownText } = {}) {
  const adopted = adoptedReconsideration(map, node);
  if (!node.criteria?.length && !adopted) return [];
  const heading = '#'.repeat(level), lines = [];
  if (node.criteria?.length) lines.push('', `${heading} Your criteria`, '', ...sortCriteria(node.criteria).map(item => `- ${priorityWords[item.priority]}: ${format(item.label)}`));
  if (adopted) lines.push('', `${heading} Reconsidered with your criteria`, '', '_The agent\'s judgement against your priorities, not a decision._', '',
    ...recommendationLines(node.options, adopted.result.recommendation, { format }), '', `What changed: ${format(adopted.result.changed)}`);
  return lines;
}
// The brief's recommendations line when a reconsideration is in use.
export function reconsideredBriefText(map, node) {
  const adopted = adoptedReconsideration(map, node); if (!adopted) return null;
  const title = id => node.options?.find(option => option.id === id)?.title;
  const revised = title(adopted.result.recommendation.optionId), original = title(node.recommendation?.optionId);
  return `Reconsidered with your criteria: ${revised ?? 'no recommendation yet'}. Original: ${original ?? 'no recommendation yet'}. What changed: ${adopted.result.changed}`;
}
