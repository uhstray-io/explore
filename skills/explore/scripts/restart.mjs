import { createHash } from 'node:crypto';
import { answerStates, hasCurrentAnswer, isBlocking, laterQuestions, replaceAnswer } from '../assets/questions.js';

// Restart a finished branch from a changed answer (Z2). The user previews what would be deleted; the
// action recomputes the same plan, refuses if anything changed since, and saves a named checkpoint
// version before deleting anything, so restoring it brings everything back.

class RestartProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new RestartProblem(message, status); };
const active = job => ['queued', 'running'].includes(job.status);

// What restarting `node` from its answer to `questionId` would do. The hash covers every idea in the
// branch, so the action can refuse a plan the user did not see.
function restartPlan(store, map, node, questionId) {
  need(store.isComplete(map, node), 'Only a finished branch can be restarted. Change the answer in place instead.', 409);
  const question = node.questions.find(q => q.id === questionId);
  need(question && hasCurrentAnswer(question), 'Choose a saved, current answer on this branch.', 409);
  // Everything below the idea, by containment only: dependency links never widen the deletion.
  const below = new Set([node.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of map.edges) if (edge.type === 'contains' && below.has(edge.from) && !below.has(edge.to)) { below.add(edge.to); grew = true; }
    for (const other of map.nodes) if (other.parentId && below.has(other.parentId) && !below.has(other.id)) { below.add(other.id); grew = true; }
  }
  below.delete(node.id); below.delete(map.rootId);
  need(!map.jobs.some(job => active(job) && (job.nodeId === node.id || below.has(job.nodeId))), 'Wait until queued or running work in this branch finishes, or stop it, before restarting.', 409);
  const superseded = laterQuestions(map, node, question);
  const reached = store.affectedBy(map, [node.id, ...below]);
  const flagged = map.nodes.filter(other => other.id !== node.id && !below.has(other.id) && reached.has(other.id) && store.hasConclusions(map, other));
  const deleted = map.nodes.filter(other => below.has(other.id));
  const links = map.edges.filter(edge => below.has(edge.from) || below.has(edge.to));
  const hash = createHash('sha256').update(JSON.stringify([node.id, question.id, question.answer,
    [node, ...deleted].map(other => [other.id, other.contentRevision, other.status].join(' ')).sort(), superseded.map(q => q.id), flagged.map(other => other.id).sort(),
    links.map(edge => [edge.from, edge.to, edge.type].join(' ')).sort()])).digest('hex');
  return { question, below, deleted, superseded, flagged, links, hash };
}

// "Before restarting <title>, <date>", numbered when that name is already taken.
async function checkpointName(store, map, node) {
  const title = node.title.length > 80 ? `${node.title.slice(0, 79)}…` : node.title;
  const base = `Before restarting ${title}, ${new Date().toISOString().slice(0, 10)}`;
  const taken = new Set((await store.versions.scan(map.id)).map(version => version.name).filter(Boolean));
  let name = base;
  for (let count = 2; taken.has(name); count++) name = `${base} (${count})`;
  return name;
}

// Writes nothing. The ideas to delete come in pages; the hash is what the action must be sent back.
export async function previewRestart(store, mapId, { nodeId, questionId, offset, limit } = {}) {
  const map = await store.get(mapId), node = map.nodes.find(n => n.id === nodeId);
  need(node, 'Node not found.', 404);
  const plan = restartPlan(store, map, node, questionId);
  const from = Math.max(0, Math.trunc(Number(offset)) || 0), size = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50));
  return { mapId, revision: map.revision, hash: plan.hash, node: { id: node.id, title: node.title },
    question: { id: plan.question.id, text: plan.question.text }, oldAnswer: plan.question.answer,
    deleteCount: plan.deleted.length, deleted: plan.deleted.slice(from, from + size).map(n => ({ id: n.id, title: n.title })), offset: from,
    nextOffset: from + size < plan.deleted.length ? from + size : null,
    superseded: plan.superseded.map(q => ({ id: q.id, text: q.text })), flagged: plan.flagged.map(n => ({ id: n.id, title: n.title })),
    linksRemoved: plan.links.length, checkpointName: await checkpointName(store, map, node) };
}

export const restartActions = {
  // User-only. `questionId`, `answer`, `previewHash`, optional `answerState`.
  'restart-branch': { target: 'node', apply: async ({ map, node, input, store, actor }) => {
    const plan = restartPlan(store, map, node, input.questionId);
    need(typeof input.answer === 'string' && input.answer.trim(), 'Answer is required.');
    const answer = input.answer.trim();
    need(answer.length <= 12000, 'Answer must be at most 12000 characters.');
    need(answer !== plan.question.answer, 'Nothing changed in this answer.');
    need(input.previewHash === plan.hash, 'This branch changed since the preview. Preview the restart again.', 409);
    need(input.answerState === undefined || answerStates.includes(input.answerState), 'Choose Tentative, Decided or Assumption.');
    // The checkpoint comes first: if it cannot be saved, nothing changes.
    let checkpoint;
    try { checkpoint = await store.withMapLock(map.id, async () => store.versions.record(map, { labels: ['before-restart'], name: await checkpointName(store, map, node), checkpoint: true })); }
    catch (error) { throw new RestartProblem(`The checkpoint could not be saved, so nothing was restarted: ${error.message}`, 500); }
    const at = new Date().toISOString();
    for (const other of plan.flagged) store.flagForReview(other, { sourceId: node.id, kind: 'branch-restarted' });
    map.nodes = map.nodes.filter(other => !plan.below.has(other.id));
    map.edges = map.edges.filter(edge => !plan.below.has(edge.from) && !plan.below.has(edge.to));
    map.jobs = map.jobs.filter(job => !plan.below.has(job.nodeId));
    for (const id of plan.below) delete map.view?.positions?.[id];
    replaceAnswer(plan.question, { answer, answerState: input.answerState, actor, at, mark: { restart: true } });
    for (const later of plan.superseded) later.supersededAt = at;
    // The idea keeps its premise and answers; its findings start again, and its earlier runs become history.
    store.resetFindings(node, node.prompt || node.body);
    node.status = 'interrupted'; node.contentRevision++;
    for (const job of map.jobs) if (job.nodeId === node.id && !job.restartedAt) job.restartedAt = at;
    store.event(map, 'branch-restarted', node.id, `Deleted ${plan.below.size} idea${plan.below.size === 1 ? '' : 's'} below it; checkpoint ${checkpoint}.`);
    // Confirming the restart is the user's go-ahead (decision 6b).
    if (node.questions.some(isBlocking)) node.status = 'awaiting-answer';
    else store.enqueue(map, node, 'The user restarted this branch from a changed answer. Explore it again from the new answer.');
  } },
};
