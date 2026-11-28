import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { researchModelSetting, modelHintNote } from '../skills/explore/assets/research-model.js';
import { runNoteHtml } from '../skills/explore/assets/workspace-view.js';

// Separate research model (Z5, #63). Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'model-'));
  const store = new Store(path.join(dir, 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  return { dir, store, map };
}
const hint = model => ({ model, note: modelHintNote });

test('the hint is plain text: trimmed, at most 100 characters, one line, and empty means none', () => {
  assert.equal(researchModelSetting.default, '');
  assert.equal(researchModelSetting.validate('  a fast model  '), 'a fast model');
  assert.equal(researchModelSetting.validate('   '), '');
  assert.equal(researchModelSetting.validate('m'.repeat(100)), 'm'.repeat(100));
  for (const value of ['m'.repeat(101), 'two\nlines', 'tab\rreturn', 42, null]) assert.throws(() => researchModelSetting.validate(value), error => error.status === 400 && /100 characters|one line|text/.test(error.message), String(value));
});

test('a saved hint reaches branch research packets only, and clearing it removes the field', async () => {
  const { dir, store, map } = await workspace();
  let packet = await store.claim('agent', map.id);
  assert.equal(Object.hasOwn(packet, 'modelHint'), false, 'no hint: the same fields as before');
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Depends.', body: 'Findings.', questions: ['Which phones?'] });
  const settings = await store.updateSettings({ expectedRevision: 0, researchModelHint: 'a faster model' });
  assert.equal(settings.researchModelHint, 'a faster model');
  // Help me answer is another job type: it does not opt in.
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'request-research', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id });
  const typed = await store.claim('agent', map.id);
  assert.equal(typed.jobType, 'question-research'); assert.equal(Object.hasOwn(typed, 'modelHint'), false);
  saved = await store.get(map.id);
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'Android.' });
  packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'investigate'); assert.deepEqual(packet.modelHint, hint('a faster model'));
  assert.ok(packet.contextCharacters <= 15500 && JSON.stringify(packet).length <= 15500, 'counted within the budget');
  // The preference stays in settings.json: never in the map, its Markdown or a brief.
  const folder = path.dirname(store.file(map.id));
  for (const file of ['map.json', 'README.md', ...(await readdir(path.join(folder, 'nodes'))).map(name => path.join('nodes', name))]) {
    assert.doesNotMatch(await readFile(path.join(folder, file), 'utf8'), /faster model/, file);
  }
  assert.doesNotMatch(JSON.stringify(mapBrief(await store.get(map.id))), /faster model/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'ideas', 'settings.json'), 'utf8')).researchModelHint, 'a faster model');
  await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Android only.', body: 'Findings.', questions: ['How long offline?'] });
  saved = await store.get(map.id);
  await store.updateSettings({ expectedRevision: 1, researchModelHint: '' });
  await store.action(map.id, { expectedRevision: saved.revision, type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions.at(-1).id, answer: 'A week.' });
  packet = await store.claim('agent', map.id);
  assert.equal(Object.hasOwn(packet, 'modelHint'), false, 'cleared');
});

test('a result may report how it ran; that is kept on the job, labelled as the agent’s report, and optional', async () => {
  const { store, map } = await workspace();
  const job = await store.claim('agent', map.id);
  const before = await readFile(store.file(map.id), 'utf8');
  for (const execution of [{ delegated: 'yes', model: 'x' }, { delegated: true }, { delegated: true, model: 'm'.repeat(201) }, { delegated: false, model: 'x', note: 'n'.repeat(201) }, 'delegated'])
    await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', execution }), error => error.status === 400, JSON.stringify(execution));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', execution: { delegated: true, model: 'a <faster> model', note: 'Ran in a subagent.' } });
  const done = saved.jobs.find(entry => entry.id === job.jobId);
  assert.deepEqual(done.execution, { delegated: true, model: 'a <faster> model', note: 'Ran in a subagent.' });
  assert.equal(Object.hasOwn(done.result, 'execution'), false, 'beside worker, not in the findings');
  const note = runNoteHtml(done);
  assert.match(note, /Your agent reported: a &lt;faster&gt; model, delegated\./); assert.doesNotMatch(note, /<faster>/);
  assert.match(runNoteHtml({ ...done, execution: { delegated: false, model: 'its own model' } }), /Your agent reported: its own model, not delegated\./);
  assert.doesNotMatch(runNoteHtml({ ...done, execution: undefined }), /reported/, 'a result without it completes normally');
});

test('the settings route saves and clears the hint, rejects a bad one, and next hands it out', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'model-http-'));
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = async (route, body) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await (await call('/settings')).json()).researchModelHint, '');
    assert.equal((await call('/settings', { expectedRevision: 0, researchModelHint: 'two\nlines' })).status, 400);
    assert.equal((await call('/settings', { expectedRevision: 0, researchModelHint: 'a faster model' })).status, 200);
    assert.equal((await call('/settings', { expectedRevision: 0, researchModelHint: 'stale' })).status, 409);
    const map = await (await call('/maps', { title: 'Field notebook', idea: 'Notes that work offline.' })).json();
    const packet = await (await call(`/next?worker=agent&map=${map.id}`)).json();
    assert.deepEqual(packet.modelHint, hint('a faster model'));
  } finally { await app.close(); }
});

test('doctor works with and without a settings file that names a research model', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), { writeFile } = await import('node:fs/promises');
  const run = workspace => promisify(execFile)(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), 'doctor', '--workspace', workspace]);
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'model-doctor-'));
  const without = JSON.parse((await run(workspace)).stdout);
  await mkdir(path.join(workspace, 'ideas'), { recursive: true });
  await writeFile(path.join(workspace, 'ideas', 'settings.json'), JSON.stringify({ version: 1, revision: 1, researchModelHint: 'a faster model' }));
  const withFile = JSON.parse((await run(workspace)).stdout);
  for (const result of [without, withFile]) { assert.equal(result.state, 'not-started'); assert.equal(result.savedMaps, 0); assert.ok(result.checks.every(check => check.status !== 'error')); }
});
