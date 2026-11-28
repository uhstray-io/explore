import { createHash } from 'node:crypto';
import { effectiveAnswerState, isAssumption } from '../assets/questions.js';

// The ideas an agent reads around one idea: the root, the path up to it, semantic neighbours of those, and
// transitive dependencies, without expanding other branches' children. Shared by every packet that reads
// nearby ideas and by the signature that tells whether work became stale while it ran.
function neighbourhood(map, node) {
  const ids = new Set([node.id, map.rootId]);
  let parent = node.parentId;
  while (parent && !ids.has(parent)) { ids.add(parent); parent = map.nodes.find(n => n.id === parent)?.parentId; }
  for (const e of map.edges.filter(e => e.type !== 'contains')) if (ids.has(e.from) || ids.has(e.to)) { ids.add(e.from); ids.add(e.to); }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of map.edges.filter(e => e.type === 'depends_on')) if (ids.has(e.from) && !ids.has(e.to)) { ids.add(e.to); changed = true; }
  }
  return ids;
}
// The idea and its neighbourhood, in map order.
export function contextNodes(map, node) {
  const ids = neighbourhood(map, node);
  return map.nodes.filter(n => ids.has(n.id));
}
// Changes when any idea in the neighbourhood changes content (premise, findings or an answer), or when a link
// touching the neighbourhood is added or removed: work reading it would then read a different map.
export function signature(map, node) {
  const nodes = contextNodes(map, node), ids = new Set(nodes.map(n => n.id));
  const links = map.edges.filter(e => e.type !== 'contains' && (ids.has(e.from) || ids.has(e.to))).map(e => `${e.from} ${e.type} ${e.to}`).sort();
  return `v2:${createHash('sha256').update(JSON.stringify([nodes.map(n => [n.id, n.contentRevision]), links])).digest('hex')}`;
}
// The signature before links counted (stored without a prefix by earlier versions of Explore).
const contentSignature = (map, node) => createHash('sha256').update(JSON.stringify(contextNodes(map, node).map(n => [n.id, n.contentRevision]))).digest('hex');
// Whether `stored` still describes the neighbourhood, compared with the formula it was made with, so results
// saved by an earlier version are not all suddenly out of date.
export function signatureMatches(map, node, stored) {
  return typeof stored === 'string' && (stored.startsWith('v2:') ? stored === signature(map, node) : stored === contentSignature(map, node));
}
// The other ideas in the neighbourhood for a packet: the root first, then nearest first by parent links and
// connections, so trimming from the end leaves out the farthest.
export function nearbyIdeas(map, node) {
  const ids = neighbourhood(map, node), distance = new Map([[node.id, 0]]), queue = [node.id];
  const linked = id => [map.nodes.find(n => n.id === id)?.parentId, ...map.nodes.filter(n => n.parentId === id).map(n => n.id),
    ...map.edges.filter(e => e.type !== 'contains' && (e.from === id || e.to === id)).map(e => e.from === id ? e.to : e.from)];
  while (queue.length) {
    const id = queue.shift();
    for (const next of linked(id)) if (next && ids.has(next) && !distance.has(next)) { distance.set(next, distance.get(id) + 1); queue.push(next); }
  }
  const order = n => n.id === map.rootId ? -1 : distance.get(n.id) ?? Infinity;
  return contextNodes(map, node).filter(n => n.id !== node.id).sort((a, b) => order(a) - order(b));
}

const clip = (s, length) => s.length > length ? s.slice(0, length) + '\n[Shortened; read the linked node for detail.]' : s;
// How sure a saved answer is, as packets state it.
export function certaintyFields(question) {
  const certainty = effectiveAnswerState(question);
  // The user's note on what would disprove an assumption (K6) travels with it.
  return certainty ? { answerState: certainty.state, ...(certainty.recorded ? {} : { certaintyRecorded: false }), ...(isAssumption(question) && question.disproveIf ? { disproveIf: question.disproveIf.length > 300 ? `${question.disproveIf.slice(0, 299)}…` : question.disproveIf } : {}) } : {};
}
// A saved answer as packets show it, keeping how sure it is and whether it came from an earlier premise.
export const answerBrief = (q, { question = 200, answer = 300 } = {}) => ({ question: clip(q.text, question), answer: clip(q.answer, answer), ...certaintyFields(q), ...(q.supersededAt ? { supersededAt: q.supersededAt } : {}) });
// One nearby idea in a packet: enough to keep accepted, provisional and stale material apart.
export const nearbyBrief = n => ({ id: n.id, title: n.title, summary: clip(n.summary, 500), premise: clip(n.prompt || n.body, 600),
  answers: n.questions.filter(q => q.answer).slice(-3).map(q => answerBrief(q)), status: n.status, reviewState: n.reviewState, stale: n.stale });
// An idea's researched findings, or '' while its body is still only the premise.
export const ownFindings = node => node.body === node.prompt ? '' : node.body;
