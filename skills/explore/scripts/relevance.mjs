// Relevant answers from elsewhere on the map (C13): which ideas an investigation packet carries as context, and why.
// The root and the path down to the idea come first. Then, ranked: explicit prerequisites, other linked ideas, ideas
// whose answers share the branch's or goal's words, and every other idea with answers. Matching is lexical, not
// semantic. Staleness keeps the structural signature (neighbourhood.mjs): an answer elsewhere is context, not a premise.
import { effectiveAnswerState } from '../assets/questions.js';
import { neighbourhoodWalk, sentAnswers } from './neighbourhood.mjs';

// The packet's record of what it chose, kept on the job (never sent to the agent).
export const selectionKey = Symbol('contextSelection');
export const contextLimit = 40, omittedLimit = 20;
export const selectionPolicy = 'Context is chosen by a heuristic, not proof of relevance; ideas in omitted were not read.';

const stopwords = new Set(('the and for are but not you all any can had her was one our out has have him his how its may now see she too use what when where which while with this that than then them they their there these those from into onto over under about after again also because been before being both each few more most much must other some such only own same very will would could should just like your yours why whom whose here able').split(' '));
// The words of a text, as matching compares them: NFKC, lower case, letters and digits, three or more, no stopwords.
export function terms(text) {
  return new Set((String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !stopwords.has(word)));
}
const linkWords = { supports: 'supports', contradicts: 'contradicts', related_to: 'related to', depends_on: 'depends on' };
const byId = (a, b) => (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);

// The context for an investigation of `node`: `required` (the root, then each ancestor down to the parent) and
// `candidates` in rank order, each `{ node, reasons, group }` (group 1–4). Within a group, unsettled ideas come first,
// then nearer ones in the tree, then by ID; prerequisites are first ordered by how many links away they are, and
// matches by how many words they share.
export function rankContext(map, node) {
  const nodes = new Map(map.nodes.map(n => [n.id, n])), parentOf = n => nodes.get(n?.parentId);
  const path = [];
  for (let up = parentOf(node); up && !path.includes(up); up = parentOf(up)) path.unshift(up);
  const required = path.map(n => ({ node: n, reasons: [n.id === map.rootId ? 'The original idea' : 'On the path to this idea'] }));
  const taken = new Set([node.id, ...path.map(n => n.id)]);
  // Computed once per idea: tree distance from the selected one (through the nearest shared ancestor), and whether
  // its sent answers are unsettled (not Decided, unrecorded, or from an earlier premise) or it is flagged.
  const lineage = n => { const line = []; for (let at = n; at && !line.includes(at.id); at = parentOf(at)) line.push(at.id); return line; };
  const mine = lineage(node), facts = new Map();
  const factsOf = n => {
    if (!facts.has(n.id)) {
      const theirs = lineage(n), shared = theirs.findIndex(id => mine.includes(id)), answers = sentAnswers(n);
      facts.set(n.id, { distance: shared < 0 ? Infinity : shared + mine.indexOf(theirs[shared]), unsettled: !!n.stale || answers.some(q => q.supersededAt || effectiveAnswerState(q)?.state !== 'decided'), answers });
    }
    return facts.get(n.id);
  };
  const candidate = (n, reasons, group, extra = {}) => ({ node: n, reasons: [...reasons, ...(factsOf(n).unsettled && factsOf(n).answers.length ? ['Not settled yet'] : [])], group, ...extra });
  const order = (a, b) => factsOf(b.node).unsettled - factsOf(a.node).unsettled || factsOf(a.node).distance - factsOf(b.node).distance || byId(a, b);
  // 1. Explicit prerequisites: depends_on, followed forward from the idea or an ancestor, by how many links away.
  const steps = new Map();
  for (let frontier = [...taken], step = 1; frontier.length; step++) {
    const next = [];
    for (const edge of map.edges) if (edge.type === 'depends_on' && frontier.includes(edge.from) && nodes.has(edge.to) && !taken.has(edge.to) && !steps.has(edge.to)) { steps.set(edge.to, step); next.push(edge.to); }
    frontier = next;
  }
  const prerequisites = [...steps].map(([id, step]) => candidate(nodes.get(id), ['Explicit prerequisite'], 1, { step })).sort((a, b) => a.step - b.step || order(a, b));
  // 2. Everything else the neighbourhood reaches, with how it came in.
  const { ids, reachedBy } = neighbourhoodWalk(map, node);
  const why = id => {
    const way = reachedBy.get(id), edge = way?.edge;
    if (!edge) return way?.prerequisiteOf ? `Prerequisite of ${nodes.get(way.prerequisiteOf)?.title ?? 'a linked idea'}` : 'Linked';
    const other = edge.to === id ? edge.from : edge.to, words = linkWords[edge.type] ?? edge.type;
    const name = taken.has(other) ? 'this branch' : nodes.get(other)?.title ?? 'a linked idea';
    return edge.to === id ? `Linked: ${name} ${words} it` : `Linked: it ${words} ${name}`;
  };
  const linked = [...ids].filter(id => !taken.has(id) && !steps.has(id) && nodes.has(id)).map(id => candidate(nodes.get(id), [why(id)], 2)).sort(order);
  // 3 and 4. Ideas elsewhere with answers: those sharing the branch's, the original idea's or the goal's words first.
  const sources = [['Matches branch terms', terms(`${node.title} ${node.prompt || node.body}`)], ['Matches the original idea', terms(map.originalIdea)],
    ['Matches the goal', terms(`${map.objective ?? ''} ${map.successCriteria ?? ''}`)]];
  const matched = [], rest = [];
  for (const other of map.nodes) {
    if (taken.has(other.id) || ids.has(other.id) || steps.has(other.id) || !factsOf(other).answers.length) continue;
    const words = terms(`${other.title} ${factsOf(other).answers.map(q => `${q.text} ${q.answer}`).join(' ')}`);
    const shared = sources.map(([reason, wanted]) => [reason, [...wanted].filter(word => words.has(word))]).filter(([, found]) => found.length);
    if (shared.length) matched.push(candidate(other, shared.map(([reason]) => reason), 3, { score: new Set(shared.flatMap(([, found]) => found)).size }));
    else rest.push(candidate(other, ['Answered elsewhere on the map'], 4));
  }
  matched.sort((a, b) => b.score - a.score || order(a, b)); rest.sort(order);
  return { required, candidates: [...prerequisites, ...linked, ...matched, ...rest] };
}

// Fills the packet's context and the user's question feedback within `budget`, measured once: the base packet is
// sized with every count at its widest, and each entry then costs its own length. In order: the path (shortened, then
// cut to the bare idea, and only then its ideas farthest from this one left out, never the root, each listed with
// reason `path`), prerequisites and linked ideas, the feedback, then matches and other answers. A whole entry that
// does not fit is skipped, so a smaller one after it can still fit. Returns the packet fields, and the choice under
// selectionKey.
export function admitContext(packet, { required, candidates }, { budget, entry, clipRequired, bareRequired, feedback }) {
  const wide = 1e9, ranked = candidates.length > 0;
  const base = JSON.stringify({ ...packet, context: [], questionFeedback: [], omittedContext: wide, omittedFeedback: wide, ...(ranked ? { selectionPolicy } : {}), omittedTotal: wide, omitted: [] }).length;
  let room = budget - base;
  const cost = (list, item) => JSON.stringify(item).length + (list.length ? 1 : 0);
  const take = (list, item) => { const size = cost(list, item); if (size > room) return false; list.push(item); room -= size; return true; };
  const context = [], kept = [], omitted = [];
  // The path: as much of it as fits, in its fullest form that fits; the root always stays.
  let path = required.map(entry);
  const pathCost = items => items.reduce((sum, item, i) => sum + JSON.stringify(item).length + (i ? 1 : 0), 0);
  if (pathCost(path) > room) path = required.map(item => clipRequired(entry(item)));
  if (pathCost(path) > room) path = required.map(item => bareRequired(entry(item)));
  const pathKept = [...required];
  while (path.length > 1 && pathCost(path) > room) { path.splice(1, 1); omitted.push({ candidate: pathKept.splice(1, 1)[0], reason: 'path' }); }
  for (const item of path) { room -= cost(context, item); context.push(item); }
  const admit = list => { for (const candidate of list) { if (context.length >= contextLimit) omitted.push({ candidate, reason: 'limit' }); else if (!take(context, entry(candidate))) omitted.push({ candidate, reason: 'budget' }); } };
  admit(candidates.filter(c => c.group <= 2));
  let dropped = 0;
  for (const item of feedback) if (!take(kept, item)) dropped++;
  admit(candidates.filter(c => c.group > 2));
  // What was left out (the path's own ideas first, since the path is admitted first), while it fits; omittedTotal
  // always counts them all.
  const listed = [];
  for (const { candidate, reason } of omitted.slice(0, omittedLimit)) {
    if (!take(listed, { id: candidate.node.id, title: candidate.node.title.length > 80 ? `${candidate.node.title.slice(0, 79)}…` : candidate.node.title, reason })) break;
  }
  return { context, questionFeedback: kept, omittedFeedback: packet.omittedFeedback + dropped, omittedContext: omitted.length, ...(ranked ? { selectionPolicy } : {}),
    ...(omitted.length ? { omittedTotal: omitted.length, omitted: listed } : {}),
    [selectionKey]: { included: context.map(item => ({ id: item.id, reasons: item.reasons })), omitted: listed.map(({ id, reason }) => ({ id, reason })), omittedTotal: omitted.length } };
}
