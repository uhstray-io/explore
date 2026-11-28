// Reuse earlier research answers (Z4): when the user asks for the same help again and nothing it read has changed, the
// browser opens the earlier result instead of queueing new work. A job type opts in with `reusable: true`. The check
// runs only when the user asks (GET /api/maps/ID/reusable), never when a map is viewed, so large maps cost nothing.
import { createHash } from 'node:crypto';
import { isOpenJob } from './map-validation.mjs';

// The fields every typed packet carries to identify the work rather than what the agent reads about it.
const identifying = new Set(['mapId', 'mapTitle', 'mapRevision', 'jobId', 'jobType', 'claimKey', 'reason', 'contextCharacters', 'approximateTokens']);
// What the agent read: a SHA-256 of the packet it was given, without the identifying fields. The claim stores it from
// the packet it built; it stays in map.json only, never in views, versions or exports.
export const reuseKey = packet => createHash('sha256').update(JSON.stringify(Object.entries(packet).filter(([key]) => !identifying.has(key)))).digest('hex');

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
  return { jobId: packet && reuseKey(packet) === latest.reuseKey ? latest.id : null };
}
