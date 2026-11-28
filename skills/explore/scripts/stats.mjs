import { isOpen, isWaiting, hasCurrentAnswer, effectiveAnswerState, answeredSince } from '../assets/questions.js';
import { reviewWord, treeOrder, workLabels } from '../assets/graph.js';
import { nodeKinds } from './map-validation.mjs';
import { isInvestigation } from './job-types.mjs';

// Usage across saved maps (J1): structure, questions and answers, agent jobs and weekly activity, computed only from
// what the maps already hold. It reads and never writes, queues work or calls a model. Every count comes with what
// it is out of; a map that cannot be read, or holds data it cannot count, is listed as left out, never counted as
// empty. Totals are running sums, and every list is cut with a count of what it leaves out, so the reply stays bounded.
const maxRows = 100, maxExcluded = 20, maxWeeks = 26, maxWorkers = 10, maxFailures = 5;
const jobStatuses = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);

// Counts by key with no inherited names, so agent-written text such as "constructor" is just a key. Values outside
// `known` (when given) count as "other", so the keys stay few.
const counter = known => {
  const counts = Object.create(null);
  return { add(key) { const name = known && !known.has(key) ? 'other' : String(key); counts[name] = (counts[name] || 0) + 1; }, counts };
};
const plainCounts = ({ counts }) => ({ ...counts });
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
// A running total that keeps what a summary needs: how many, their sum, the largest.
const tally = () => ({ count: 0, sum: 0, max: null, add(value) { this.count++; this.sum += value; this.max = this.max === null ? value : Math.max(this.max, value); } });
const meanOf = total => (total.count ? total.sum / total.count : null);
// A saved time as milliseconds: an ISO string or a number of milliseconds a date can hold; anything else is unknown.
const time = value => { const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? at : null; };
const isoTime = value => { const at = time(value); return at === null ? null : new Date(at).toISOString(); };
// The Monday (UTC) that starts the week of `at`, as YYYY-MM-DD.
const weekOf = at => { const day = new Date(at); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); };

// The rules, one per bucket.
const reviewBucket = node => ({ 'needs review': 'needsReview', accepted: 'accepted', 'no longer relevant': 'cleared' }[reviewWord(node)] ?? 'unreviewed');
const questionBucket = question => question.supersededAt ? 'superseded' : question.dismissedAt ? 'dismissed' : hasCurrentAnswer(question) ? 'answered' : isWaiting(question) ? 'waiting' : isOpen(question) ? 'later' : 'other';
const jobOutcome = job => !isInvestigation(job) ? 'helpers' : job.stale ? 'stale' : job.result?.questions?.length ? 'askedQuestions' : 'finishedBranch';

// Whether every idea, question and job is a record; a map that is not is left out whole, before anything counts.
const isRecord = value => !!value && typeof value === 'object';
function countable(map) {
  return Array.isArray(map.nodes) && map.nodes.every(node => isRecord(node) && (node.questions ?? []).every(isRecord)) && (map.jobs ?? []).every(isRecord);
}
// One map's contribution. Only called for a countable map, and nothing below can throw.
function countMap(map, totals) {
  const ids = new Set(map.nodes.map(node => node.id)), depths = tally(), children = new Map();
  for (const { node, depth } of treeOrder(map)) { depths.add(depth); if (ids.has(node.parentId)) children.set(node.parentId, (children.get(node.parentId) || 0) + 1); }
  const row = { id: map.id, title: map.title, nodes: map.nodes.length, depth: depths.max ?? 0, meanDepth: meanOf(depths), questions: 0, answered: 0, completed: 0, failed: 0 };
  const questions = map.nodes.flatMap(node => node.questions ?? []), jobs = map.jobs ?? [];
  totals.maps.push({ map, row });
  totals.nodesPerMap.push(map.nodes.length); totals.depthMax.add(depths.max ?? 0); if (depths.count) totals.depthMean.add(meanOf(depths));
  for (const count of children.values()) totals.branching.add(count);
  for (const node of map.nodes) { totals.kinds.add(node.kind); totals.work.add(node.status); totals.review[reviewBucket(node)]++; }
  for (const question of questions) {
    row.questions++; totals.questions.total++; const bucket = questionBucket(question);
    if (bucket !== 'other') totals.questions[bucket]++;
    if (question.rating === 'good') totals.feedback.good++;
    if (question.rating === 'bad') totals.feedback.bad++;
    if (question.dismissedAt) totals.feedback.dismissed++;
    if (question.replacedBy && question.replacedBy !== 'pending') totals.feedback.regenerated++;
    if (bucket !== 'answered') continue;
    row.answered++; totals.answerStates.answered++;
    const certainty = effectiveAnswerState(question);
    if (!certainty.recorded) totals.answerStates.tentativeNotRecorded++; else totals.answerStates[certainty.state]++;
    const at = time(answeredSince(question));
    if (at === null) totals.unknownAnswers++; else totals.week(at).answers++;
  }
  for (const job of jobs) {
    totals.byStatus.add(job.status);
    if (typeof job.worker === 'string' && job.worker) totals.workers.add(job.worker.slice(0, 100)); else totals.unnamed++;
    if (Number.isFinite(job.contextCharacters)) totals.packets.push(job.contextCharacters);
    if (job.status === 'failed') { row.failed++; totals.failures.push({ mapId: map.id, mapTitle: map.title, at: isoTime(job.finishedAt), reason: String(job.error ?? 'No reason recorded.').slice(0, 300) }); }
    if (job.status !== 'completed') continue;
    row.completed++; const outcome = jobOutcome(job);
    totals.completed[outcome]++; if (outcome !== 'helpers') totals.completed.investigations++;
    const started = time(job.startedAt), finished = time(job.finishedAt);
    if (started !== null && finished !== null && finished >= started) totals.runs.push((finished - started) / 1000); else totals.unknownRuns++;
    if (finished === null) totals.unknownCompleted++; else totals.week(finished).completed++;
  }
}

// `entries` as Store.eachMap gives them: { id, map } or { id, error|problem }. `archived`: 'exclude' or 'include'.
export function usageStats(entries, { archived = 'exclude' } = {}) {
  const weeks = new Map();
  const totals = { maps: [], nodesPerMap: [], depthMax: tally(), depthMean: tally(), branching: tally(),
    kinds: counter(nodeKinds), work: counter(new Set(Object.keys(workLabels))), review: { accepted: 0, unreviewed: 0, needsReview: 0, cleared: 0 },
    questions: { total: 0, answered: 0, waiting: 0, later: 0, superseded: 0, dismissed: 0 },
    answerStates: { answered: 0, decided: 0, tentative: 0, assumption: 0, tentativeNotRecorded: 0 }, feedback: { good: 0, bad: 0, dismissed: 0, regenerated: 0 },
    byStatus: counter(jobStatuses), completed: { investigations: 0, askedQuestions: 0, finishedBranch: 0, stale: 0, helpers: 0 },
    failures: [], packets: [], runs: [], workers: counter(null), unnamed: 0, unknownRuns: 0, unknownAnswers: 0, unknownCompleted: 0,
    week: at => { const key = weekOf(at); if (!weeks.has(key)) weeks.set(key, { week: key, answers: 0, completed: 0 }); return weeks.get(key); } };
  const excluded = [];
  let archivedLeftOut = 0;
  for (const entry of entries) {
    if (!entry.map) { excluded.push({ id: entry.id, problem: entry.problem ?? entry.error?.code ?? 'unreadable' }); continue; }
    if (archived !== 'include' && entry.map.library?.archived) { archivedLeftOut++; continue; }
    if (countable(entry.map)) countMap(entry.map, totals); else excluded.push({ id: entry.id, problem: 'unexpected-shape' });
  }
  const changedAt = map => map.history?.at(-1)?.at ?? map.updatedAt ?? '';
  const rows = totals.maps.sort((a, b) => Number(!!b.map.library?.pinned) - Number(!!a.map.library?.pinned) || String(changedAt(b.map)).localeCompare(String(changedAt(a.map)))).map(({ row }) => row);
  const workers = Object.entries(totals.workers.counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const allWeeks = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week));
  const recent = totals.failures.sort((a, b) => (time(b.at) ?? -Infinity) - (time(a.at) ?? -Infinity)).slice(0, maxFailures);
  const nodesTally = tally(), packets = tally();
  for (const value of totals.nodesPerMap) nodesTally.add(value);
  for (const value of totals.packets) packets.add(value);
  return {
    maps: { counted: rows.length, archivedLeftOut, excluded: excluded.slice(0, maxExcluded), excludedMore: Math.max(0, excluded.length - maxExcluded) },
    structure: { nodes: nodesTally.sum, nodesPerMap: { mean: meanOf(nodesTally), median: median(totals.nodesPerMap), max: nodesTally.max },
      depth: { max: totals.depthMax.max, mean: meanOf(totals.depthMean) }, branching: { parents: totals.branching.count, mean: meanOf(totals.branching), max: totals.branching.max },
      kinds: plainCounts(totals.kinds), work: plainCounts(totals.work), review: totals.review },
    questions: totals.questions, answerStates: totals.answerStates, feedback: totals.feedback,
    jobs: { total: Object.values(totals.byStatus.counts).reduce((sum, value) => sum + value, 0), byStatus: plainCounts(totals.byStatus), completed: totals.completed,
      failures: { count: totals.failures.length, recent },
      packet: { measured: packets.count, median: median(totals.packets), max: packets.max },
      runTime: { known: totals.runs.length, unknown: totals.unknownRuns, medianSeconds: median(totals.runs) },
      workers: { top: workers.slice(0, maxWorkers), more: Math.max(0, workers.length - maxWorkers), unnamed: totals.unnamed } },
    activity: { weeks: allWeeks.slice(-maxWeeks), earlierWeeks: Math.max(0, allWeeks.length - maxWeeks), unknownAnswers: totals.unknownAnswers, unknownCompleted: totals.unknownCompleted },
    perMap: { rows: rows.slice(0, maxRows), more: Math.max(0, rows.length - maxRows) },
  };
}
