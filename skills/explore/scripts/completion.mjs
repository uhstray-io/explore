// When an idea is complete, and when its body is findings rather than its premise. Shared by the Store and the modules
// it loads (the inbox's idea index among them); it imports only the view's job check, so job types can use it with no
// import cycle back to the Store, which re-exports both.
import { isInvestigationJob } from '../assets/workspace-view.js';

// A finished investigation of this idea that still counts. Only branch investigations complete an idea or
// count as its findings; other job types never do, and runs from before a restart are history.
export const currentRun = (node, job) => job.nodeId === node.id && isInvestigationJob(job) && job.status === 'completed' && !job.stale && !job.restartedAt && !!job.result;
export function isCompleted(map, node) {
  return !!node.completedAt || node.status === 'explored' || map.jobs.some(job => currentRun(node, job) && !job.result.questions?.length);
}
export function hasFindings(map, node) {
  return node.status === 'explored' || (map.jobs || []).some(job => currentRun(node, job) && job.result.body === node.body && job.result.summary === node.summary);
}
