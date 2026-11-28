// Relevant answers from elsewhere on the map (C13): which ideas an investigation packet carries as context, and why.
// The root and the path down to the idea come first and are never dropped silently. Then, ranked: explicit
// prerequisites, other linked ideas, ideas whose answers share the branch's or goal's words, and every other idea with
// answers. Matching is lexical, not semantic. Staleness keeps today's structural signature (neighbourhood.mjs): an
// answer elsewhere is context, not a premise.
import { effectiveAnswerState } from '../assets/questions.js';
import { contextNodes } from './neighbourhood.mjs';

// The packet's record of what it chose, kept on the job (never sent to the agent).
export const selectionKey = Symbol('contextSelection');
export const contextLimit = 40, omittedLimit = 20;
export const selectionPolicy = 'Context is chosen by a heuristic, not proof of relevance: the path to this idea, then prerequisites, linked ideas, answers sharing this branch\'s or the goal\'s words, then other answers; ideas left out are listed in omitted and were not read.';

const stopwords = new Set(('the and for are but not you all any can had her was one our out has have him his how its may new now old see two who boy did does get got let put say she too use what when where which while with this that than then them they their there these those from into onto over under about after again also because been before being both each few more most much must other some such only own same very will would could should just like your yours what why how whom whose here able').split(' '));
// The words of a text, as matching compares them: NFKC, lower case, letters and digits, three or more, no stopwords.
export function terms(text) {
  return new Set((String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !stopwords.has(word)));
}
const answered = node => node.questions.filter(q => q.answer);
// An idea still open to change: stale, or with an answer the user has not Decided or gave for an earlier premise.
const unsettled = node => !!node.stale || answered(node).some(q => q.supersededAt || effectiveAnswerState(q)?.state !== 'decided');
const linkWords = { supports: 'supports', contradicts: 'contradicts', related_to: 'related to', depends_on: 'depends on' };

// The context for an investigation of `node`: `required` (the root, then each ancestor down to the parent) and
// `candidates` in rank order, each `{ node, reasons }`. Within a group, unsettled ideas come first, then nearer ones in
// the tree, then by ID; prerequisites are ordered by how many links away they are, matches by how many words they share.
export function rankContext(map, node) {
  const byId = new Map(map.nodes.map(n => [n.id, n])), parentOf = n => byId.get(n?.parentId);
  const path = [];
  for (let up = parentOf(node); up && !path.includes(up); up = parentOf(up)) path.unshift(up);
  const required = path.map(n => ({ node: n, reasons: [n.id === map.rootId ? 'The original idea' : 'On the path to this idea'] }));
  const taken = new Set([node.id, ...path.map(n => n.id)]);
  // Tree distance from the selected idea, through the nearest shared ancestor.
  const lineage = n => { const line = []; for (let at = n; at && !line.includes(at); at = parentOf(at)) line.push(at); return line; };
  const mine = lineage(node).map(n => n.id);
  const distance = n => { const theirs = lineage(n).map(x => x.id), shared = theirs.findIndex(id => mine.includes(id)); return shared < 0 ? Infinity : shared + mine.indexOf(theirs[shared]); };
  // 1. Explicit prerequisites: reached through depends_on from the idea or an ancestor, nearer first.
  const prerequisites = new Map();
  let frontier = [...taken];
  for (let step = 1; frontier.length; step++) {
    const next = [];
    for (const edge of map.edges) if (edge.type === 'depends_on' && frontier.includes(edge.from) && byId.has(edge.to) && !taken.has(edge.to) && !prerequisites.has(edge.to)) { prerequisites.set(edge.to, step); next.push(edge.to); }
    frontier = next;
  }
  // 2. Every other idea today's neighbourhood reaches: linked to the branch, or a prerequisite of one that is.
  const linked = new Map();
  for (const other of contextNodes(map, node)) {
    if (taken.has(other.id) || prerequisites.has(other.id)) continue;
    const edge = map.edges.find(e => e.type !== 'contains' && ((taken.has(e.from) && e.to === other.id) || (taken.has(e.to) && e.from === other.id)));
    linked.set(other.id, edge ? (edge.to === other.id ? `Linked: this branch ${linkWords[edge.type] ?? edge.type} it` : `Linked: it ${linkWords[edge.type] ?? edge.type} this branch`) : 'Prerequisite of a linked idea');
  }
  // 3 and 4. Ideas elsewhere with answers: those sharing the branch's, the original idea's or the goal's words first.
  const sources = [['Matches branch terms', terms(`${node.title} ${node.prompt || node.body}`)], ['Matches the original idea', terms(map.originalIdea)],
    ['Matches the goal', terms(`${map.objective ?? ''} ${map.successCriteria ?? ''}`)]];
  const matched = [], rest = [];
  for (const other of map.nodes) {
    if (taken.has(other.id) || prerequisites.has(other.id) || linked.has(other.id) || !answered(other).length) continue;
    const words = terms(`${other.title} ${answered(other).map(q => `${q.text} ${q.answer}`).join(' ')}`);
    const shared = sources.map(([reason, wanted]) => [reason, [...wanted].filter(word => words.has(word))]).filter(([, found]) => found.length);
    if (shared.length) matched.push({ node: other, reasons: shared.map(([reason]) => reason), score: new Set(shared.flatMap(([, found]) => found)).size }); // More shared words rank higher.
    else rest.push({ node: other, reasons: ['Answered elsewhere on the map'] });
  }
  const settledLast = (a, b) => unsettled(b.node) - unsettled(a.node), nearer = (a, b) => distance(a.node) - distance(b.node) || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
  const withNote = entry => (unsettled(entry.node) && answered(entry.node).length ? { ...entry, reasons: [...entry.reasons, 'Not settled yet'] } : entry);
  const groups = [
    [...prerequisites].map(([id, step]) => ({ node: byId.get(id), reasons: ['Explicit prerequisite'], step })).sort((a, b) => a.step - b.step || settledLast(a, b) || nearer(a, b)),
    [...linked].map(([id, reason]) => ({ node: byId.get(id), reasons: [reason] })).sort((a, b) => settledLast(a, b) || nearer(a, b)),
    matched.sort((a, b) => b.score - a.score || settledLast(a, b) || nearer(a, b)),
    rest.sort((a, b) => settledLast(a, b) || nearer(a, b)),
  ];
  return { required, candidates: groups.flat().map(({ node: n, reasons }) => withNote({ node: n, reasons })) };
}

// Puts the path into `packet.context`, then admits `candidates` in rank order within `budget`: a whole entry that does
// not fit is skipped, so a smaller later one can still fit, and the user's question feedback gives way first.
// `entry(candidate)` is its packet form and `clipRequired(item)` a shorter one. The path is kept: shortened when room is
// short, and only when even that does not fit are its ideas farthest from this one left out, listed, never the root.
// Records what was left out in the packet, and the choice under selectionKey.
export function admitContext(packet, { required, candidates }, { budget, entry, clipRequired }) {
  const size = () => JSON.stringify(packet).length, feedbackSize = () => JSON.stringify(packet.questionFeedback).length - 2;
  const path = [...required], omitted = [];
  packet.context = path.map(entry);
  if (candidates.length) packet.selectionPolicy = selectionPolicy;
  while (size() > budget && packet.questionFeedback.length) { packet.questionFeedback.pop(); packet.omittedFeedback++; }
  if (size() > budget) packet.context = packet.context.map(clipRequired);
  while (size() > budget && packet.context.length > 1) { packet.context.splice(1, 1); omitted.push({ candidate: path.splice(1, 1)[0], reason: 'budget' }); }
  for (const candidate of candidates) {
    if (packet.context.length >= contextLimit) { omitted.push({ candidate, reason: 'limit' }); continue; }
    packet.context.push(entry(candidate));
    if (size() - feedbackSize() > budget) { packet.context.pop(); omitted.push({ candidate, reason: 'budget' }); continue; }
    while (size() > budget) { packet.questionFeedback.pop(); packet.omittedFeedback++; }
  }
  packet.omittedContext = omitted.length;
  if (omitted.length || candidates.length) {
    packet.selectionPolicy = selectionPolicy;
    packet.omittedTotal = omitted.length;
    packet.omitted = omitted.slice(0, omittedLimit).map(({ candidate, reason }) => ({ id: candidate.node.id, title: candidate.node.title.length > 80 ? `${candidate.node.title.slice(0, 79)}…` : candidate.node.title, reason }));
    while (size() > budget && packet.omitted.length) packet.omitted.pop(); // The count stays in omittedTotal.
  }
  packet[selectionKey] = { included: packet.context.map(item => ({ id: item.id, reasons: item.reasons })), omitted: (packet.omitted ?? []).map(({ id, reason }) => ({ id, reason })), omittedTotal: omitted.length };
}
