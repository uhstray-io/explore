import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { checkResult } from '../skills/explore/scripts/result-checks.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';

// Result checks (K3, #51). Illustrative fixtures under .test-output, never ideas/.
const exec = promisify(execFile);
const codes = list => list.map(finding => `${finding.code} ${finding.field}`);
const node = (id, title, extra = {}) => ({ id, title, parentId: null, questions: [], ...extra });
const map = { nodes: [
  node('node-root', 'Field notebook', { questions: [
    { id: 'q-1', text: 'Who edits the notes?', answer: 'Only me.' },
    { id: 'q-2', text: 'How long are trips?', answer: 'A week.', supersededAt: '2026-11-01T00:00:00Z' },
    { id: 'q-3', text: 'Which phones?', answer: null },
  ] }),
  node('node-sync', 'Sync over mesh radio', { parentId: 'node-root' }),
  node('node-other', 'Battery life', { parentId: 'node-sync' }),
] };
const root = map.nodes[0];
const result = extra => ({ summary: 's', body: 'b', questions: [], suggestions: [], sources: [], links: [], ...extra });
const q = text => ({ text });

test('re-asking an answered question or repeating one within a result is an error', () => {
  assert.deepEqual(codes(checkResult(result({ questions: [q('who edits the notes')] }), map, root).errors), ['answered-question questions[0]']);
  assert.deepEqual(codes(checkResult(result({ questions: [q('Which phones?'), q('which  phones')] }), map, root).errors), ['duplicate-question questions[1]']);
  assert.deepEqual(codes(checkResult(result({ suggestions: [{ title: 'Offline maps' }, { title: 'Offline maps.' }] }), map, root).errors), ['duplicate-suggestion suggestions[1]']);
  const { message } = checkResult(result({ questions: [q(`Who edits the notes?${' '.repeat(3)}`)] }), map, root).errors[0];
  assert.match(message, /already answered/); assert.match(message, /Who edits the notes\?/);
  assert.ok(checkResult(result({ questions: [q('x'.repeat(400))] }), { nodes: [node('n', 't', { questions: [{ text: 'x'.repeat(400), answer: 'y' }] })] }, map.nodes[0]).errors[0].message.length < 250, 'messages quote at most 120 characters');
});

test('re-asking a superseded question, a compound question, an existing branch and a weak note are warnings', () => {
  const warnings = checkResult(result({
    questions: [q('How long are trips?'), q('Which database, and how should we deploy it?'), q('For the first workshop, which matters more: reaching many neighbors or keeping preparation under one evening? A third priority is welcome.')],
    suggestions: [{ title: 'Battery life' }, { title: 'sync over mesh radio' }],
    sources: [{ title: 'Mesh radio guide', url: 'https://example.org/mesh', note: 'Mesh radio guide' }, { title: 'Field report', url: 'https://example.org/report', note: 'Too short.' }, { title: 'Study', url: 'https://example.org/s', note: 'Teams lost a day of edits when two devices synced late.' }],
  }), map, root).warnings;
  assert.deepEqual(codes(warnings), ['superseded-question questions[0]', 'compound-question questions[1]', 'existing-branch suggestions[0]', 'existing-branch suggestions[1]', 'weak-source-note sources[0]', 'weak-source-note sources[1]']);
  assert.match(warnings[1].message, /may ask two things/);
  assert.match(warnings[3].message, /skipped/, 'a match under the same parent is reported as skipped');
  assert.deepEqual(codes(checkResult(result({ questions: [q('What sizes, what colours?')] }), map, root).warnings), [], 'one question mark and no joined clauses');
  assert.deepEqual(codes(checkResult(result({ questions: [q('Is it rugged? Is it cheap?')] }), map, root).warnings), ['compound-question questions[0]']);
});

async function running(questions = ['Who edits the notes?']) {
  const dir = path.resolve('.test-output'); await mkdir(dir, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(dir, 'checks-')), 'ideas'));
  const created = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  let job = await store.claim('agent');
  let saved = await store.complete(created.id, job.jobId, job.claimKey, { summary: 'First pass.', body: 'Sync matters.', questions });
  saved = await store.action(created.id, { expectedRevision: saved.revision, nodeId: created.rootId, type: 'answer', questionId: saved.nodes[0].questions[0].id, answer: 'Only me.' });
  job = await store.claim('agent');
  return { store, mapId: created.id, rootId: created.rootId, job };
}

test('a rejected result changes nothing and the same claim can deliver a corrected one', async () => {
  const { store, mapId, job } = await running();
  const before = await store.get(mapId);
  await assert.rejects(store.complete(mapId, job.jobId, job.claimKey, { summary: 'Again.', body: 'b', questions: ['Who edits the notes?'] }),
    error => error.status === 400 && error.code === 'result-checks' && error.errors[0].code === 'answered-question');
  const after = await store.get(mapId);
  assert.equal(after.revision, before.revision); assert.equal(after.jobs.find(j => j.id === job.jobId).status, 'running');
  const saved = await store.complete(mapId, job.jobId, job.claimKey, { summary: 'Done.', body: 'b', suggestions: [{ title: 'Field notebook', body: 'Same title as the root.' }],
    sources: [{ title: 'Guide', url: 'https://example.org/guide', note: 'Guide' }] });
  const done = saved.jobs.find(j => j.id === job.jobId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.resultWarnings, [{ code: 'existing-branch', field: 'suggestions[0]' }, { code: 'weak-source-note', field: 'sources[0]' }], 'codes only, no text');
});

test('a suggestion matching an existing child is skipped and reported, never duplicated', async () => {
  const { store, mapId, rootId, job } = await running();
  let saved = await store.action(mapId, { expectedRevision: (await store.get(mapId)).revision, nodeId: rootId, type: 'suggest', title: 'Offline maps', body: 'x' });
  const { warnings, map } = await store.deliver(mapId, job.jobId, job.claimKey, { summary: 'Done.', body: 'b', suggestions: [{ title: 'offline maps.', body: 'Again.' }] });
  saved = map;
  assert.equal(saved.nodes.filter(n => n.title.toLowerCase().startsWith('offline maps')).length, 1);
  assert.deepEqual(codes(warnings), ['existing-branch suggestions[0]']);
});

test('checking a result reports errors and warnings without saving or touching the job', async () => {
  const { store, mapId, job } = await running();
  const before = await store.get(mapId);
  assert.deepEqual(codes((await store.checkResult(mapId, job.jobId, job.claimKey, { summary: 'x', body: 'b', questions: ['Who edits the notes?'] })).errors), ['answered-question questions[0]']);
  const invalid = await store.checkResult(mapId, job.jobId, job.claimKey, { body: 'No summary.' });
  assert.equal(invalid.ok, false); assert.equal(invalid.errors[0].code, 'invalid-result');
  const fine = await store.checkResult(mapId, job.jobId, job.claimKey, { summary: 'x', body: 'b' });
  assert.deepEqual(fine, { ok: true, errors: [], warnings: [] });
  const after = await store.get(mapId);
  assert.equal(after.revision, before.revision); assert.deepEqual(after.jobs.find(j => j.id === job.jobId), before.jobs.find(j => j.id === job.jobId));
  await assert.rejects(store.checkResult(mapId, job.jobId, 'wrong-key', { summary: 'x', body: 'b' }), error => error.status === 409);
});

test('the CLI checks with --check, prints warnings on delivery and exits non-zero on rejection', async () => {
  const dir = path.resolve('.test-output'); await mkdir(dir, { recursive: true });
  const workspace = await mkdtemp(path.join(dir, 'checks-cli-'));
  const app = await startServer({ workspace, port: 0 });
  const run = args => exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', workspace]);
  const cli = async args => JSON.parse((await run(args)).stdout);
  try {
    const idea = path.join(workspace, 'idea.json'); await writeFile(idea, JSON.stringify({ title: 'Field notebook', idea: 'Notes that work offline.' }));
    const created = await cli(['create', '--file', idea]);
    let job = await cli(['next', '--worker', 'test']);
    const file = path.join(workspace, 'result.json');
    await writeFile(file, JSON.stringify({ summary: 'First.', body: 'b', questions: ['Who edits the notes?'] }));
    await cli(['result', '--job', job.jobId, '--file', file]);
    const map = await app.store.get(created.mapId);
    await app.store.action(created.mapId, { expectedRevision: map.revision, nodeId: created.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'Only me.' });
    job = await cli(['next', '--worker', 'test']);
    await writeFile(file, JSON.stringify({ summary: 'Again.', body: 'b', questions: ['Who edits the notes?'] }));
    const checked = await cli(['result', '--job', job.jobId, '--file', file, '--check']);
    assert.equal(checked.ok, false); assert.equal(checked.errors[0].code, 'answered-question');
    const rejected = await run(['result', '--job', job.jobId, '--file', file]).then(() => null, error => error);
    assert.ok(rejected, 'exits non-zero'); assert.match(rejected.stderr, /answered-question/); assert.match(rejected.stderr, /questions\[0\]/);
    await writeFile(file, JSON.stringify({ summary: 'Done.', body: 'b', sources: [{ title: 'Guide', url: 'https://example.org/guide', note: 'Guide' }] }));
    const saved = await cli(['result', '--job', job.jobId, '--file', file]);
    assert.equal(saved.saved, true); assert.deepEqual(codes(saved.warnings), ['weak-source-note sources[0]']);
  } finally { await app.close(); }
});
