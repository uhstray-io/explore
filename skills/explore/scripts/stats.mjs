import { isOpen, isWaiting, hasCurrentAnswer, effectiveAnswerState, answeredSince } from '../assets/questions.js';

// Usage across saved maps (J1): structure, questions and answers, agent jobs and weekly activity, computed only from
// what the maps already hold. It reads and never writes, queues work or calls a model. Every count comes with what
// it is out of; a map that cannot be read is listed as left out, never counted as empty. The reply stays bounded.
const maxRows = 100, maxExcluded = 20, maxWeeks = 26, maxWorkers = 10, maxFailures = 5;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const tally = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
// The Monday (UTC) that starts the week of `at`, as YYYY-MM-DD.
const weekOf = at => { const day = new Date(at); day.setUTCHours(0, 0, 0, 0); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); };

// Each idea's depth below the root by parent (root = 0), and how many children each idea has.
function shape(map) {
  const byId = new Map(map.nodes.map(node => [node.id, node])), depth = new Map(), children = new Map();
  const depthOf = node => {
    if (depth.has(node.id)) return depth.get(node.id);
    depth.set(node.id, 0); // A guard against a parent loop in a damaged map.
    const parent = byId.get(node.parentId), value = parent ? depthOf(parent) + 1 : 0;
    depth.set(node.id, value); return value;
  };
  for (const node of map.nodes) { depthOf(node); if (byId.has(node.parentId)) children.set(node.parentId, (children.get(node.parentId) || 0) + 1); }
  return { depths: [...depth.values()], children: [...children.values()] };
}

// `entries` as Store.eachMap gives them: { id, map } or { id, error|problem }. `archived`: 'exclude' or 'include'.
export function usageStats(entries, { archived = 'exclude' } = {}) {
  const excluded = [], maps = [];
  let archivedLeftOut = 0;
  for (const entry of entries) {
    if (!entry.map) { excluded.push({ id: entry.id, problem: entry.problem ?? entry.error?.code ?? 'unreadable' }); continue; }
    if (archived !== 'include' && entry.map.library?.archived) { archivedLeftOut++; continue; }
    maps.push(entry.map);
  }
  const nodesPerMap = [], depths = [], branching = [], kinds = {}, work = {}, review = { accepted: 0, unreviewed: 0, needsReview: 0, cleared: 0 };
  const questions = { total: 0, answered: 0, waiting: 0, later: 0, superseded: 0, dismissed: 0 };
  const answerStates = { answered: 0, decided: 0, tentative: 0, assumption: 0, tentativeNotRecorded: 0 };
  const feedback = { questions: 0, good: 0, bad: 0, dismissed: 0, regenerated: 0 };
  const byStatus = {}, completed = { askedQuestions: 0, finishedBranch: 0, stale: 0 }, failures = [], packets = [], runs = [], workers = {};
  let unknownRuns = 0, unknownAnswers = 0, unknownCompleted = 0;
  const weeks = new Map(), week = at => { const key = weekOf(at); if (!weeks.has(key)) weeks.set(key, { week: key, answers: 0, completed: 0 }); return weeks.get(key); };
  const rows = [];
  for (const map of maps) {
    const { depths: mapDepths, children } = shape(map);
    nodesPerMap.push(map.nodes.length); depths.push(...mapDepths); branching.push(...children);
    let mapQuestions = 0, mapAnswered = 0, mapCompleted = 0, mapFailed = 0;
    for (const node of map.nodes) {
      tally(kinds, node.kind); tally(work, node.status);
      review[node.stale ? 'needsReview' : node.reviewState === 'accepted' ? 'accepted' : node.reviewState === 'cleared' ? 'cleared' : 'unreviewed']++;
      for (const question of node.questions || []) {
        questions.total++; feedback.questions++; mapQuestions++;
        if (question.supersededAt) questions.superseded++;
        else if (question.dismissedAt) questions.dismissed++;
        else if (hasCurrentAnswer(question)) questions.answered++;
        else if (isWaiting(question)) questions.waiting++;
        else if (isOpen(question)) questions.later++;
        if (question.rating === 'good') feedback.good++;
        if (question.rating === 'bad') feedback.bad++;
        if (question.dismissedAt) feedback.dismissed++;
        if (question.replacedBy) feedback.regenerated++;
        if (!hasCurrentAnswer(question)) continue;
        mapAnswered++; answerStates.answered++;
        const certainty = effectiveAnswerState(question);
        if (!certainty.recorded) answerStates.tentativeNotRecorded++; else answerStates[certainty.state]++;
        const at = time(answeredSince(question));
        if (at === null) unknownAnswers++; else week(at).answers++;
      }
    }
    for (const job of map.jobs || []) {
      tally(byStatus, job.status);
      if (job.worker) tally(workers, String(job.worker).slice(0, 100));
      if (Number.isFinite(job.contextCharacters)) packets.push(job.contextCharacters);
      if (job.status === 'failed') { mapFailed++; failures.push({ mapId: map.id, mapTitle: map.title, at: job.finishedAt ?? null, reason: String(job.error ?? 'No reason recorded.').slice(0, 300) }); }
      if (job.status !== 'completed') continue;
      mapCompleted++;
      completed[job.stale ? 'stale' : job.result?.questions?.length ? 'askedQuestions' : 'finishedBranch']++;
      const started = time(job.startedAt), finished = time(job.finishedAt);
      if (started !== null && finished !== null && finished >= started) runs.push((finished - started) / 1000); else unknownRuns++;
      if (finished === null) unknownCompleted++; else week(finished).completed++;
    }
    rows.push({ id: map.id, title: map.title, nodes: map.nodes.length, depth: Math.max(0, ...mapDepths), questions: mapQuestions, answered: mapAnswered, completed: mapCompleted, failed: mapFailed });
  }
  const recent = failures.sort((a, b) => (time(b.at) ?? -Infinity) - (time(a.at) ?? -Infinity)).slice(0, maxFailures);
  return {
    maps: { counted: maps.length, archivedLeftOut, excluded: excluded.slice(0, maxExcluded), excludedMore: Math.max(0, excluded.length - maxExcluded) },
    structure: { nodes: nodesPerMap.reduce((sum, value) => sum + value, 0), nodesPerMap: { mean: mean(nodesPerMap), median: median(nodesPerMap), max: nodesPerMap.length ? Math.max(...nodesPerMap) : null },
      depth: { max: depths.length ? Math.max(...depths) : null, mean: mean(depths) }, branching: { parents: branching.length, mean: mean(branching), max: branching.length ? Math.max(...branching) : null },
      kinds, work, review },
    questions, answerStates, feedback,
    jobs: { total: Object.values(byStatus).reduce((sum, value) => sum + value, 0), byStatus, completed, failures: { count: failures.length, recent },
      packet: { measured: packets.length, median: median(packets), max: packets.length ? Math.max(...packets) : null },
      runTime: { known: runs.length, unknown: unknownRuns, medianSeconds: median(runs) },
      workers: Object.entries(workers).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, maxWorkers) },
    activity: { weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-maxWeeks), unknownAnswers, unknownCompleted },
    perMap: { rows: rows.slice(0, maxRows), more: Math.max(0, rows.length - maxRows) },
  };
}
