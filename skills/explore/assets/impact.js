import { changeLinks, changeWalk, treeOrder } from './graph.js';

// Impact level and critical paths (D4): how much of the map rests on each idea. A change to an idea reaches its
// `contains` branch and, transitively, the ideas linked as depending on what it reached: the walk along which the Store
// flags findings for review (changeWalk). Local and read-only: never saved or sent to the agent. Shown on the live
// map only: growth history shows today's content, and a saved version is read-only, so nothing there can be settled.
export const impactBands = { high: { affected: 20, throughDependencies: 5 }, medium: { affected: 5, throughDependencies: 1 } };
const bandWords = { high: 'High impact', medium: 'Medium impact', low: 'Low impact' };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const bandOf = (affected, through) => (affected >= impactBands.high.affected || through >= impactBands.high.throughDependencies ? 'high'
  : affected >= impactBands.medium.affected || through >= impactBands.medium.throughDependencies ? 'medium' : 'low');
// Untouched suggestions cost little to redo, so they never raise the band; an ID missing from the map is no idea.
const weighs = node => !!node && node.status !== 'suggested';
// Open: everything but an accepted, current finding. Any kind counts: the user's answers live on every kind.
const isOpen = node => !(node.status === 'explored' && node.reviewState === 'accepted' && !node.stale);

// What each map object needs once: a changed map is a new object.
const caches = new WeakMap();
function cacheOf(map) {
  if (!caches.has(map)) caches.set(map, { links: changeLinks(map), byId: new Map(map.nodes.map(node => [node.id, node])), index: null, entries: new Map(), order: null });
  return caches.get(map);
}

// Per idea ID: { band, open, reason }; `reason` says why a high one is high. Each idea's walk stops once its band is
// certain to be high, so a map where most ideas depend on others costs little more than a sparse one. The full lists
// come from impactOf, one idea at a time: listing them for every idea grows with the square of the map.
export function impactIndex(map) {
  const cache = cacheOf(map);
  if (cache.index) return cache.index;
  const index = {}, { high: limits } = impactBands;
  for (const node of map.nodes) {
    let affected = 0, through = 0;
    const high = () => affected >= limits.affected || through >= limits.throughDependencies, branch = [node.id];
    for (const [id] of changeWalk(map, [node.id], { links: cache.links, dependencies: false })) { branch.push(id); if (weighs(cache.byId.get(id))) affected++; if (high()) break; }
    if (!high()) for (const [id] of changeWalk(map, branch, { links: cache.links })) { if (weighs(cache.byId.get(id))) { affected++; through++; } if (high()) break; }
    const reason = through >= limits.throughDependencies ? `At least ${limits.throughDependencies} ideas elsewhere depend on it.` : affected >= limits.affected ? `At least ${limits.affected} ideas rest on it.` : null;
    index[node.id] = { band: bandOf(affected, through), open: isOpen(node), reason };
  }
  return (cache.index = index);
}

// One idea in full: { affected, inBranch, throughDependencies, suggestions, band, open, path(id) }. The change goes down
// the branch by `contains` first, then on from the whole branch along any link, so an idea reached both ways is in
// this branch. Lists hold ideas in the map only, nearest first, then in reading order. `path(id)` gives the steps the
// change takes, each { from, to, via: 'contains' | 'depends on' }: the shortest of its kind, ties by ID; null if none.
export function impactOf(map, nodeId) {
  const cache = cacheOf(map);
  if (cache.entries.has(nodeId)) return cache.entries.get(nodeId);
  const came = new Map([[nodeId, null]]), depth = new Map([[nodeId, 0]]), branch = [], beyond = [];
  const reach = (list, walk) => { for (const [id, step] of walk) { came.set(id, step); depth.set(id, depth.get(step.from) + 1); list.push(id); } };
  reach(branch, changeWalk(map, [nodeId], { links: cache.links, dependencies: false }));
  reach(beyond, changeWalk(map, [nodeId, ...branch], { links: cache.links }));
  cache.order ??= new Map(treeOrder(map).map(({ node }, at) => [node.id, at]));
  const shown = ids => ids.filter(id => cache.byId.has(id)).sort((a, b) => depth.get(a) - depth.get(b) || cache.order.get(a) - cache.order.get(b));
  const inBranch = shown(branch), throughDependencies = shown(beyond), affected = shown([...branch, ...beyond]);
  const weight = ids => ids.filter(id => weighs(cache.byId.get(id))).length;
  const path = id => {
    if (!came.get(id)) return null;
    const steps = [];
    for (let at = id; came.get(at); at = came.get(at).from) steps.unshift({ from: came.get(at).from, to: at, via: came.get(at).dependency ? 'depends on' : 'contains' });
    return steps;
  };
  const entry = { affected, inBranch, throughDependencies, suggestions: affected.length - weight(affected), band: bandOf(weight(affected), weight(throughDependencies)), open: isOpen(cache.byId.get(nodeId)), path };
  cache.entries.set(nodeId, entry);
  return entry;
}
export const impactPath = (map, fromId, toId) => impactOf(map, fromId).path(toId);

// The ideas on dependency chains between two of `highlighted`, which a filter keeps visible as quieter context. Not the
// change walk: it follows `depends_on` links both ways, to find what sits between two highlighted ideas.
export function impactContext(map, highlighted) {
  const forward = new Map(), backward = new Map(), add = (links, a, b) => { if (!links.has(a)) links.set(a, []); links.get(a).push(b); };
  for (const edge of map.edges ?? []) if (edge.type === 'depends_on') { add(forward, edge.to, edge.from); add(backward, edge.from, edge.to); }
  const spread = links => { const seen = new Set(highlighted); for (const id of seen) for (const next of links.get(id) ?? []) seen.add(next); return seen; };
  const after = spread(forward), before = spread(backward);
  return [...after].filter(id => before.has(id) && !highlighted.has(id));
}

// "Changing this would affect 7 ideas: 4 in this branch, 3 elsewhere through dependencies. 2 of them are untouched
// suggestions, which cost little to redo. 5 have findings that would need review." Findings come from the map as the
// app shows it (hasFindings, completed).
export function impactSentence(entry, map) {
  if (!entry.affected.length) return 'Changing this affects no other ideas.';
  const byId = cacheOf(map).byId;
  const parts = [entry.inBranch.length ? `${entry.inBranch.length} in this branch` : '', entry.throughDependencies.length ? `${entry.throughDependencies.length} elsewhere through dependencies` : ''].filter(Boolean);
  const untouched = entry.suggestions ? ` ${entry.suggestions} of them ${entry.suggestions === 1 ? 'is an untouched suggestion' : 'are untouched suggestions'}, which cost little to redo.` : '';
  const findings = entry.affected.filter(id => byId.get(id).hasFindings || byId.get(id).completed).length;
  return `Changing this would affect ${count(entry.affected.length, 'idea', 'ideas')}: ${parts.join(', ')}.${untouched}${findings ? ` ${findings} ${findings === 1 ? 'has' : 'have'} findings that would need review.` : ''}`;
}

// The inspector's Impact section: the band, the sentence, and the first 12 affected ideas, each with how the change
// gets there, in the Nearby ideas style.
export function impactHtml(map, node, { esc }) {
  const entry = impactOf(map, node.id), byId = cacheOf(map).byId;
  const head = `<h3 class="section-label">Impact</h3><p class="impact-band ${entry.band}">${bandWords[entry.band]}</p><p class="impact-sentence">${esc(impactSentence(entry, map))}</p>`;
  if (!entry.affected.length) return head;
  const titleOf = id => byId.get(id)?.title ?? 'a missing idea';
  const branch = new Set(entry.inBranch);
  const via = id => {
    const between = entry.path(id).slice(0, -1).map(step => titleOf(step.to)).join(' → ');
    if (branch.has(id)) return `Below it${between ? ` · through ${between}` : ''}`;
    return between ? `Through dependencies: ${between}` : 'Depends on it';
  };
  const items = entry.affected.slice(0, 12).map(id => `<button type="button" class="relationship" data-select="${esc(id)}">${esc(via(id))}<strong>${esc(titleOf(id))}</strong></button>`).join('');
  const more = entry.affected.length > 12 ? `<p class="form-note">${entry.affected.length - 12} more. Find an idea reaches any of them.</p>` : '';
  return `${head}<details data-editor="impact"><summary>Show affected ideas</summary>${items}${more}</details>`;
}

// High impact, still open: a More filter, which the app passes to mapOverview on the live map. Each row says why the
// idea is high from the index; the full sentence is in the inspector, since walking every listed idea in full grows
// with the square of the map. Ideas on dependency chains between two of its matches stay visible as quieter context.
export function impactFilter(map) {
  const index = impactIndex(map);
  return { id: 'impact:high-open', kind: 'impact', short: 'High impact, still open', name: 'High impact, still open', label: 'High-impact ideas that are still open',
    empty: 'No high-impact ideas are still open.', matches: node => index[node.id].band === 'high' && index[node.id].open,
    lines: node => [{ text: index[node.id].reason }], context: matched => impactContext(map, new Set(matched.map(node => node.id))) };
}
