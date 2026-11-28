// Reuse earlier research answers (Z4): when the user asks for the same help again and nothing it used has changed,
// the browser offers the earlier result instead of queueing new work. A job type opts in with `reusable: true` and
// `requestInput({ node, subjectId })`, the input a request would send now. The keys stay on the job in map.json;
// public views carry only the derived `contextUnchanged`. Reuse never involves the agent.
import { createHash } from 'node:crypto';
import { signature } from './neighbourhood.mjs';
import { goalForPacket } from './guidance.mjs';
import { glossaryForPacket } from './glossary.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Request inputs compare after trimming outer whitespace; a paraphrase is a different request.
const trimmed = value => (typeof value === 'string' ? value.trim() : Array.isArray(value) ? value.map(trimmed)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, trimmed(item)])) : value ?? null);

// The same request: the kind of work, its idea, what it is about and its inputs. Stored when the job is queued.
export const requestKey = ({ type, nodeId, subjectId, input }) => hash([type, nodeId ?? null, subjectId ?? null, trimmed(input)]);
// What the work read: the idea's context (ancestors, links and their content revisions), and the map's goal and
// glossary when its packet carries them. Stored when the job is claimed, as its packet is built.
export const reuseKey = (map, node, definition) => hash([signature(map, node), definition.goal === false ? null : goalForPacket(map), definition.glossary === false ? null : glossaryForPacket(map, node)]);

// Whether a finished job's result can be offered again now: a reusable type, completed with its result and not
// stale, keys stored (jobs saved before this feature have none), and the same request and context as now.
export function contextUnchanged(map, job, definition, { stale }) {
  if (!definition?.reusable || job.status !== 'completed' || stale || !job.result || !job.requestKey || !job.reuseKey) return false;
  const node = map.nodes.find(item => item.id === job.nodeId);
  const input = node ? definition.requestInput({ node, subjectId: job.subjectId }) : undefined;
  return input !== undefined && requestKey({ type: job.type, nodeId: job.nodeId, subjectId: job.subjectId, input }) === job.requestKey && reuseKey(map, node, definition) === job.reuseKey;
}
