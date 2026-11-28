// Reuse earlier research answers (Z4): when the user asks for the same help again and nothing it read has changed, the
// browser opens the earlier result instead of queueing new work. A job type opts in with `reusable: true`. The check
// runs only when the user asks (GET /api/maps/ID/reusable), never when a map is viewed, so large maps cost nothing.
import { createHash } from 'node:crypto';
import { isOpenJob } from './map-validation.mjs';

// What the agent read, as a typed packet carries it under `contentKey`: its content without the fields that identify
// the work. The claim stores a SHA-256 of it; it stays in map.json only, never in views, versions or exports.
export const contentKey = Symbol('content');
export const reuseKey = content => createHash('sha256').update(JSON.stringify(content)).digest('hex');

// The result to open instead of asking again: the newest finished one of `type` for this idea and question, when nothing
// for it is waiting, it is not stale, and the packet it would get now is the one it got. Read-only. Jobs from before
// this feature have no key and are never offered; neither is a type whose packet cannot be built now.
export async function reusableResult(store, mapId, { type, nodeId, questionId }) {
  const map = await store.get(mapId), definition = store.jobType(type);
  if (!definition?.reusable) return { jobId: null };
  const mine = map.jobs.filter(job => job.type === type && job.nodeId === nodeId && job.subjectId === questionId);
  const latest = mine.filter(job => job.status === 'completed' && job.result).at(-1), node = map.nodes.find(item => item.id === nodeId);
  if (!latest?.reuseKey || !node || mine.some(isOpenJob) || store.resultIsStale(map, latest)) return { jobId: null };
  const packet = await store.typedPacket(map, latest, definition, node).catch(() => null);
  return { jobId: packet && reuseKey(packet[contentKey]) === latest.reuseKey ? latest.id : null };
}
