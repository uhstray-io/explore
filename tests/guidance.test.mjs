import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { restoreSummary } from '../skills/explore/assets/workspace-view.js';
import { modes, guidanceInput, modeChoicesHtml, guidanceSectionHtml, guidanceEditorHtml } from '../skills/explore/assets/guidance.js';

// Mode, objective and success criteria (A1, #2). Illustrative maps under .test-output, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const goal = { mode: 'decide', objective: 'Pick a sync approach for the crew.', successCriteria: 'A recommendation with its trade-offs.' };
async function workspace(input = {}) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'guidance-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline for a survey crew.', ...input });
  const act = async fields => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...fields });
  const folder = path.dirname(store.file(map.id));
  return { store, map, act, folder };
}

test('a map created with a mode, objective and success criteria keeps them, and the brief and README show them after the idea', async () => {
  const { store, map, folder } = await workspace(goal);
  const saved = await store.get(map.id);
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, goal.objective); assert.equal(saved.successCriteria, goal.successCriteria);
  assert.ok(Date.parse(saved.guidanceUpdatedAt));
  const brief = mapBrief(saved);
  assert.deepEqual(brief.goal, goal, 'the brief names it goal: its guidance field is the reading note');
  assert.match(brief.markdown, /## Original idea[\s\S]*\n## Goal and mode\n\n- Mode: Decide — choices, criteria and trade-offs\n- Objective: Pick a sync approach for the crew\.\n- Done looks like: A recommendation with its trade-offs\.\n\n## Progress/);
  const { briefPreview } = await import('../skills/explore/assets/brief-dialog.js');
  assert.match(briefPreview(brief), /<h3>Original idea<\/h3><blockquote>[^<]*<\/blockquote><section class="guidance-summary"[\s\S]*Decide — choices, criteria and trade-offs[\s\S]*Pick a sync approach for the crew\./);
  assert.match(await readFile(path.join(folder, 'README.md'), 'utf8'), /## Original idea[\s\S]*\n## Goal and mode\n\n- Mode: Decide — choices, criteria and trade-offs\n[\s\S]*\n## Exploration/);
});

test('an unknown mode or over-long text is refused, and nothing is written', async () => {
  const { store, map, act } = await workspace();
  for (const input of [{ mode: 'explore' }, { objective: 'x'.repeat(2001) }, { successCriteria: 7 }]) {
    await assert.rejects(store.create({ title: 'T', idea: 'An idea.', ...input }), error => error.status === 400, JSON.stringify(input).slice(0, 40));
    const before = await readFile(store.file(map.id), 'utf8');
    await assert.rejects(act({ type: 'set-guidance', ...input }), error => error.status === 400);
    assert.equal(await readFile(store.file(map.id), 'utf8'), before);
  }
  assert.equal((await store.list()).length, 1, 'only the first map was created');
});

test('every packet carries the guidance, even when context is trimmed; Tidy keeps the user words alone', async () => {
  const { store, map, act } = await workspace({ mode: 'diagnose', objective: 'Find why sync drops edits.', successCriteria: 'A reproduced cause.' });
  const expected = { mode: 'diagnose', modeFocus: modes.diagnose.focus, objective: 'Find why sync drops edits.', successCriteria: 'A reproduced cause.' };
  for (let i = 0; i < 4; i++) await act({ type: 'suggest', title: `Direction ${i}`, body: 'A long premise. '.repeat(200) });
  let saved = await store.get(map.id);
  // A direction's packet carries the starting idea as context; a small budget trims it, and the guidance stays.
  const direction = saved.nodes.find(node => node.id !== map.rootId);
  const small = store.packet(saved, { id: 'job-trim', nodeId: direction.id, reason: 'Test.' }, { claimKey: 'k', budget: 4000 });
  assert.ok(small.omittedContext > 0, 'context was trimmed'); assert.deepEqual(small.guidance, expected);
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.guidance, expected); assert.match(packet.instruction, /guidance/);
  saved = await store.get(map.id);
  assert.equal(saved.jobs.find(job => job.id === packet.jobId).guidanceUpdatedAt, saved.guidanceUpdatedAt, 'the job records the guidance it was given');
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'S.', body: 'B.', questions: ['Which phones?'] });
  const questionId = saved.nodes[0].questions[0].id;
  await act({ type: 'request-research', questionId });
  const research = await store.claim('agent', map.id);
  assert.equal(research.jobType, 'question-research'); assert.deepEqual(research.guidance, expected);
  await act({ type: 'clean-answer', questionId, text: 'phones i think' });
  const tidy = await store.claim('agent', map.id);
  assert.equal(tidy.jobType, 'clean-answer'); assert.equal(Object.hasOwn(tidy, 'guidance'), false);
});

test('a map without guidance loads unchanged, and its packets have none', async () => {
  const { store, map } = await workspace();
  const file = await readFile(store.file(map.id), 'utf8');
  const saved = await store.get(map.id); await store.list();
  assert.equal(await readFile(store.file(map.id), 'utf8'), file, 'nothing is written on load');
  for (const key of ['mode', 'objective', 'successCriteria', 'guidanceUpdatedAt']) assert.equal(Object.hasOwn(saved, key), false, key);
  const packet = await store.claim('agent', map.id);
  assert.equal(Object.hasOwn(packet, 'guidance'), false); assert.equal(mapBrief(saved).goal, null);
  assert.ok(validateMap({ ...saved, mode: 'newer-mode' }).errors.every(error => !error.unreadable), 'a mode from a newer Explore does not stop the map opening');
});

test('changing the guidance keeps every idea, flag, review and queued job, and history records the old values; Undo brings them back', async () => {
  const { store, map, act } = await workspace({ mode: 'understand', objective: 'Learn the domain.' });
  const before = await store.get(map.id);
  let saved = await act({ type: 'set-guidance', mode: 'decide', objective: 'Choose a sync approach.', successCriteria: 'Two options compared.' });
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, 'Choose a sync approach.'); assert.equal(saved.successCriteria, 'Two options compared.');
  assert.notEqual(saved.guidanceUpdatedAt, before.guidanceUpdatedAt);
  assert.deepEqual(saved.nodes, before.nodes, 'content, stale flags, review state and contentRevision are untouched');
  assert.deepEqual(saved.jobs, before.jobs, 'the queue is untouched');
  const event = saved.history.at(-1);
  assert.equal(event.type, 'guidance-changed'); assert.deepEqual(event.previous, { mode: 'understand', objective: 'Learn the domain.' });
  saved = await act({ type: 'set-guidance', mode: null, objective: '', successCriteria: '' });
  for (const key of ['mode', 'objective', 'successCriteria']) assert.equal(Object.hasOwn(saved, key), false, `${key} is cleared`);
  assert.deepEqual(saved.history.at(-1).previous, { mode: 'decide', objective: 'Choose a sync approach.', successCriteria: 'Two options compared.' });
  const versions = (await store.versions.list(map.id)).versions;
  saved = await act({ type: 'restore-version', version: versions[1].id, undo: true });
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, 'Choose a sync approach.');
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0, termsChanged: 0, guidanceChanged: true }, reopened: [] }), /^Restoring changes the goal and mode\./);
});

test('the create dialog offers each mode with its focus and none chosen; the inspector shows and edits the guidance', () => {
  const choices = modeChoicesHtml(esc);
  assert.equal((choices.match(/<input type="radio" name="mode"/g) || []).length, 5); assert.doesNotMatch(choices, /checked/);
  assert.match(choices, /value="challenge"[^>]*>[\s\S]*Challenge[\s\S]*assumptions, counterexamples and failure conditions/);
  const form = values => ({ get: key => values[key] ?? null });
  assert.deepEqual(guidanceInput(form({ mode: 'design', objective: '  A plan.  ', successCriteria: '' })), { mode: 'design', objective: '  A plan.  ' });
  assert.deepEqual(guidanceInput(form({})), {}, 'an unopened disclosure sends nothing');
  const map = { id: 'map-1', rootId: 'root', mode: 'decide', objective: 'Pick <one>.', successCriteria: 'A choice.' };
  assert.equal(guidanceSectionHtml({ id: 'map-1', rootId: 'root' }, { esc }), '');
  const section = guidanceSectionHtml(map, { esc });
  assert.match(section, /Decide/); assert.match(section, /Pick &lt;one&gt;\./); assert.doesNotMatch(section, /<one>/); assert.match(section, /A choice\./);
  const editor = guidanceEditorHtml(map, { esc, drafts: {} });
  assert.match(editor, /<details data-editor="guidance"><summary data-command="edit-guidance" data-command-editor="guidance" data-node-id="root">Edit goal and mode<\/summary><form id="guidance-form" data-node-id="root">/);
  assert.match(editor, /<select id="guidance-mode" name="mode" data-draft="guidance-mode:map-1"><option value="">No mode<\/option>[\s\S]*<option value="decide" selected>Decide — choices, criteria and trade-offs<\/option>/);
  assert.match(editor, /<textarea id="guidance-objective" name="objective" maxlength="2000" data-draft="guidance-objective:map-1"[^>]*>Pick &lt;one&gt;\.<\/textarea>/);
  assert.match(guidanceEditorHtml(map, { esc, drafts: { 'guidance-mode:map-1': 'design', 'guidance-objective:map-1': 'Draft.' } }), /<option value="design" selected>[\s\S]*>Draft\.<\/textarea>/, 'a draft survives a redraw');
  assert.match(guidanceEditorHtml({ id: 'map-1', rootId: 'root' }, { esc, drafts: {} }), />Set a goal and mode<\/summary>/);
});

test('the CLI creates a map with guidance, changes it with act, and read returns it', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspaceDir = await mkdtemp(path.join(root, 'guidance-cli-'));
  const app = await startServer({ workspace: workspaceDir, port: 0 });
  const skill = path.resolve('skills/explore');
  const cli = async args => JSON.parse((await promisify(execFile)(process.execPath, [path.join(skill, 'scripts/cli.mjs'), ...args, '--workspace', workspaceDir])).stdout);
  try {
    const file = path.join(workspaceDir, 'idea.json'); await writeFile(file, JSON.stringify({ title: 'CLI goal', idea: 'Shared notes.', ...goal }));
    const created = await cli(['create', '--file', file]);
    let read = await cli(['read', '--map', created.mapId]);
    assert.deepEqual(read.guidance, goal);
    const action = path.join(workspaceDir, 'action.json');
    await writeFile(action, JSON.stringify({ expectedRevision: read.revision, type: 'set-guidance', mode: 'challenge', objective: 'Stress the plan.' }));
    await cli(['act', '--map', created.mapId, '--file', action]);
    read = await cli(['read', '--map', created.mapId]);
    assert.deepEqual(read.guidance, { mode: 'challenge', objective: 'Stress the plan.' });
    assert.deepEqual((await cli(['brief', '--map', created.mapId])).goal, { mode: 'challenge', objective: 'Stress the plan.' });
  } finally { await app.close(); }
});
