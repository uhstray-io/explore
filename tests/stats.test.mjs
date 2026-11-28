import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { usageStats } from '../skills/explore/scripts/stats.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { usageHtml } from '../skills/explore/assets/usage-dialog.js';

// Usage dashboard (J1, #43). Illustrative maps only, never ideas/.
const node = (id, parentId, extra = {}) => ({ id, parentId, title: `Idea ${id}`, kind: 'research', status: 'suggested', reviewState: 'unreviewed', stale: false, questions: [], sources: [], ...extra });
// root → a, b; a → a1, a2, a3; a1 → a11. Depths 0,1,1,2,2,2,3; three ideas have children (2, 3 and 1).
function shaped(extra = {}) {
  const nodes = [node('root', null, { kind: 'idea', status: 'explored', reviewState: 'accepted' }), node('a', 'root', { kind: 'question', status: 'explored', stale: true }), node('b', 'root', { status: 'awaiting-answer' }),
    node('a1', 'a', { kind: 'decision' }), node('a2', 'a'), node('a3', 'a', { status: 'queued' }), node('a11', 'a1', { kind: 'risk', reviewState: 'cleared', status: 'explored' })];
  return { id: 'map-0000000a', title: 'Field notebook', rootId: 'root', revision: 3, nodes, edges: [], jobs: [], history: [], ...extra };
}
const q = (id, extra = {}) => ({ id, text: `Question ${id}?`, answer: null, ...extra });
const job = (id, status, extra = {}) => ({ id, nodeId: 'root', type: 'investigate', status, ...extra });

test('structure: depth, branching and counts match the known shape', () => {
  const stats = usageStats([{ id: 'map-0000000a', map: shaped() }]);
  assert.equal(stats.maps.counted, 1);
  assert.deepEqual(stats.structure.nodesPerMap, { mean: 7, median: 7, max: 7 });
  assert.deepEqual(stats.structure.depth, { max: 3, mean: 11 / 7 });
  assert.deepEqual(stats.structure.branching, { parents: 3, mean: 2, max: 3 });
  assert.deepEqual(stats.structure.kinds, { idea: 1, question: 1, research: 3, decision: 1, risk: 1 });
  assert.deepEqual(stats.structure.work, { explored: 3, 'awaiting-answer': 1, suggested: 2, queued: 1 });
  assert.deepEqual(stats.structure.review, { accepted: 1, unreviewed: 4, needsReview: 1, cleared: 1 });
  assert.deepEqual(stats.perMap.rows[0], { id: 'map-0000000a', title: 'Field notebook', nodes: 7, depth: 3, questions: 0, answered: 0, completed: 0, failed: 0 });
});

test('questions and answer states: unrecorded answers are their own bucket, never Decided', () => {
  const map = shaped();
  map.nodes[0].questions = [q('q1', { answer: 'Yes.', answerState: 'decided', answeredAt: '2026-11-02T10:00:00.000Z' }), q('q2', { answer: 'Maybe.', answerState: 'tentative' }), q('q3', { answer: 'Old answer.' }),
    q('q4', { answer: 'Assume so.', answerState: 'assumption' }), q('q5'), q('q6', { deferredAt: 'x' }), q('q7', { supersededAt: 'x', answer: 'Earlier.' }),
    q('q8', { dismissedAt: 'x', rating: 'bad', replacedBy: 'node-x' }), q('q9', { rating: 'good' })];
  const stats = usageStats([{ id: map.id, map }]);
  assert.deepEqual(stats.questions, { total: 9, answered: 4, waiting: 2, later: 1, superseded: 1, dismissed: 1 });
  assert.deepEqual(stats.answerStates, { answered: 4, decided: 1, tentative: 1, assumption: 1, tentativeNotRecorded: 1 });
  assert.deepEqual(stats.feedback, { questions: 9, good: 1, bad: 1, dismissed: 1, regenerated: 1 });
});

test('jobs: every outcome is told apart, run time is unknown without both times, and failures are kept to five', () => {
  const map = shaped();
  map.jobs = [
    job('j1', 'completed', { result: { questions: ['Who?'] }, startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:01:00.000Z', contextCharacters: 1000, worker: 'codex' }),
    job('j2', 'completed', { result: { summary: 'Done.' }, startedAt: '2026-11-02T10:00:00.000Z', finishedAt: '2026-11-02T10:03:00.000Z', contextCharacters: 3000, worker: 'codex' }),
    job('j3', 'completed', { result: { summary: 'Old.' }, stale: true, finishedAt: '2026-11-09T10:00:00.000Z', worker: 'claude' }),
    ...Array.from({ length: 6 }, (_, i) => job(`f${i}`, 'failed', { error: `Reason ${i}`, finishedAt: `2026-11-1${i}T10:00:00.000Z` })),
    job('j4', 'cancelled'), job('j5', 'interrupted'), job('j6', 'queued'), job('j7', 'running', { worker: 'claude', contextCharacters: 2000 }), job('j8', 'completed', { result: {} })];
  const stats = usageStats([{ id: map.id, map }]);
  assert.deepEqual(stats.jobs.byStatus, { completed: 4, failed: 6, cancelled: 1, interrupted: 1, queued: 1, running: 1 });
  assert.deepEqual(stats.jobs.completed, { askedQuestions: 1, finishedBranch: 2, stale: 1 });
  assert.equal(stats.jobs.failures.count, 6); assert.deepEqual(stats.jobs.failures.recent.map(f => f.reason), ['Reason 5', 'Reason 4', 'Reason 3', 'Reason 2', 'Reason 1']);
  assert.deepEqual(stats.jobs.packet, { measured: 3, median: 2000, max: 3000 });
  assert.deepEqual(stats.jobs.runTime, { known: 2, unknown: 2, medianSeconds: 120 }, 'j3 and j8 finished without a start time');
  assert.deepEqual(stats.jobs.workers, [{ name: 'claude', count: 2 }, { name: 'codex', count: 2 }]);
});

test('activity counts answers and finished jobs by week; missing times are unknown, never a date', () => {
  const map = shaped();
  map.nodes[0].questions = [q('q1', { answer: 'Yes.', answeredAt: '2026-11-03T10:00:00.000Z' }), q('q2', { answer: 'No.', answeredAt: '2026-11-04T10:00:00.000Z' }), q('q3', { answer: 'Old.' })];
  map.jobs = [job('j1', 'completed', { finishedAt: '2026-11-10T10:00:00.000Z', result: {} }), job('j2', 'completed', { result: {} })];
  const stats = usageStats([{ id: map.id, map }]);
  assert.deepEqual(stats.activity.weeks, [{ week: '2026-11-02', answers: 2, completed: 0 }, { week: '2026-11-09', answers: 0, completed: 1 }]);
  assert.deepEqual([stats.activity.unknownAnswers, stats.activity.unknownCompleted], [1, 1]);
});

test('unreadable maps are listed as left out; archived maps are left out unless asked for; the reply stays bounded', () => {
  const archived = { ...shaped(), id: 'map-0000000b', library: { pinned: false, archived: true } };
  const entries = [{ id: 'map-0000000a', map: shaped() }, { id: 'map-0000000b', map: archived }, { id: 'map-0000000c', problem: 'invalid-json' }];
  let stats = usageStats(entries);
  assert.equal(stats.maps.counted, 1); assert.equal(stats.maps.archivedLeftOut, 1); assert.deepEqual(stats.maps.excluded, [{ id: 'map-0000000c', problem: 'invalid-json' }]);
  stats = usageStats(entries, { archived: 'include' });
  assert.equal(stats.maps.counted, 2); assert.equal(stats.maps.archivedLeftOut, 0);
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `map-${String(i).padStart(8, '0')}`, map: { ...shaped(), id: `map-${String(i).padStart(8, '0')}` } }));
  stats = usageStats(many);
  assert.equal(stats.maps.counted, 250); assert.equal(stats.perMap.rows.length, 100); assert.equal(stats.perMap.more, 150);
  assert.ok(JSON.stringify(stats).length < 64 * 1024);
});

test('the server reads every map without writing, survives a broken one, and needs the token', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'stats-'));
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const map = await app.store.demo();
    await mkdir(path.join(dir, 'ideas', 'map-0000000f')); await writeFile(path.join(dir, 'ideas', 'map-0000000f', 'map.json'), '{ not json');
    const before = await readFile(app.store.file(map.id));
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    assert.equal((await fetch(`${app.address}/api/stats`)).status, 401);
    const stats = await (await fetch(`${app.address}/api/stats`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(stats.maps.counted, 1); assert.deepEqual(stats.maps.excluded.map(entry => entry.id), ['map-0000000f']);
    assert.deepEqual(await readFile(app.store.file(map.id)), before, 'no file changes');
  } finally { await app.close(); }
});

test('the dialog shows denominators and keeps failure reasons behind a disclosure', () => {
  const map = shaped(); map.jobs = [job('f1', 'failed', { error: 'Private <detail>', finishedAt: '2026-11-10T10:00:00.000Z' })];
  map.nodes[0].questions = [q('q1', { answer: 'Yes.', answerState: 'decided' }), q('q2')];
  const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const html = usageHtml(usageStats([{ id: map.id, map }]), { esc });
  assert.match(html, /1 of 2 questions/); assert.match(html, /<details[^>]*>\s*<summary>[^<]*recent failure/);
  assert.match(html, /Private &lt;detail&gt;/); assert.ok(html.indexOf('Private') > html.indexOf('<details'), 'the reason is inside the disclosure');
  assert.match(html, /data-usage-map="map-0000000a"/);
});
