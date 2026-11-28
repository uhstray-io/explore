// Reuse earlier research answers (Z4): when the user asks for the same help again and nothing it read has changed, the
// browser opens the earlier result instead of queueing new work. A job type opts in with `reusable: true`; its packet
// must be built synchronously from the map. Reuse never involves the agent.
import { createHash } from 'node:crypto';
import { goalForPacket, packetBudget } from './guidance.mjs';
import { agreedTerms } from '../assets/glossary.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// What a reusable job read: its type's own packet for the idea and question, rebuilt from the map, with the goal and
// the agreed glossary when its packet carries them. Stored when the job is claimed, as the agent's packet is built,
// and compared with the map as it is now; the key stays in map.json only, never in views, versions or exports.
export function reuseKey(map, job, node, definition) {
  const packet = definition.packet({ map, job, node, budget: packetBudget(map, { goal: definition.goal !== false }) });
  if (packet && typeof packet.then === 'function') throw new Error(`${definition.label} builds its packet asynchronously, so it cannot be reused.`);
  return hash([packet, definition.goal === false ? null : goalForPacket(map), definition.glossary === false ? null : agreedTerms(map).map(({ term, definition: meaning }) => [term, meaning])]);
}

// The jobs whose result can be offered again now: for each reusable type, idea and question, only the newest finished
// job with a result, when nothing for it is waiting, it is not stale and it reads the same as the map now. Jobs from
// before this feature have no key and are never offered. `stale(job)` is the Store's own check.
export function reusableJobIds(map, { jobType, stale }) {
  const newest = new Map(), open = new Set(), ids = new Set();
  for (const job of map.jobs) {
    if (!jobType(job.type)?.reusable) continue;
    const key = `${job.type} ${job.nodeId} ${job.subjectId ?? ''}`;
    if (job.status === 'queued' || job.status === 'running') open.add(key);
    if (job.status === 'completed' && job.result) newest.set(key, job);
  }
  for (const [key, job] of newest) {
    if (open.has(key) || !job.reuseKey || stale(job)) continue;
    const node = map.nodes.find(item => item.id === job.nodeId);
    if (node && reuseKey(map, job, node, jobType(job.type)) === job.reuseKey) ids.add(job.id);
  }
  return ids;
}
