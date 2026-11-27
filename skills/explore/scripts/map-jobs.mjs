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
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const text = (value, field, max, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  need(typeof value === 'string' && value.trim(), `${field} is required.`);
  need(value.length <= max, `${field} must be at most ${max} characters.`);
  return value.trim();
};

// Ideas in tree order from the root, then any outside the tree, in saved order.
function rootFirst(map) {
  const children = new Map(map.nodes.map(node => [node.id, []]));
  for (const node of map.nodes) children.get(node.parentId)?.push(node);
  const ordered = [], seen = new Set(), queue = map.nodes.filter(node => node.id === map.rootId);
  while (queue.length) { const node = queue.shift(); if (seen.has(node.id)) continue; seen.add(node.id); ordered.push(node); queue.push(...children.get(node.id)); }
  return [...ordered, ...map.nodes.filter(node => !seen.has(node.id))];
}

// A selection names saved, current answers; anything else is refused before it is queued.
function normalizeSelection(map, selection) {
  if (selection === undefined || selection === null) return [];
  need(Array.isArray(selection) && selection.length <= 200, 'Choose at most 200 answers.');
  return selection.map(item => {
    const node = map.nodes.find(n => n.id === item?.nodeId), question = node?.questions.find(q => q.id === item?.questionId);
    need(question && question.answer && !question.supersededAt, 'A chosen record is not a saved answer on this map.');
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

const checkResultFormat = {
  summary: 'optional, at most 1,000 characters',
  findings: [{ category: categories.join(' | '), explanation: 'at most 1,000 characters', resolution: 'what would settle it, at most 1,000 characters', refs: [{ nodeId: 'from records', questionId: 'from records' }] }],
  limits: 'at most 12 findings, each citing 1–8 records you were given; an empty list is fine',
};
const checkInstruction = 'Read these saved answers as a whole. Point out possible tensions between saved statements, choices that are still unresolved, and assumptions that are untested. Report what you notice; never call an answer wrong, never answer for the user and change nothing. Cite the records each finding rests on by nodeId and questionId. Return the result through the CLI.';

function checkPacket({ map, job, budget = 15500 }) {
  const selection = job.input?.selection || [];
  const { records, omitted } = answerRecords(map, selection);
  const build = () => ({ records, omittedRecords: omitted, resultFormat: checkResultFormat, instruction: checkInstruction,
    retrieval: 'Use CLI read --map MAP --node NODE --section questions --question ID for an answer shortened here.' });
  // Leave room for the shared identifying fields the Store adds.
  while (JSON.stringify(build()).length > budget - 800 && records.length > 1) {
    need(!selection.length, 'Choose fewer answers: these do not fit in one check.');
    const dropped = records.pop();
    omitted.push({ nodeId: dropped.nodeId, questionId: dropped.questionId, reason: 'over the packet budget' });
  }
  const packet = build();
  packet[includedKey] = records.filter(record => record.nodeId).map(record => ({ nodeId: record.nodeId, questionId: record.questionId,
    contentRevision: map.nodes.find(node => node.id === record.nodeId).contentRevision }));
  return packet;
}

function validateCheck(result, { map, job }) {
  need(Array.isArray(result.findings) && result.findings.length <= 12, 'Return findings as a list of at most 12.');
  const read = new Set((job.included || []).map(record => `${record.nodeId}/${record.questionId}`));
  const summary = text(result.summary, 'Summary', 1000, true);
  const findings = result.findings.map(finding => {
    need(finding && typeof finding === 'object' && !Array.isArray(finding), 'Each finding must be an object.');
    need(categories.includes(finding.category), `Use a category of ${categories.join(', ')}.`);
    need(Array.isArray(finding.refs) && finding.refs.length >= 1 && finding.refs.length <= 8, 'Each finding cites 1–8 records.');
    const refs = finding.refs.map(ref => {
      need(read.has(`${ref?.nodeId}/${ref?.questionId}`), 'A finding cites a record that was not read in this check.');
      return { nodeId: ref.nodeId, questionId: ref.questionId };
    });
    // A "tension" that rests on an answer the user has not Decided is really a choice still open.
    const settled = refs.every(ref => effectiveAnswerState(map.nodes.find(n => n.id === ref.nodeId)?.questions.find(q => q.id === ref.questionId) || {})?.state === 'decided');
    const category = finding.category === 'possible-tension' && !settled ? 'unresolved-choice' : finding.category;
    return { category, explanation: text(finding.explanation, 'Explanation', 1000), resolution: text(finding.resolution, 'What would settle it', 1000), refs };
  });
  return { ...(summary ? { summary } : {}), findings };
}

// A check is outdated once any record it read has changed or been set aside by a changed premise.
export function proposalOutdated(map, proposal) {
  return (proposal.included || []).some(record => {
    const node = map.nodes.find(n => n.id === record.nodeId);
    if (!node || node.contentRevision !== record.contentRevision) return true;
    const question = record.questionId ? node.questions.find(q => q.id === record.questionId) : null;
    return record.questionId && (!question || question.supersededAt);
  });
}

export const mapJobTypes = {
  [CHECK_ANSWERS]: {
    label: 'Check answers', target: 'map',
    reason: 'The user asked to check the saved answers for tensions, unresolved choices and untested assumptions.',
    prepare: ({ map, input }) => {
      const selection = normalizeSelection(map, input.selection);
      checkPacket({ map, job: { input: { selection } } }); // Refuses a selection that cannot fit, before anything is queued.
      return { selection };
    },
    packet: checkPacket,
    validate: validateCheck,
    isStale: ({ map, job }) => proposalOutdated(map, { included: job.included }),
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: job.type, createdAt: at, included: job.included || [],
        ...(stale ? { stale: true } : {}), ...(result.summary ? { summary: result.summary } : {}),
        items: result.findings.map(finding => ({ id: makeId('item'), ...finding, review: 'unreviewed' })) }];
    },
  },
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
    need(['accepted', 'dismissed'].includes(input.decision), 'Choose Keep or Dismiss.');
    Object.assign(item, { review: input.decision, reviewedAt: new Date().toISOString(), ...(actor?.name ? { reviewedBy: { name: actor.name } } : {}) });
    store.event(map, 'proposal-reviewed', null, `${proposal.id}/${item.id}: ${input.decision}`);
  } },
};
