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
import { mapJobTypes, CHECK_ANSWERS } from '../skills/explore/scripts/map-jobs.mjs';
import { packetBudget } from '../skills/explore/scripts/guidance.mjs';
import { restoreSummary, versionLabel } from '../skills/explore/assets/workspace-view.js';
import { briefPreview } from '../skills/explore/assets/brief-dialog.js';
import { modes, goalInput, goalEdits, goalFieldsHtml, goalSectionHtml, goalEditorHtml } from '../skills/explore/assets/guidance.js';

// The map's goal: mode, objective and success criteria (A1, #2). Illustrative maps under .test-output, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const goal = { mode: 'decide', objective: 'Pick a sync approach for the crew.', successCriteria: 'A recommendation with its trade-offs.' };
async function workspace(input = {}) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'guidance-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline for a survey crew.', ...input });
  const act = async fields => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...fields });
  return { store, map, act, folder: path.dirname(store.file(map.id)) };
}

test('a map created with a goal keeps it, and the brief, its dialog and the README show it after the idea', async () => {
  const { store, map, folder } = await workspace(goal);
  const saved = await store.get(map.id);
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, goal.objective); assert.equal(saved.successCriteria, goal.successCriteria);
  assert.ok(Date.parse(saved.guidanceUpdatedAt));
  const brief = mapBrief(saved);
  assert.deepEqual(brief.goal, goal);
  assert.match(brief.markdown, /## Original idea[\s\S]*\n## Goal and mode\n\n- Mode: Decide — choices, criteria and trade-offs\n- Objective: Pick a sync approach for the crew\.\n- Done looks like: A recommendation with its trade-offs\.\n\n## Progress/);
  assert.match(briefPreview(brief), /<h3>Original idea<\/h3><blockquote>[^<]*<\/blockquote><div class="guidance-summary"[\s\S]*Decide — choices, criteria and trade-offs[\s\S]*Pick a sync approach for the crew\./);
  assert.match(await readFile(path.join(folder, 'README.md'), 'utf8'), /## Original idea[\s\S]*\n## Goal and mode\n\n- Mode: Decide — choices, criteria and trade-offs\n[\s\S]*\n## Exploration/);
});

test('an unknown mode or over-long text is refused, and nothing is written', async () => {
  const { store, map, act } = await workspace();
  for (const [input, message] of [[{ mode: 'explore' }, /Choose Understand/], [{ objective: 'x'.repeat(2001) }, /at most 2000/], [{ successCriteria: 7 }, /must be text/]]) {
    await assert.rejects(store.create({ title: 'T', idea: 'An idea.', ...input }), error => error.status === 400 && message.test(error.message), JSON.stringify(input).slice(0, 40));
    const before = await readFile(store.file(map.id), 'utf8');
    await assert.rejects(act({ type: 'set-guidance', ...input }), error => error.status === 400);
    assert.equal(await readFile(store.file(map.id), 'utf8'), before);
  }
  assert.equal((await store.list()).length, 1, 'only the first map was created');
});

test('every packet carries the goal, even when context is trimmed or the glossary fills the rest; Tidy keeps the user words alone', async () => {
  const { store, map, act } = await workspace({ mode: 'diagnose', objective: 'Find why sync drops edits.', successCriteria: 'A reproduced cause.' });
  const expected = { mode: 'diagnose', modeFocus: modes.diagnose.focus, objective: 'Find why sync drops edits.', successCriteria: 'A reproduced cause.' };
  for (let i = 0; i < 4; i++) await act({ type: 'suggest', title: `Direction ${i}`, body: 'A long premise. '.repeat(200) });
  let saved = await store.get(map.id);
  // A direction's packet carries the starting idea as context; a small budget shortens it, and the goal stays.
  const direction = saved.nodes.find(node => node.id !== map.rootId);
  const small = store.packet(saved, { id: 'job-trim', nodeId: direction.id, reason: 'Test.' }, { claimKey: 'k', budget: 4000 });
  assert.equal(small.context[0].id, map.rootId, 'the path stays (C13)'); assert.deepEqual(small.goal, expected);
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.goal, expected); assert.match(packet.instruction, /Shape the work by the goal/);
  saved = await store.get(map.id);
  assert.equal(saved.jobs.find(job => job.id === packet.jobId).guidanceUpdatedAt, saved.guidanceUpdatedAt, 'the job records the goal it was given');
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'S.', body: 'B.', questions: ['Which phones?'] });
  const questionId = saved.nodes[0].questions[0].id;
  await act({ type: 'request-research', questionId });
  const research = await store.claim('agent', map.id);
  assert.equal(research.jobType, 'question-research'); assert.deepEqual(research.goal, expected);
  await act({ type: 'clean-answer', questionId, text: 'phones i think' });
  const tidy = await store.claim('agent', map.id);
  assert.equal(tidy.jobType, 'clean-answer'); assert.equal(Object.hasOwn(tidy, 'goal'), false);
  saved = await store.get(map.id);
  assert.equal(Object.hasOwn(saved.jobs.find(job => job.id === tidy.jobId), 'guidanceUpdatedAt'), false, 'a job given no goal records none');
});

test('work that fills its whole budget still fits beside a long goal and a glossary that takes the rest', async () => {
  const { store, map, act } = await workspace({ mode: 'decide', objective: 'o'.repeat(2000), successCriteria: 's'.repeat(2000) });
  for (let i = 0; i < 80; i++) await act({ type: 'glossary-add', term: `T${i}`, definition: `Short meaning ${i}.` });
  const saved = await store.get(map.id);
  // A type whose own content uses all the room it is given, as trimming types do near their limit.
  const definition = { label: 'Probe', packet: ({ budget }) => ({ filler: 'x'.repeat(budget - 860), instruction: 'Do the probe work.' }) };
  const packet = await store.typedPacket(saved, { id: 'job-probe', type: 'probe', reason: 'Test.' }, definition, null, { claimKey: 'k' });
  assert.ok(packet.contextCharacters <= 15500); assert.ok(packet.glossary.length > 0, 'the glossary took the room that was left');
  assert.match(packet.goal.objective, /\[Shortened; read the map for the full text\.\]$/);
});

test('Check answers refuses a selection when asked if it would not fit when an agent takes it, and takes one that does', async () => {
  const { store, map, act } = await workspace({ mode: 'decide', objective: 'o'.repeat(2000), successCriteria: 's'.repeat(2000) });
  const ask = index => `Question ${index}: ${'Which of these matters most for the crew, and why? '.repeat(9)}`;
  const first = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, first.jobId, first.claimKey, { summary: 'S.', body: 'B.', questions: [0, 1, 2, 3, 4].map(ask), suggestions: [{ title: 'Sync', body: 'How edits sync.' }] });
  const child = saved.nodes.find(node => node.id !== map.rootId);
  await act({ type: 'activate', nodeId: child.id });
  const second = await store.claim('agent', map.id);
  saved = await store.complete(map.id, second.jobId, second.claimKey, { summary: 'S.', body: 'B.', questions: [5, 6, 7, 8, 9].map(ask) });
  for (const node of saved.nodes) for (const question of node.questions) saved = await act({ type: 'answer', nodeId: node.id, questionId: question.id, answer: 'An answer that takes room. '.repeat(60) });
  const records = saved.nodes.flatMap(node => node.questions.map(question => ({ nodeId: node.id, questionId: question.id })));
  // The smallest selection that fits the whole budget but not the budget less the goal.
  const fits = (selection, budget) => { try { mapJobTypes[CHECK_ANSWERS].packet({ map: saved, job: { input: { selection } }, budget }); return true; } catch { return false; } };
  const size = records.findIndex((_, i) => fits(records.slice(0, i + 1), 15500) && !fits(records.slice(0, i + 1), packetBudget(saved))) + 1;
  assert.ok(size > 1, 'the fixture reaches the gap the goal opens');
  await assert.rejects(act({ type: 'request-map-job', jobType: CHECK_ANSWERS, selection: records.slice(0, size) }), /Choose fewer answers/);
  await act({ type: 'request-map-job', jobType: CHECK_ANSWERS, selection: records.slice(0, size - 1) });
  let job = await store.claim('agent', map.id);
  while (job && job.jobType !== CHECK_ANSWERS) { await store.fail(map.id, job.jobId, job.claimKey, 'Set aside for the test.'); job = await store.claim('agent', map.id); }
  assert.equal(job?.jobType, CHECK_ANSWERS, 'a selection accepted is a selection that fits'); assert.ok(job.goal);
});

test('a map without a goal loads unchanged, and its packets have none', async () => {
  const { store, map } = await workspace();
  const file = await readFile(store.file(map.id), 'utf8');
  const saved = await store.get(map.id); await store.list();
  assert.equal(await readFile(store.file(map.id), 'utf8'), file, 'nothing is written on load');
  for (const key of ['mode', 'objective', 'successCriteria', 'guidanceUpdatedAt']) assert.equal(Object.hasOwn(saved, key), false, key);
  const packet = await store.claim('agent', map.id);
  assert.equal(Object.hasOwn(packet, 'goal'), false); assert.equal(mapBrief(saved).goal, null);
  assert.ok(validateMap({ ...saved, mode: 'newer-mode' }).errors.every(error => !error.unreadable), 'a mode from a newer Explore does not stop the map opening');
  const long = validateMap({ ...saved, objective: 'x'.repeat(2001) });
  assert.ok(long.errors.some(error => /objective/.test(error.at)) && long.errors.every(error => !error.unreadable), 'an over-long objective from a pull is reported');
  assert.equal(mapBrief({ ...saved, objective: 'x'.repeat(5000) }).goal.objective.length, 2001, 'the brief stays bounded');
});

test('set-guidance changes the fields it is given, refuses a save that changes nothing, and keeps every idea and job; Undo restores', async () => {
  const { store, map, act } = await workspace({ mode: 'understand', objective: 'Learn the domain.' });
  const before = await store.get(map.id);
  let saved = await act({ type: 'set-guidance', mode: 'decide', successCriteria: 'Two options compared.' });
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, 'Learn the domain.', 'a field left out is kept'); assert.equal(saved.successCriteria, 'Two options compared.');
  assert.notEqual(saved.guidanceUpdatedAt, before.guidanceUpdatedAt);
  assert.deepEqual(saved.nodes, before.nodes, 'content, stale flags, review state and contentRevision are untouched');
  assert.deepEqual(saved.jobs, before.jobs, 'the queue is untouched');
  assert.deepEqual(saved.history.at(-1), { ...saved.history.at(-1), type: 'guidance-changed', previous: { mode: 'understand', objective: 'Learn the domain.' } });
  assert.equal(versionLabel((await store.versions.list(map.id)).versions[0]), 'Goal and mode changed');
  const revision = saved.revision;
  await assert.rejects(act({ type: 'set-guidance', mode: 'decide', objective: '  Learn the domain.  ' }), error => error.status === 409 && /Nothing changed/.test(error.message));
  assert.equal((await store.get(map.id)).revision, revision, 'a save that changes nothing is not saved');
  saved = await act({ type: 'set-guidance', mode: null, objective: '', successCriteria: '   ' });
  for (const key of ['mode', 'objective', 'successCriteria']) assert.equal(Object.hasOwn(saved, key), false, `${key} is cleared`);
  const cleared = saved.guidanceUpdatedAt;
  const versions = (await store.versions.list(map.id)).versions;
  saved = await act({ type: 'restore-version', version: versions[1].id, undo: true });
  assert.equal(saved.mode, 'decide'); assert.equal(saved.objective, 'Learn the domain.');
  assert.ok(saved.guidanceUpdatedAt > cleared, 'a restore that changes the goal stamps it now; the stamp never goes back');
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0, termsChanged: 0, guidanceChanged: true }, reopened: [] }), /^Restoring changes the goal and mode\./);
});

test('one set of fields serves the create dialog and the editor: No mode is a choice, none is checked when creating, drafts survive', () => {
  const create = goalFieldsHtml({ esc, prefix: 'create' });
  assert.equal((create.match(/<input type="radio" name="mode"/g) || []).length, 6); assert.doesNotMatch(create, /checked/);
  assert.match(create, /value=""[^>]*><span><strong>No mode<\/strong><\/span>/);
  assert.match(create, /value="challenge"[^>]*><span><strong>Challenge<\/strong> assumptions, counterexamples and failure conditions/);
  assert.match(create, /id="create-objective" name="objective" rows="2" maxlength="2000"/); assert.doesNotMatch(create, /data-draft/);
  const form = values => ({ get: key => values[key] ?? null });
  assert.deepEqual(goalInput(form({ mode: 'design', objective: '  A plan.  ', successCriteria: '' })), { mode: 'design', objective: '  A plan.  ' });
  assert.deepEqual(goalInput(form({ mode: '' })), {}, 'No mode or an unopened disclosure sends nothing');
  const map = { id: 'map-1', rootId: 'root', mode: 'decide', objective: 'Pick <one>.', successCriteria: 'A choice.' };
  assert.equal(goalSectionHtml({ id: 'map-1', rootId: 'root' }, { esc }), '');
  const section = goalSectionHtml(map, { esc });
  assert.match(section, /^<div class="guidance-summary">/); assert.match(section, /Pick &lt;one&gt;\./); assert.doesNotMatch(section, /<one>/);
  const editor = goalEditorHtml(map, { esc, drafts: {} });
  assert.match(editor, /<details data-editor="guidance"><summary data-command="edit-guidance" data-command-editor="guidance" data-node-id="root">Edit goal and mode<\/summary><form id="guidance-form" data-node-id="root">/);
  assert.match(editor, /value="decide" checked data-draft="guidance-mode:map-1">/); assert.match(editor, /<button class="secondary" type="submit">Save<\/button>/);
  assert.match(editor, /id="guidance-objective" name="objective"[^>]*data-draft="guidance-objective:map-1">Pick &lt;one&gt;\.<\/textarea>/);
  const drafted = goalEditorHtml(map, { esc, drafts: { 'guidance-mode:map-1': 'design', 'guidance-objective:map-1': 'Draft.' } });
  assert.match(drafted, /value="design" checked/); assert.match(drafted, />Draft\.<\/textarea>/, 'a draft survives a redraw');
  assert.match(goalEditorHtml({ id: 'map-1', rootId: 'root' }, { esc, drafts: {} }), /value="" checked[\s\S]*>Set a goal and mode<\/summary>|>Set a goal and mode<\/summary>[\s\S]*value="" checked/);
  assert.deepEqual(goalEdits(map, { mode: 'decide', objective: ' Pick <one>. ', successCriteria: 'A choice.' }), {}, 'nothing changed');
  assert.deepEqual(goalEdits(map, { mode: '', objective: 'Pick <one>.', successCriteria: '' }), { mode: null, successCriteria: null }, 'only what changed is sent');
  assert.deepEqual(goalEdits({ ...map, mode: 'newer-mode' }, { mode: '', objective: 'Pick <one>.', successCriteria: 'A choice.' }), {}, 'a mode the form cannot show is kept');
  assert.deepEqual(goalEdits({ ...map, objective: 'x'.repeat(3000) }, { mode: 'design', objective: 'x'.repeat(3000), successCriteria: 'A choice.' }), { mode: 'design' }, 'a long pulled text is not sent back');
});

test('the CLI creates a map with a goal, changes it with act, and read and brief return it', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspaceDir = await mkdtemp(path.join(root, 'guidance-cli-'));
  const app = await startServer({ workspace: workspaceDir, port: 0 });
  const skill = path.resolve('skills/explore');
  const cli = async args => JSON.parse((await promisify(execFile)(process.execPath, [path.join(skill, 'scripts/cli.mjs'), ...args, '--workspace', workspaceDir])).stdout);
  try {
    const file = path.join(workspaceDir, 'idea.json'); await writeFile(file, JSON.stringify({ title: 'CLI goal', idea: 'Shared notes.', ...goal }));
    const created = await cli(['create', '--file', file]);
    let read = await cli(['read', '--map', created.mapId]);
    assert.deepEqual(read.goal, goal);
    const action = path.join(workspaceDir, 'action.json');
    await writeFile(action, JSON.stringify({ expectedRevision: read.revision, type: 'set-guidance', mode: 'challenge', successCriteria: null }));
    await cli(['act', '--map', created.mapId, '--file', action]);
    read = await cli(['read', '--map', created.mapId]);
    assert.deepEqual(read.goal, { mode: 'challenge', objective: goal.objective });
    assert.deepEqual((await cli(['brief', '--map', created.mapId])).goal, { mode: 'challenge', objective: goal.objective });
  } finally { await app.close(); }
});
