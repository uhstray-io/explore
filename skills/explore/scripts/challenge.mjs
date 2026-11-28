// Challenge decisions (F2) in the Store: the challenge map job. The agent reads only the chosen answers and the
// original idea, and its hypotheses are stored as one unreviewed F1 proposal; the user keeps or dismisses each.
import { textField, sourceList } from './fields.mjs';
import { packetBudget } from './guidance.mjs';
import { answerRecords, includedKey, proposalOutdated } from './map-jobs.mjs';
import { CHALLENGE, maxChallenged, maxHypotheses, challengeCategories } from '../assets/challenge.js';

class ChallengeProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new ChallengeProblem(message, status); };

// 1–40 saved, current answers, each once; an earlier premise's answers cannot be chosen.
function normalizeSelection(map, selection) {
  need(Array.isArray(selection) && selection.length >= 1 && selection.length <= maxChallenged, `Choose 1 to ${maxChallenged} of your answers.`);
  const seen = new Set();
  return selection.map(item => {
    const node = map.nodes.find(n => n.id === item?.nodeId), question = node?.questions.find(q => q.id === item?.questionId);
    need(question && question.answer && !question.supersededAt, 'A chosen record is not a saved, current answer on this map.');
    need(!seen.has(`${node.id}/${question.id}`), 'An answer is chosen twice.'); seen.add(`${node.id}/${question.id}`);
    return { nodeId: node.id, questionId: question.id };
  });
}
// The packet: the original idea and the chosen answers alone, each with its idea, status, review state and staleness.
function challengePacket({ map, job, budget }) {
  const { records } = answerRecords(map, job.input.selection);
  const packet = { records, resultFormat, instruction };
  need(JSON.stringify(packet).length <= budget - 800, 'These answers do not fit in one challenge. Choose fewer.');
  packet[includedKey] = records.filter(record => record.nodeId).map(record => ({ nodeId: record.nodeId, questionId: record.questionId, contentRevision: map.nodes.find(node => node.id === record.nodeId).contentRevision }));
  return packet;
}
const resultFormat = { findings: [{ category: challengeCategories.join(' | '), explanation: 'at most 1,000 characters', resolution: 'what would confirm or settle it, at most 1,000 characters', refs: [{ nodeId: 'from records', questionId: 'from records' }], sources: [{ title: 'optional', url: 'https://…', note: 'the claim it supports' }] }],
  limits: `at most ${maxHypotheses} findings, each citing 1–8 records you were given and at most 3 sources you actually read; an empty list is fine` };
const instruction = 'Argue in good faith against these saved answers: name hidden assumptions, counter-arguments, overlooked alternatives and evidence gaps that matter to the decision. Do not manufacture objections when none matter; an empty list is a fine result. Missing context is not evidence against a choice. Cite only sources you actually read. Each finding is a hypothesis for the user to consider, never a finding about the map: never ask the user to change an answer.';

const findingFields = new Set(['category', 'explanation', 'resolution', 'refs', 'sources']);
function validateChallenge(result, { job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => key !== 'findings');
  need(!extra.length, `A challenge returns findings only; remove ${extra.join(', ')}.`);
  need(Array.isArray(result.findings) && result.findings.length <= maxHypotheses, `Return findings as a list of at most ${maxHypotheses}.`);
  const read = new Set((job.included ?? []).map(record => `${record.nodeId}/${record.questionId}`));
  return { findings: result.findings.map((finding, index) => {
    const label = `Finding ${index + 1}`;
    need(finding && typeof finding === 'object' && !Array.isArray(finding), `${label} must be an object.`);
    const unknown = Object.keys(finding).filter(key => !findingFields.has(key));
    need(!unknown.length, `${label} has fields a finding does not take: ${unknown.join(', ')}.`);
    need(challengeCategories.includes(finding.category), `${label}: category must be ${challengeCategories.join(', ')}.`);
    need(Array.isArray(finding.refs) && finding.refs.length >= 1 && finding.refs.length <= 8, `${label} cites 1–8 of the answers it was given.`);
    const refs = finding.refs.map(ref => { need(read.has(`${ref?.nodeId}/${ref?.questionId}`), `${label} cites an answer that was not read in this challenge.`); return { nodeId: ref.nodeId, questionId: ref.questionId }; });
    need(finding.sources === undefined || (Array.isArray(finding.sources) && finding.sources.length <= 3), `${label} lists at most 3 sources.`);
    const sources = sourceList(finding.sources, fail, { stance: false }).map(({ title, url, note }) => ({ title, url, note }));
    return { category: finding.category, explanation: textField(finding.explanation, `${label} explanation`, 1000, fail), resolution: textField(finding.resolution, `${label} resolution`, 1000, fail), refs, ...(sources.length ? { sources } : {}) };
  }) };
}

export const challengeJobTypes = {
  [CHALLENGE]: {
    label: 'Challenge decisions', target: 'map',
    reason: 'The user asked the agent to argue against chosen answers.',
    prepare: ({ map, input }) => {
      const selection = normalizeSelection(map, input.selection);
      challengePacket({ map, job: { input: { selection } }, budget: packetBudget(map) }); // Refuses a choice that cannot fit, before anything is queued.
      return { selection };
    },
    packet: challengePacket,
    validate: validateChallenge,
    isStale: ({ map, job }) => proposalOutdated(map, { included: job.included }),
    proposalOutdated,
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: CHALLENGE, createdAt: at, included: job.included || [], ...(stale ? { stale: true } : {}),
        items: result.findings.map(finding => ({ id: makeId('item'), ...finding, review: 'unreviewed' })) }];
    },
  },
};
