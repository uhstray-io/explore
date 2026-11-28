import { createHash } from 'node:crypto';
import { packetBudget } from './guidance.mjs';
import { textField, sourceList } from './fields.mjs';
import { isOpen, effectiveAnswerState, certaintyText } from '../assets/questions.js';

// Map jobs (F1) read across many saved answers instead of one branch. The first is "Check answers":
// the agent points out possible tensions, unresolved choices and untested assumptions. Results become
// a proposal the user reviews item by item; nothing in the map changes otherwise, and nothing runs
// until the user asks. Later reviews (F2, F4, F5, K8) register here too.
export const CHECK_ANSWERS = 'check-answers';
export const categories = ['possible-tension', 'unresolved-choice', 'untested-assumption'];
// Records a claimed job read, kept on the job (never sent to the agent) so results can be checked against them.
export const includedKey = Symbol('included');

class MapJobProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new MapJobProblem(message, status); };
const fail = message => need(false, message);
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

// Ideas in tree order from the root, then any outside the tree, in saved order.
function rootFirst(map) {
  const children = new Map(map.nodes.map(node => [node.id, []]));
  for (const node of map.nodes) children.get(node.parentId)?.push(node);
  const ordered = [], seen = new Set(), queue = map.nodes.filter(node => node.id === map.rootId);
  while (queue.length) { const node = queue.shift(); if (seen.has(node.id)) continue; seen.add(node.id); ordered.push(node); queue.push(...children.get(node.id)); }
  return [...ordered, ...map.nodes.filter(node => !seen.has(node.id))];
}

// A choice of saved, current answers, each once: `min` to `max` of them. Anything else is refused, when the job is
// asked for and again when the agent takes it, so an answer set aside or removed meanwhile is never read silently.
export function chosenAnswers(map, selection, { min = 0, max = 200 } = {}) {
  if (!min && (selection === undefined || selection === null)) return [];
  need(Array.isArray(selection) && selection.length >= min && selection.length <= max, `Choose ${min ? `${min} to ${max}` : `at most ${max}`} of your answers.`);
  const seen = new Set();
  return selection.map(item => {
    const node = map.nodes.find(n => n.id === item?.nodeId), question = node?.questions.find(q => q.id === item?.questionId);
    need(question && question.answer && !question.supersededAt, 'A chosen record is not a saved answer on this map, or a changed premise set it aside.');
    need(!seen.has(`${node.id}/${question.id}`), 'An answer is chosen twice.'); seen.add(`${node.id}/${question.id}`);
    return { nodeId: node.id, questionId: question.id };
  });
}

// What a check reads: the original idea, then every current answer and open question, root first.
// Answers from an earlier premise are left out and named, so the agent knows they exist.
export function answerRecords(map, selection = []) {
  const chosen = selection.length ? new Set(selection.map(item => `${item.nodeId}/${item.questionId}`)) : null;
  const rootNode = map.nodes.find(node => node.id === map.rootId) || map.nodes[0];
  const records = [{ kind: 'idea', text: clip(map.originalIdea || rootNode.prompt, 1200) }], omitted = [];
  for (const node of rootFirst(map)) for (const question of node.questions) {
    if (chosen && !chosen.has(`${node.id}/${question.id}`)) continue;
    const base = { nodeId: node.id, questionId: question.id, nodeTitle: clip(node.title, 100), question: clip(question.text, 400) };
    if (question.supersededAt) omitted.push({ nodeId: node.id, questionId: question.id, reason: 'earlier premise' });
    else if (question.answer) records.push({ kind: 'answer', ...base, answer: clip(question.answer, 1000), certainty: certaintyText(question), status: node.status, reviewState: node.reviewState, stale: !!node.stale });
    else if (!chosen && isOpen(question)) records.push({ kind: 'open-question', ...base });
  }
  return { records, omitted };
}
// A question as a review read it: an answer's text and how sure the user was, or that it was still open. Kept on the
// record, so a review is outdated when that question changes, and not when another one on the same idea does.
const answerKey = question => createHash('sha256').update(question.answer ? `${certaintyText(question)}\n${question.answer}` : `open\n${question.text}`).digest('hex').slice(0, 16);
// What a claimed job read, for checking its result and its staleness later.
export function includedRecords(map, records) {
  return records.filter(record => record.nodeId).map(record => {
    const node = map.nodes.find(n => n.id === record.nodeId), question = record.questionId ? node.questions.find(q => q.id === record.questionId) : null;
    return { nodeId: record.nodeId, ...(question ? { questionId: question.id, answer: answerKey(question) } : {}), contentRevision: node.contentRevision };
  });
}

// A review is outdated once anything it read has changed: an answer (its text or how sure the user is), an open
// question (answered since), or, for an idea's findings, the idea itself. A record saved before questions were keyed
// falls back to the idea's revision.
export function proposalOutdated(map, proposal) {
  return (proposal.included || []).some(record => {
    const node = map.nodes.find(n => n.id === record.nodeId);
    if (!node) return true;
    if (!record.questionId) return node.contentRevision !== record.contentRevision;
    const question = node.questions.find(q => q.id === record.questionId);
    if (!question || question.supersededAt) return true;
    return record.answer === undefined ? node.contentRevision !== record.contentRevision : answerKey(question) !== record.answer;
  });
}

const findingFields = ['category', 'explanation', 'resolution', 'refs'];
// An answer review (Check answers, Challenge decisions): the agent reads chosen answers, or every one, and returns at
// most 12 findings, each with a category, an explanation, what would settle it and the 1–8 answers it rests on. They
// become one proposal the user keeps or dismisses item by item. A type gives its words and its few differences:
//   choose      { min, max } answers it may be asked to read (min 0 reads every answer when none are chosen)
//   summary     the result may carry a summary of at most 1,000 characters
//   sources     each finding may cite at most this many sources the agent read
//   refine      adjusts a checked finding, given the map
export function answerReviewJob({ label, reason, categories: kinds, instruction, choose = {}, summary = false, sources = 0, refine = finding => finding }) {
  const resultFormat = {
    ...(summary ? { summary: 'optional, at most 1,000 characters' } : {}),
    findings: [{ category: kinds.join(' | '), explanation: 'at most 1,000 characters', resolution: 'what would settle it, at most 1,000 characters', refs: [{ nodeId: 'from records', questionId: 'from records' }],
      ...(sources ? { sources: [{ title: 'optional', url: 'https://…', note: 'the claim it supports' }] } : {}) }],
    limits: `at most 12 findings, each citing 1–8 records you were given${sources ? ` and at most ${sources} sources you actually read` : ''}; an empty list is fine. Any other field rejects the result.`,
  };
  function packet({ map, job, budget = 15500 }) {
    const selection = job.input?.selection?.length ? chosenAnswers(map, job.input.selection, choose) : [];
    const { records, omitted } = answerRecords(map, selection);
    const build = () => ({ records, omittedRecords: omitted, resultFormat, instruction,
      retrieval: 'Use CLI read --map MAP --node NODE --section questions --question ID for an answer shortened here.' });
    // Leave room for the shared identifying fields the Store adds. Reading every answer drops the last ones that do
    // not fit; a choice the user made is never cut.
    while (JSON.stringify(build()).length > budget - 800 && records.length > 1) {
      need(!selection.length, 'Choose fewer answers: these do not fit in one review.');
      const dropped = records.pop();
      omitted.push({ nodeId: dropped.nodeId, questionId: dropped.questionId, reason: 'over the packet budget' });
    }
    const built = build();
    built[includedKey] = includedRecords(map, records);
    return built;
  }
  function validate(result, { map, job }) {
    const extra = Object.keys(result).filter(key => key !== 'findings' && !(summary && key === 'summary'));
    need(!extra.length, `This review returns ${summary ? 'findings and a summary' : 'findings'} only; remove ${extra.join(', ')}.`);
    need(Array.isArray(result.findings) && result.findings.length <= 12, 'Return findings as a list of at most 12.');
    const read = new Set((job.included || []).map(record => `${record.nodeId}/${record.questionId}`));
    const allowed = new Set([...findingFields, ...(sources ? ['sources'] : [])]);
    const findings = result.findings.map((finding, index) => {
      const name = `Finding ${index + 1}`;
      need(finding && typeof finding === 'object' && !Array.isArray(finding), `${name} must be an object.`);
      const unknown = Object.keys(finding).filter(key => !allowed.has(key));
      need(!unknown.length, `${name} has fields a finding does not take: ${unknown.join(', ')}.`);
      need(kinds.includes(finding.category), `${name}: category must be ${kinds.join(', ')}.`);
      need(Array.isArray(finding.refs) && finding.refs.length >= 1 && finding.refs.length <= 8, `${name} cites 1–8 of the records it was given.`);
      const refs = finding.refs.map(ref => { need(read.has(`${ref?.nodeId}/${ref?.questionId}`), `${name} cites a record that was not read in this review.`); return { nodeId: ref.nodeId, questionId: ref.questionId }; });
      need(finding.sources === undefined || (Array.isArray(finding.sources) && finding.sources.length <= sources), `${name} lists at most ${sources} sources.`);
      const cited = sources ? sourceList(finding.sources, fail, { stance: false }).map(({ title, url, note }) => ({ title, url, note })) : [];
      return refine({ category: finding.category, explanation: textField(finding.explanation, `${name} explanation`, 1000, fail), resolution: textField(finding.resolution, `${name}: what would settle it`, 1000, fail), refs, ...(cited.length ? { sources: cited } : {}) }, map);
    });
    const said = summary ? textField(result.summary, 'Summary', 1000, fail, { optional: true }) : undefined;
    return { ...(said ? { summary: said } : {}), findings };
  }
  return {
    label, target: 'map', reason,
    prepare: ({ map, input }) => {
      const selection = chosenAnswers(map, input.selection, choose);
      packet({ map, job: { input: { selection } }, budget: packetBudget(map) }); // Refuses a choice that cannot fit, before anything is queued.
      return { selection };
    },
    packet, validate,
    isStale: ({ map, job }) => proposalOutdated(map, { included: job.included }),
    proposalOutdated,
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: job.type, createdAt: at, included: job.included || [],
        ...(stale ? { stale: true } : {}), ...(result.summary ? { summary: result.summary } : {}),
        items: result.findings.map(finding => ({ id: makeId('item'), ...finding, review: 'unreviewed' })) }];
    },
  };
}

export const mapJobTypes = {
  [CHECK_ANSWERS]: answerReviewJob({
    label: 'Check answers', categories, summary: true,
    reason: 'The user asked to check the saved answers for tensions, unresolved choices and untested assumptions.',
    instruction: 'Read these saved answers as a whole. Point out possible tensions between saved statements, choices that are still unresolved, and assumptions that are untested. Report what you notice; never call an answer wrong, never answer for the user and change nothing. Cite the records each finding rests on by nodeId and questionId. Return the result through the CLI.',
    // A "tension" that rests on an answer the user has not Decided is really a choice still open.
    refine: (finding, map) => {
      const settled = finding.refs.every(ref => effectiveAnswerState(map.nodes.find(n => n.id === ref.nodeId)?.questions.find(q => q.id === ref.questionId) || {})?.state === 'decided');
      return finding.category === 'possible-tension' && !settled ? { ...finding, category: 'unresolved-choice' } : finding;
    },
  }),
};

export const mapJobActions = {
  // Only the browser asks for a map job; agents never request one.
  'request-map-job': { target: 'map', apply: ({ map, input, store }) => {
    const definition = store.jobType(input.jobType);
    need(definition && definition.target === 'map' && typeof definition.prepare === 'function', 'This kind of review cannot be requested.');
    store.enqueueJob(map, { type: input.jobType, reason: definition.reason, input: definition.prepare({ map, input }) });
  } },
  // Keep or dismiss one point. Keeping never changes an answer or a finding's review state.
  'review-proposal': { target: 'map', apply: ({ map, input, store, actor }) => {
    const proposal = (map.proposals || []).find(p => p.id === input.proposalId), item = proposal?.items.find(i => i.id === input.itemId);
    need(item, 'That review point no longer exists.', 404);
    // Each job type says how its points are reviewed: Check answers keeps or dismisses, and may change its mind; a sort
    // (K8) only dismisses here, once, since accepting places the thought.
    const definition = store.jobType(proposal.type ?? CHECK_ANSWERS);
    need((definition?.reviewDecisions ?? ['accepted', 'dismissed']).includes(input.decision), definition?.reviewRefusal ?? 'Choose Keep or Dismiss.');
    need(!definition?.finalReview || item.review === 'unreviewed', 'This was already accepted or dismissed.', 409);
    definition?.review?.({ map, proposal, item, input, actor }); // An editable item takes the user's text (F5).
    Object.assign(item, { review: input.decision, reviewedAt: new Date().toISOString(), ...(actor?.name ? { reviewedBy: { name: actor.name } } : {}) });
    store.event(map, 'proposal-reviewed', null, `${proposal.id}/${item.id}: ${input.decision}`);
  } },
};
