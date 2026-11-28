import { createHash } from 'node:crypto';
import { isOpenJob, readProblem } from './map-validation.mjs';
import { snapshotOf } from './versions.mjs';
import { branchIds } from '../assets/graph.js';
import { assignmentsOf } from '../assets/assignments.js';
import { openRequestsOn, dropRequestsOn } from './assignments.mjs';

// Restore one branch from a saved version (E2): an idea and everything below it come back as they were, and the
// rest of the map stays as it is now. The user previews exactly what changes; the action recomputes the same plan,
// refuses if it differs from the preview, and saves once, so E1's Undo reverses it. No research is queued.
// `rules` is the Store: its isComplete, hasConclusions and affectedBy read a map and change nothing.

class RestoreProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new RestoreProblem(message, status); };
const linkKey = edge => `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
// JSON with sorted keys, so the same idea saved with its fields in another order still compares equal.
const canonical = value => JSON.stringify(value, (key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : entry);
// Jobs as versions keep them: claim data that works only on one machine is never a difference.
const savedJobs = jobs => snapshotOf({ jobs }).jobs.sort((a, b) => (a.id < b.id ? -1 : 1));

function conflictsOf(current, top, then, was) {
  const ids = new Set(current.nodes.map(node => node.id)), conflicts = [];
  if (!ids.has(top.parentId)) conflicts.push({ code: 'missing-parent', message: 'The idea this branch sat under no longer exists, so the branch has nowhere to go.', nodeIds: [top.parentId] });
  const moved = [...then].filter(id => ids.has(id) && !was.has(id));
  if (moved.length) conflicts.push({ code: 'moved', message: 'Some ideas from this branch now sit elsewhere in the map.', nodeIds: moved });
  const busy = [...new Set(current.jobs.filter(job => isOpenJob(job) && was.has(job.nodeId)).map(job => job.nodeId))];
  if (busy.length) conflicts.push({ code: 'active-work', message: 'Work is queued or running in this branch. Wait until it finishes, or stop it, before restoring.', nodeIds: busy });
  return conflicts;
}

// The map with the branch as it was, where it sits today (at the end of the list when it was deleted since).
// Links: untouched outside; inside from the version; across the edge from today or the version, when both ends
// exist. Jobs for either branch are the version's, since completion is partly derived from them. Positions are
// today's where there is one and the version's otherwise.
function merge(current, historical, nodeId, then, was) {
  const touched = new Set([...then, ...was]);
  const restored = historical.nodes.filter(node => then.has(node.id)).map(node => structuredClone(node));
  const outside = current.nodes.filter(node => !was.has(node.id)), at = current.nodes.findIndex(node => node.id === nodeId);
  const insertAt = at < 0 ? outside.length : current.nodes.slice(0, at).filter(node => !was.has(node.id)).length;
  const nodes = [...outside.slice(0, insertAt), ...restored, ...outside.slice(insertAt)], exists = new Set(nodes.map(node => node.id));
  const edges = [], seen = new Set();
  const add = edge => { const key = linkKey(edge); if (!seen.has(key) && exists.has(edge.from) && exists.has(edge.to)) { seen.add(key); edges.push(edge); } };
  const crosses = (edge, ids) => ids.has(edge.from) !== ids.has(edge.to);
  for (const edge of current.edges) if (!touched.has(edge.from) && !touched.has(edge.to)) add(edge);
  for (const edge of current.edges) if (crosses(edge, touched)) add(edge);
  for (const edge of historical.edges) if (then.has(edge.from) && then.has(edge.to)) add(structuredClone(edge));
  for (const edge of historical.edges) if (crosses(edge, then)) add(structuredClone(edge));
  const jobs = [...current.jobs.filter(job => !touched.has(job.nodeId)), ...historical.jobs.filter(job => then.has(job.nodeId)).map(job => structuredClone(job))];
  const nowAt = current.view?.positions ?? {}, thenAt = historical.view?.positions ?? {};
  const positions = Object.fromEntries(nodes.map(node => [node.id, nowAt[node.id] ?? (then.has(node.id) ? thenAt[node.id] : undefined)]).filter(([, point]) => point));
  return { touched, restored, nodes, edges, jobs, positions };
}

// What changes, idea by idea and link by link. A link's note counts.
function differences(current, merged, was, then) {
  const nowById = new Map(current.nodes.map(node => [node.id, node]));
  const changed = merged.restored.filter(node => was.has(node.id) && canonical(node) !== canonical(nowById.get(node.id))).map(node => ({ id: node.id, title: node.title, before: nowById.get(node.id).summary, after: node.summary }));
  const readded = merged.restored.filter(node => !nowById.has(node.id)).map(node => ({ id: node.id, title: node.title, after: node.summary }));
  const removed = current.nodes.filter(node => was.has(node.id) && !then.has(node.id)).map(node => ({ id: node.id, title: node.title, before: node.summary }));
  const semantic = list => list.filter(edge => edge.type !== 'contains'), keys = list => new Set(semantic(list).map(canonical));
  const before = keys(current.edges), after = keys(merged.edges);
  const links = { added: semantic(merged.edges).filter(edge => !before.has(canonical(edge))), removed: semantic(current.edges).filter(edge => !after.has(canonical(edge))) };
  const changedIds = new Set(changed.map(node => node.id));
  const unchanged = merged.restored.filter(node => was.has(node.id) && !changedIds.has(node.id)).length;
  const jobsOf = list => canonical(savedJobs(list.filter(job => merged.touched.has(job.nodeId))));
  const nothing = !changed.length && !readded.length && !removed.length && !links.added.length && !links.removed.length && jobsOf(current.jobs) === jobsOf(merged.jobs);
  return { changed, readded, removed, unchanged, links, nothing };
}

// Restored ideas that change are flagged when what they relied on outside the branch changed since the version:
// an ancestor, or a prerequisite they depend on (one deleted since counts as changed). Outside ideas that depend on
// what changes go through the usual invalidation: flagged when they have conclusions, their questions set aside.
function flagsOf(current, historical, after, top, then, changes, rules) {
  const nowById = new Map(current.nodes.map(node => [node.id, node])), thenById = new Map(historical.nodes.map(node => [node.id, node]));
  const reliedOn = new Set();
  for (let id = top.parentId; nowById.has(id) && !reliedOn.has(id); id = nowById.get(id).parentId) reliedOn.add(id);
  for (const edge of [...after.edges, ...historical.edges]) if (edge.type === 'depends_on' && then.has(edge.from) && !then.has(edge.to)) reliedOn.add(edge.to);
  const changedSince = [...reliedOn].filter(id => nowById.get(id)?.contentRevision !== thenById.get(id)?.contentRevision);
  const moving = new Set([...changes.changed, ...changes.readded].map(node => node.id));
  const flagInside = changedSince.length ? after.nodes.filter(node => moving.has(node.id) && rules.hasConclusions(after, node)).map(node => node.id) : [];
  const exists = new Set(after.nodes.map(node => node.id)), touched = new Set([...then, ...changes.removed.map(node => node.id)]);
  const reached = new Set([...rules.affectedBy(after, [...moving]), ...rules.affectedBy(current, changes.removed.map(node => node.id))]);
  const outsideAffected = [...reached].filter(id => !touched.has(id) && exists.has(id));
  const flagOutside = outsideAffected.filter(id => rules.hasConclusions(after, after.nodes.find(node => node.id === id)));
  const setAside = outsideAffected.reduce((sum, id) => sum + nowById.get(id).questions.filter(question => !question.supersededAt).length, 0);
  return { reliedOn, changedSince, flagInside, outsideAffected, flagOutside, setAside };
}

// What restoring the branch at `nodeId` from `historical` would make of `current`. Never changes its inputs.
// `conflicts` lists what blocks it; everything else describes the result, and `hash` names both the map it starts
// from and the result, so the action can refuse a plan the user did not see.
export function branchRestoration(current, historical, nodeId, rules) {
  need(nodeId !== current.rootId && nodeId !== historical.rootId, 'The map’s first idea cannot be restored on its own. Restore the whole version instead.');
  const top = historical.nodes.find(node => node.id === nodeId);
  need(top, 'That idea is not in this version.', 404);
  const then = branchIds(historical, nodeId), was = branchIds(current, nodeId);
  const conflicts = conflictsOf(current, top, then, was), merged = merge(current, historical, nodeId, then, was);
  const changes = differences(current, merged, was, then);
  if (!conflicts.length && changes.nothing) conflicts.push({ code: 'unchanged', message: 'This branch already matches that version.', nodeIds: [] });
  const after = { ...current, nodes: merged.nodes, edges: merged.edges, jobs: merged.jobs };
  const flags = flagsOf(current, historical, after, top, then, changes, rules);
  const nowById = new Map(current.nodes.map(node => [node.id, node]));
  const reopened = merged.restored.filter(node => nowById.has(node.id) && rules.isComplete(current, nowById.get(node.id)) && !rules.isComplete(after, node)).map(node => node.id);
  const state = id => [id, nowById.get(id)?.contentRevision ?? null, nowById.get(id)?.status ?? null];
  const removed = new Set(changes.removed.map(node => node.id)); // Requests to look at these go with them (H7).
  const hash = createHash('sha256').update(canonical({ nodeId,
    from: { branch: current.nodes.filter(node => was.has(node.id)), requests: assignmentsOf(current).filter(item => removed.has(item.nodeId)).map(item => [item.id, item.status]), jobs: savedJobs(current.jobs.filter(job => merged.touched.has(job.nodeId))), reliedOn: [...flags.reliedOn].sort().map(state), outside: flags.outsideAffected.map(state) },
    to: { branch: merged.restored, links: merged.edges.map(canonical).sort(), jobs: savedJobs(merged.jobs.filter(job => merged.touched.has(job.nodeId))) } })).digest('hex');
  return { conflicts, branch: then, nodes: merged.nodes, edges: merged.edges, jobs: merged.jobs, positions: merged.positions,
    changes: { changed: changes.changed, readded: changes.readded, removed: changes.removed, unchanged: changes.unchanged }, links: changes.links,
    flagInside: flags.flagInside, flagSource: flags.changedSince[0] ?? null, outsideAffected: flags.outsideAffected, flagOutside: flags.flagOutside, setAside: flags.setAside, reopened, removed, requestsRemoved: openRequestsOn(current, removed), hash };
}

const plainVersion = ({ id, at, name }) => ({ id, at, ...(name ? { name } : {}) });
const page = (list, offset, limit) => { const from = Math.max(0, Math.trunc(Number(offset)) || 0), size = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50)); return { items: list.slice(from, from + size), offset: from, nextOffset: from + size < list.length ? from + size : null }; };
// Writes nothing. The ideas that change come in pages; every other list gives its full count with the first 50.
export async function previewBranchRestore(store, mapId, versionId, { nodeId, offset, limit } = {}) {
  const current = await store.get(mapId), { version, map: snapshot } = await store.versions.get(mapId, versionId);
  need(!readProblem(snapshot, mapId), 'This version is damaged and cannot be restored. Choose another version.', 409);
  const plan = branchRestoration(current, snapshot, nodeId, store);
  const titles = new Map([...snapshot.nodes, ...current.nodes].map(node => [node.id, node.title]));
  const idea = id => ({ id, title: titles.get(id) ?? 'A removed idea' }), first = list => list.slice(0, 50);
  const link = edge => ({ from: edge.from, to: edge.to, type: edge.type, fromTitle: idea(edge.from).title, toTitle: idea(edge.to).title });
  const list = [...plan.changes.changed.map(entry => ({ ...entry, change: 'changed' })), ...plan.changes.readded.map(entry => ({ ...entry, change: 're-added' })), ...plan.changes.removed.map(entry => ({ ...entry, change: 'removed' }))];
  const { items, offset: from, nextOffset } = page(list, offset, limit);
  return { mapId, revision: current.revision, version: plainVersion(version), node: idea(nodeId), hash: plan.hash,
    counts: { changed: plan.changes.changed.length, readded: plan.changes.readded.length, removed: plan.changes.removed.length, unchanged: plan.changes.unchanged,
      linksAdded: plan.links.added.length, linksRemoved: plan.links.removed.length, affected: plan.outsideAffected.length, flagged: plan.flagOutside.length,
      questionsSetAside: plan.setAside, flaggedInside: plan.flagInside.length, reopened: plan.reopened.length, requestsRemoved: plan.requestsRemoved },
    nodes: items, offset: from, nextOffset,
    linksAdded: first(plan.links.added).map(link), linksRemoved: first(plan.links.removed).map(link),
    affected: first(plan.outsideAffected).map(idea), flagged: first(plan.flagOutside).map(idea), flaggedInside: first(plan.flagInside).map(idea), reopened: first(plan.reopened).map(idea),
    conflicts: plan.conflicts.map(entry => ({ code: entry.code, message: entry.message, nodes: entry.nodeIds.map(idea) })) };
}

export const branchRestoreActions = {
  // User-only. `nodeId`, `version`, `previewHash`.
  'restore-branch': { target: 'map', apply: async ({ map, input, store }) => {
    const { map: snapshot } = await store.versions.get(map.id, input.version);
    need(!readProblem(snapshot, map.id), 'This version is damaged and cannot be restored. Choose another version.', 409);
    const plan = branchRestoration(map, snapshot, input.nodeId, store);
    need(!plan.conflicts.length, plan.conflicts[0]?.message, 409);
    need(input.previewHash === plan.hash, 'This branch or its version changed since the preview. Preview the restore again.', 409);
    Object.assign(map, { nodes: plan.nodes, edges: plan.edges, jobs: plan.jobs });
    dropRequestsOn(map, plan.removed);
    map.view = { ...map.view, positions: plan.positions };
    // Work that was active in the version comes back interrupted, as in a whole-map restore; work elsewhere is untouched.
    store.deactivateOpenWork(map, { at: new Date().toISOString(), error: 'Interrupted by restoring an earlier version of this branch. Retry to continue.', within: plan.branch });
    for (const id of plan.flagInside) store.flagForReview(map.nodes.find(node => node.id === id), { sourceId: plan.flagSource, kind: 'restored-context-changed' });
    store.invalidate(map, new Set(plan.outsideAffected), { sourceId: input.nodeId, kind: 'branch-restored' });
    store.event(map, 'branch-restored', input.nodeId, input.version);
  } },
};
