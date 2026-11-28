import { changeLinks } from './graph.js';

// Impact level and critical paths (D4): how much of the map rests on each idea. A change to an idea reaches its
// `contains` descendants and, transitively, the ideas linked as depending on what it reached: the links along which
// the Store flags findings for review (changeLinks). Local and read-only: never saved or sent to the agent.
export const impactBands = { high: { affected: 20, throughDependencies: 5 }, medium: { affected: 5, throughDependencies: 1 } };
const bandWords = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cache = new WeakMap(); // One index per map object; a changed map is a new object.

// Ideas reached from `start`, nearest first (ties by ID), along `links`; `dependencies` false keeps to `contains`.
function reach(links, start, known, dependencies = true) {
  const seen = new Set([start]), order = [];
  for (let queue = [start], at = 0; at < queue.length; at++) {
    for (const link of links.get(queue[at]) ?? []) {
      if ((dependencies || !link.dependency) && !seen.has(link.to) && known.has(link.to)) { seen.add(link.to); order.push(link.to); queue.push(link.to); }
    }
  }
  return order;
}

// Per idea ID: { affected (nearest first), inBranch (reached through `contains` only), throughDependencies (the rest,
// reached by a path with a dependency step), band, open }. An idea never counts itself, and cycles end.
export function impactIndex(map) {
  if (cache.has(map)) return cache.get(map);
  const links = changeLinks(map), byId = new Map(map.nodes.map(node => [node.id, node])), index = {};
  // Untouched suggestions cost little to redo, so they do not count toward the band.
  const weight = ids => ids.filter(id => byId.get(id).status !== 'suggested').length;
  for (const node of map.nodes) {
    const affected = reach(links, node.id, byId), branch = new Set(reach(links, node.id, byId, false));
    const inBranch = affected.filter(id => branch.has(id)), throughDependencies = affected.filter(id => !branch.has(id));
    const total = weight(affected), through = weight(throughDependencies);
    const band = total >= impactBands.high.affected || through >= impactBands.high.throughDependencies ? 'high'
      : total >= impactBands.medium.affected || through >= impactBands.medium.throughDependencies ? 'medium' : 'low';
    // Open: everything but an accepted, current finding. Any kind counts: the user's answers live on every kind.
    index[node.id] = { affected, inBranch, throughDependencies, band, open: !(node.status === 'explored' && node.reviewState === 'accepted' && !node.stale) };
  }
  cache.set(map, index);
  return index;
}

// One shortest path along which a change to `fromId` reaches `toId`, as steps { from, to, via: 'contains' |
// 'depends on' }, ties broken by ID; null when it does not reach it.
export function impactPath(map, fromId, toId) {
  if (fromId === toId) return null;
  const links = changeLinks(map), known = new Set(map.nodes.map(node => node.id)), came = new Map([[fromId, null]]);
  for (let queue = [fromId], at = 0; at < queue.length && !came.has(toId); at++) {
    for (const link of links.get(queue[at]) ?? []) {
      if (!came.has(link.to) && known.has(link.to)) { came.set(link.to, { from: queue[at], to: link.to, via: link.dependency ? 'depends on' : 'contains' }); queue.push(link.to); }
    }
  }
  if (!came.has(toId)) return null;
  const steps = [];
  for (let step = came.get(toId); step; step = came.get(step.from)) steps.unshift(step);
  return steps;
}

// The ideas on dependency chains between two of `highlighted`, which a filter keeps visible as quieter context.
export function impactContext(map, highlighted) {
  const forward = new Map(), backward = new Map(), add = (links, a, b) => { if (!links.has(a)) links.set(a, []); links.get(a).push(b); };
  for (const edge of map.edges ?? []) if (edge.type === 'depends_on') { add(forward, edge.to, edge.from); add(backward, edge.from, edge.to); }
  const spread = links => { const seen = new Set(highlighted); for (const id of seen) for (const next of links.get(id) ?? []) seen.add(next); return seen; };
  const after = spread(forward), before = spread(backward);
  return [...after].filter(id => before.has(id) && !highlighted.has(id));
}

// "Changing this would affect 7 ideas: 4 in this branch, 3 elsewhere through dependencies. 5 have findings that
// would need review." Findings come from the map as the app shows it (hasFindings, completed).
export function impactSentence(entry, map) {
  if (!entry.affected.length) return 'Changing this affects no other ideas.';
  const byId = new Map(map.nodes.map(node => [node.id, node]));
  const parts = [entry.inBranch.length ? `${entry.inBranch.length} in this branch` : '', entry.throughDependencies.length ? `${entry.throughDependencies.length} elsewhere through dependencies` : ''].filter(Boolean);
  const findings = entry.affected.filter(id => byId.get(id)?.hasFindings || byId.get(id)?.completed).length;
  return `Changing this would affect ${count(entry.affected.length, 'idea', 'ideas')}: ${parts.join(', ')}.${findings ? ` ${findings} ${findings === 1 ? 'has' : 'have'} findings that would need review.` : ''}`;
}

// The inspector's Impact section: the band, the sentence, and the first 12 affected ideas with the path to each.
export function impactHtml(map, node, { esc }) {
  if (!map?.nodes) return '';
  const entry = impactIndex(map)[node.id];
  if (!entry) return '';
  const head = `<h3 class="section-label">Impact</h3><p class="impact-band ${entry.band}">${bandWords[entry.band]}</p><p>${esc(impactSentence(entry, map))}</p>`;
  if (!entry.affected.length) return head;
  const titles = new Map(map.nodes.map(item => [item.id, item.title]));
  const via = id => (impactPath(map, node.id, id) ?? []).map(step => `${titles.get(step.to)}${step.via === 'depends on' ? ' (depends on)' : ''}`).join(' → ');
  const items = entry.affected.slice(0, 12).map(id => `<li><button type="button" class="relationship" data-select="${esc(id)}">${esc(titles.get(id))}</button><small>via ${esc(via(id))}</small></li>`).join('');
  const more = entry.affected.length > 12 ? `<p class="form-note">${entry.affected.length - 12} more. Find an idea reaches any of them.</p>` : '';
  return `${head}<details data-editor="impact"><summary>Show affected ideas</summary><ul class="impact-list">${items}</ul>${more}</details>`;
}
