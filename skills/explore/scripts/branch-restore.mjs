import { createHash } from 'node:crypto';
import { isOpenJob, readProblem } from './map-validation.mjs';
import { branchIds } from '../assets/graph.js';

// Restore one branch from a saved version (E2): an idea and everything below it come back as they were, and the
// rest of the map stays as it is now. The user previews exactly what changes; the action recomputes the same plan,
// refuses if it differs from the preview, and saves once, so E1's Undo reverses it. No research is queued.

class RestoreProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new RestoreProblem(message, status); };
const linkKey = edge => `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
// JSON with sorted keys, so the same idea saved with its fields in another order still compares equal.
const canonical = value => JSON.stringify(value, (key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : entry);

// The Store's rules a plan needs, passed in so the plan stays pure.
export const rulesOf = store => ({ isComplete: (map, node) => store.isComplete(map, node), hasConclusions: (map, node) => store.hasConclusions(map, node), affectedBy: (map, ids) => store.affectedBy(map, ids) });

// What restoring the branch at `nodeId` from `historical` would make of `current`. Never changes its inputs.
// `conflicts` lists what blocks it; everything else describes the result, and `hash` names it for the action.
export function branchRestoration(current, historical, nodeId, rules) {
  need(nodeId !== current.rootId && nodeId !== historical.rootId, 'The map’s first idea cannot be restored on its own. Restore the whole version instead.');
  const top = historical.nodes.find(node => node.id === nodeId);
  need(top, 'That idea is not in this version.', 404);
  const then = branchIds(historical, nodeId), was = branchIds(current, nodeId), touched = new Set([...then, ...was]);
  const nowById = new Map(current.nodes.map(node => [node.id, node])), thenById = new Map(historical.nodes.map(node => [node.id, node]));
  const conflicts = [], conflict = (code, message, nodeIds) => conflicts.push({ code, message, nodeIds });
  if (!nowById.has(top.parentId)) conflict('missing-parent', 'The idea this branch sat under no longer exists, so the branch has nowhere to go.', [top.parentId]);
  const moved = [...then].filter(id => nowById.has(id) && !was.has(id));
  if (moved.length) conflict('moved', 'Some ideas from this branch now sit elsewhere in the map.', moved);
  const busy = [...new Set(current.jobs.filter(job => isOpenJob(job) && was.has(job.nodeId)).map(job => job.nodeId))];
  if (busy.length) conflict('active-work', 'Work is queued or running in this branch. Wait until it finishes, or stop it, before restoring.', busy);

  // The branch as it was, where it sits today (at the end of the list when it was deleted since).
  const restored = historical.nodes.filter(node => then.has(node.id)).map(node => structuredClone(node));
  const outside = current.nodes.filter(node => !was.has(node.id)), at = current.nodes.findIndex(node => node.id === nodeId);
  const insertAt = at < 0 ? outside.length : current.nodes.slice(0, at).filter(node => !was.has(node.id)).length;
  const nodes = [...outside.slice(0, insertAt), ...restored, ...outside.slice(insertAt)], exists = new Set(nodes.map(node => node.id));
  // Links: untouched outside; inside from the version; across the boundary from today or the version, when both ends exist.
  const edges = [], seen = new Set();
  const add = edge => { const key = linkKey(edge); if (!seen.has(key) && exists.has(edge.from) && exists.has(edge.to)) { seen.add(key); edges.push(edge); } };
  const crosses = (edge, ids) => ids.has(edge.from) !== ids.has(edge.to);
  for (const edge of current.edges) if (!touched.has(edge.from) && !touched.has(edge.to)) add(edge);
  for (const edge of current.edges) if (crosses(edge, touched)) add(edge);
  for (const edge of historical.edges) if (then.has(edge.from) && then.has(edge.to)) add(structuredClone(edge));
  for (const edge of historical.edges) if (crosses(edge, then)) add(structuredClone(edge));
  // Jobs for either branch are the version's: completion is partly derived from them.
  const jobs = [...current.jobs.filter(job => !touched.has(job.nodeId)), ...historical.jobs.filter(job => then.has(job.nodeId)).map(job => structuredClone(job))];
  // Today's position where there is one, the version's otherwise; none for ideas that are gone.
  const nowAt = current.view?.positions ?? {}, thenAt = historical.view?.positions ?? {};
  const positions = Object.fromEntries(nodes.map(node => [node.id, nowAt[node.id] ?? (then.has(node.id) ? thenAt[node.id] : undefined)]).filter(([, point]) => point));

  const changed = restored.filter(node => was.has(node.id) && canonical(node) !== canonical(nowById.get(node.id))).map(node => ({ id: node.id, title: node.title, before: nowById.get(node.id).summary, after: node.summary }));
  const readded = restored.filter(node => !nowById.has(node.id)).map(node => ({ id: node.id, title: node.title, after: node.summary }));
  const removed = current.nodes.filter(node => was.has(node.id) && !then.has(node.id)).map(node => ({ id: node.id, title: node.title, before: node.summary }));
  const semantic = list => list.filter(edge => edge.type !== 'contains');
  const keysBefore = new Set(semantic(current.edges).map(linkKey)), keysAfter = new Set(semantic(edges).map(linkKey));
  const links = { added: semantic(edges).filter(edge => !keysBefore.has(linkKey(edge))), removed: semantic(current.edges).filter(edge => !keysAfter.has(linkKey(edge))) };
  const branchJobs = list => canonical(list.filter(job => touched.has(job.nodeId)).sort((a, b) => (a.id < b.id ? -1 : 1)));
  if (!conflicts.length && !changed.length && !readded.length && !removed.length && !links.added.length && !links.removed.length && branchJobs(current.jobs) === branchJobs(jobs))
    conflict('unchanged', 'This branch already matches that version.', []);

  // Restored findings need another look when what they relied on outside the branch changed since: an ancestor,
  // or a prerequisite they depend on. Outside ideas that depend on what changes go through the usual traversal.
  const after = { ...current, nodes, edges, jobs };
  const reliedOn = new Set();
  for (let id = top.parentId; nowById.has(id) && !reliedOn.has(id); id = nowById.get(id).parentId) reliedOn.add(id);
  for (const edge of edges) if (edge.type === 'depends_on' && then.has(edge.from) && !then.has(edge.to)) reliedOn.add(edge.to);
  const changedSince = [...reliedOn].filter(id => nowById.get(id)?.contentRevision !== thenById.get(id)?.contentRevision);
  const flagInside = changedSince.length ? restored.filter(node => rules.hasConclusions(after, node)).map(node => node.id) : [];
  const reached = new Set([...rules.affectedBy(after, [...changed, ...readded].map(node => node.id)), ...rules.affectedBy(current, removed.map(node => node.id))]);
  const outsideAffected = [...reached].filter(id => !touched.has(id) && exists.has(id));
  const flagOutside = outsideAffected.filter(id => rules.hasConclusions(after, nodes.find(node => node.id === id)));
  const reopened = restored.filter(node => nowById.has(node.id) && rules.isComplete(current, nowById.get(node.id)) && !rules.isComplete(after, node)).map(node => node.id);

  const hash = createHash('sha256').update(canonical([nodeId, restored, [...edges].map(linkKey).sort(), jobs.filter(job => touched.has(job.nodeId)).map(job => job.id).sort(),
    removed.map(node => node.id), flagInside, outsideAffected])).digest('hex');
  return { conflicts, branch: then, nodes, edges, jobs, positions, changes: { changed, readded, removed, unchanged: restored.length - changed.length - readded.length },
    links, flagInside, flagSource: changedSince[0] ?? null, outsideAffected, flagOutside, reopened, hash };
}

const plainVersion = ({ id, at, name }) => ({ id, at, ...(name ? { name } : {}) });
// Writes nothing. The ideas that change come in pages; the hash is what the action must be sent back.
export async function previewBranchRestore(store, mapId, versionId, { nodeId, offset, limit } = {}) {
  const current = await store.get(mapId), { version, map: snapshot } = await store.versions.get(mapId, versionId);
  need(!readProblem(snapshot, mapId), 'This version is damaged and cannot be restored. Choose another version.', 409);
  const plan = branchRestoration(current, snapshot, nodeId, rulesOf(store));
  const title = id => current.nodes.find(node => node.id === id)?.title ?? snapshot.nodes.find(node => node.id === id)?.title ?? 'A removed idea';
  const idea = id => ({ id, title: title(id) }), first = list => list.slice(0, 50);
  const link = edge => ({ from: edge.from, to: edge.to, type: edge.type, fromTitle: title(edge.from), toTitle: title(edge.to) });
  const list = [...plan.changes.changed.map(entry => ({ ...entry, change: 'changed' })), ...plan.changes.readded.map(entry => ({ ...entry, change: 're-added' })), ...plan.changes.removed.map(entry => ({ ...entry, change: 'removed' }))];
  const from = Math.max(0, Math.trunc(Number(offset)) || 0), size = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50));
  return { mapId, revision: current.revision, version: plainVersion(version), node: idea(nodeId), hash: plan.hash,
    counts: { changed: plan.changes.changed.length, readded: plan.changes.readded.length, removed: plan.changes.removed.length, unchanged: plan.changes.unchanged,
      linksAdded: plan.links.added.length, linksRemoved: plan.links.removed.length, flagged: plan.flagOutside.length, flaggedInside: plan.flagInside.length, reopened: plan.reopened.length },
    nodes: list.slice(from, from + size), offset: from, nextOffset: from + size < list.length ? from + size : null,
    linksAdded: first(plan.links.added).map(link), linksRemoved: first(plan.links.removed).map(link),
    flagged: first(plan.flagOutside).map(idea), flaggedInside: first(plan.flagInside).map(idea), reopened: first(plan.reopened).map(idea),
    conflicts: plan.conflicts.map(entry => ({ code: entry.code, message: entry.message, nodes: entry.nodeIds.map(idea) })) };
}

export const branchRestoreActions = {
  // User-only. `nodeId`, `version`, `previewHash`.
  'restore-branch': { target: 'map', apply: async ({ map, input, store }) => {
    const { map: snapshot } = await store.versions.get(map.id, input.version);
    need(!readProblem(snapshot, map.id), 'This version is damaged and cannot be restored. Choose another version.', 409);
    const plan = branchRestoration(map, snapshot, input.nodeId, rulesOf(store));
    need(!plan.conflicts.length, plan.conflicts[0]?.message, 409);
    need(input.previewHash === plan.hash, 'This branch or its version changed since the preview. Preview the restore again.', 409);
    Object.assign(map, { nodes: plan.nodes, edges: plan.edges, jobs: plan.jobs });
    map.view = { ...map.view, positions: plan.positions };
    // Work that was active in the version comes back interrupted, as in a whole-map restore; work elsewhere is untouched.
    store.deactivateOpenWork(map, { at: new Date().toISOString(), error: 'Interrupted by restoring an earlier version of this branch. Retry to continue.', within: plan.branch });
    for (const id of plan.flagInside) store.flagForReview(map.nodes.find(node => node.id === id), { sourceId: plan.flagSource, kind: 'restored-context-changed' });
    store.invalidate(map, new Set(plan.outsideAffected), { sourceId: input.nodeId, kind: 'branch-restored' });
    store.event(map, 'branch-restored', input.nodeId, input.version);
  } },
};
