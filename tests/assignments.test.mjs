import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { mapOverview, versionLabel, restoreSummary } from '../skills/explore/assets/workspace-view.js';
import { assignmentCardHtml, assignFormHtml, assignmentRequest, assignmentClick, assignedFilter, openAssignment, assignmentsOf } from '../skills/explore/assets/assignments.js';
import { assignmentLines } from '../skills/explore/scripts/assignments.mjs';
import { readProblem } from '../skills/explore/scripts/map-validation.mjs';
import { compareVersion } from '../skills/explore/scripts/versions.mjs';
import { previewBranchRestore } from '../skills/explore/scripts/branch-restore.mjs';
import { branchRestoreHtml } from '../skills/explore/assets/branch-restore.js';

// Assign a branch to someone (H7, #36). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const ben = { name: 'Ben' }, ana = { name: 'Ana' };

// A map with an explored root (a question still open) and one suggested direction.
async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'assign-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  const saved = await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Sync is the hard part.', body: 'Phones keep notes locally.', questions: ['Who edits notes?'], suggestions: [{ title: 'Storage', body: 'What lives on the phone.' }] });
  const branch = saved.nodes.find(node => node.title === 'Storage');
  const act = async (input, actor = ben) => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: branch.id, ...input }, { actor });
  return { store, map, branch, act };
}
// Everything an assignment must leave alone: every idea whole, links, jobs, growth and the view.
const untouched = map => JSON.stringify([map.nodes, map.edges, map.jobs, map.growth, map.view]);

test('assign, take, pass on and mark done record their status and events, and survive a restart; the branch is never touched', async () => {
  const { store, map, branch, act } = await setup();
  const before = untouched(await store.get(map.id));
  let saved = await act({ type: 'assign', to: 'Ana', note: 'Check what fits on older phones.' });
  let item = openAssignment(saved, branch.id);
  assert.deepEqual([item.requestedFor, item.status, item.note, saved.assignments.version], ['Ana', 'requested', 'Check what fits on older phones.', 1]);
  saved = await act({ type: 'take-assignment', assignmentId: item.id }, ana);
  item = openAssignment(saved, branch.id);
  assert.deepEqual([item.status, item.takenBy], ['taken', { name: 'Ana' }]);
  saved = await act({ type: 'pass-assignment', assignmentId: item.id, to: 'Cy', note: 'You know the phones.' }, ana);
  item = openAssignment(saved, branch.id);
  assert.deepEqual([item.status, item.requestedFor, item.takenBy, item.note], ['requested', 'Cy', undefined, 'You know the phones.']);
  saved = await act({ type: 'complete-assignment', assignmentId: item.id, note: 'Fits.' });
  assert.equal(openAssignment(saved, branch.id), null);
  const reloaded = (await new Store(store.directory).get(map.id)).assignments.items[0];
  assert.equal(reloaded.status, 'done');
  assert.deepEqual(reloaded.events.map(event => [event.type, event.by?.name, event.to, event.note]), [['requested', 'Ben', 'Ana', 'Check what fits on older phones.'], ['taken', 'Ana', undefined, undefined], ['passed', 'Ana', 'Cy', 'You know the phones.'], ['done', 'Ben', undefined, 'Fits.']]);
  assert.ok(reloaded.events.every(event => !Number.isNaN(Date.parse(event.at))));
  assert.equal(untouched(await store.get(map.id)), before, 'no work state, review state, question, link, job or growth changes');
  assert.deepEqual((await store.get(map.id)).history.filter(event => event.type.startsWith('assignment-')).map(event => event.type), ['assignment-requested', 'assignment-taken', 'assignment-passed', 'assignment-done']);
});

test('one open request per branch; taking needs a name; a done request is reopened by passing it on', async () => {
  const { store, map, branch, act } = await setup();
  let saved = await act({ type: 'assign', to: 'Ana' });
  const item = openAssignment(saved, branch.id);
  await assert.rejects(act({ type: 'assign', to: 'Cy' }), error => error.status === 409 && /already asked/.test(error.message));
  await assert.rejects(act({ type: 'take-assignment', assignmentId: item.id }, null), /Explore takes your name from Git\. Set it \(git config user\.name\)/);
  await act({ type: 'take-assignment', assignmentId: item.id }, ana);
  await assert.rejects(act({ type: 'take-assignment', assignmentId: item.id }, { name: 'Cy' }), error => error.status === 409 && /^Ana has this already\. Pass it on first\.$/.test(error.message), 'never taken over from someone who has it');
  assert.equal(openAssignment(await store.get(map.id), branch.id).takenBy.name, 'Ana');
  for (const [input, message] of [[{ type: 'assign', to: '', nodeId: map.rootId }, /Who is required/], [{ type: 'pass-assignment', assignmentId: item.id, to: 'x'.repeat(81) }, /at most 80/], [{ type: 'pass-assignment', assignmentId: item.id, to: 'A\nB' }, /one line/],
    [{ type: 'pass-assignment', assignmentId: item.id, to: 'Cy', note: 'n'.repeat(2001) }, /at most 2000/], [{ type: 'take-assignment', assignmentId: 'assignment-nope' }, /no longer exists/]]) {
    await assert.rejects(act(input), message, message.source);
  }
  saved = await act({ type: 'complete-assignment', assignmentId: item.id });
  await assert.rejects(act({ type: 'complete-assignment', assignmentId: item.id }), /already done/);
  await assert.rejects(act({ type: 'take-assignment', assignmentId: item.id }), /Pass it on to reopen it/);
  saved = await act({ type: 'pass-assignment', assignmentId: item.id, to: 'Cy' });
  assert.deepEqual([openAssignment(saved, branch.id)?.id, openAssignment(saved, branch.id)?.status, openAssignment(saved, branch.id)?.requestedFor], [item.id, 'requested', 'Cy'], 'reopened for the new name');
  // With a new request open, the old done one cannot be reopened beside it.
  saved = await act({ type: 'complete-assignment', assignmentId: item.id });
  saved = await act({ type: 'assign', to: 'Dee' });
  await assert.rejects(act({ type: 'pass-assignment', assignmentId: item.id, to: 'Eve' }), /already asked/);
});

test('the Assigned filter lists exactly the open requests; packets, briefs and maps without assignments are unchanged', async () => {
  const { store, map, branch, act } = await setup();
  const plain = await store.get(map.id);
  assert.equal('assignments' in plain, false); assert.deepEqual(validateMap(plain).errors, [], 'a map without assignments loads as it was');
  await act({ type: 'assign', to: 'Ana', note: 'SECRET-NOTE for Ana.' });
  const saved = await store.get(map.id);
  const groups = mapOverview(saved, { filters: [assignedFilter(saved)] }).groups, assigned = groups.find(group => group.id === 'assigned');
  assert.equal(assigned.kind, 'progress'); assert.deepEqual(assigned.nodes.map(node => node.id), [branch.id]);
  assert.match(assigned.lines(assigned.nodes[0])[0].text, /^Requested for Ana by Ben · /);
  const done = await act({ type: 'complete-assignment', assignmentId: openAssignment(saved, branch.id).id });
  assert.deepEqual(mapOverview(done, { filters: [assignedFilter(done)] }).groups.find(group => group.id === 'assigned').nodes, [], 'a done request is not listed');
  await act({ type: 'pass-assignment', assignmentId: done.assignments.items[0].id, to: 'Cy', note: 'SECRET-NOTE again.' });
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: branch.id, type: 'activate' });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.selected.id, branch.id);
  assert.equal(JSON.stringify(packet).includes('SECRET-NOTE'), false, 'never in a work packet');
  assert.equal(JSON.stringify(mapBrief(await store.get(map.id))).includes('SECRET-NOTE'), false, 'or a brief');
  assert.deepEqual(validateMap(await store.get(map.id)).errors, []);
  const bad = structuredClone(await store.get(map.id)); bad.assignments.items[0].status = 'lost';
  assert.ok(validateMap(bad).errors.some(error => error.at === 'assignments.items[0].status'));
  // The idea's Markdown view shows the open request and its note, as literal text, dated as a fixed day.
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${branch.id}.md`), 'utf8');
  assert.match(doc, /_Requested for Cy by Ben · \d{4}-\d{2}-\d{2}\._/); assert.match(doc, /> SECRET-NOTE again\./);
});

test('restoring a version brings its assignments back with it', async () => {
  const { store, map, branch, act } = await setup();
  const assigned = await act({ type: 'assign', to: 'Ana' });
  const { versions } = await store.versions.list(map.id), requested = versions.find(version => version.revision === assigned.revision); // Newest first.
  await act({ type: 'complete-assignment', assignmentId: openAssignment(assigned, branch.id).id });
  const restored = await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, type: 'restore-version', version: requested.id }, { actor: ben });
  assert.equal(openAssignment(restored, branch.id)?.status, 'requested');
});

test('the card shows the request, its history and who took it as literal text; Pass on opens only when asked; nothing to do in history', () => {
  const map = { nodes: [{ id: 'node-a', title: 'A' }], assignments: { version: 1, items: [{ id: 'assignment-1', nodeId: 'node-a', requestedFor: 'Ana <b>', note: 'Look <here>.', status: 'requested', events: [{ at: '2026-11-04T10:00:00.000Z', type: 'requested', by: { name: 'Ben & co' }, to: 'Ana <b>', note: 'Look <here>.' }] }] } };
  const node = map.nodes[0], drafts = { 'assignment-pass:node-a-to': 'Cy <i>' };
  let html = assignmentCardHtml(map, node, { esc, live: true, drafts });
  assert.match(html, /<strong>Requested for Ana &lt;b&gt; by Ben &amp; co · [^<]+<\/strong>/); assert.match(html, /<p class="assignment-note">Look &lt;here&gt;\.<\/p>/);
  assert.match(html, /<li>Requested for Ana &lt;b&gt; by Ben &amp; co · [^<]+<span class="form-note"> Look &lt;here&gt;\.<\/span><\/li>/, 'the history, as literal text');
  assert.match(html, /data-assignment-take="assignment-1" data-node-id="node-a">Take it<\/button>/);
  assert.match(html, /aria-controls="menu-assignment-1"[\s\S]*role="menu" id="menu-assignment-1"[\s\S]*data-assignment-pass="assignment-1"[^>]*>Pass on<\/button>[\s\S]*data-assignment-done="assignment-1"[^>]*>Mark done<\/button>/);
  assert.doesNotMatch(html, /<form|<summary class="visually-hidden"/, 'Pass on stays closed until asked for');
  html = assignmentCardHtml(map, node, { esc, live: true, drafts, passing: 'assignment-1' });
  assert.match(html, /<form class="assignment-pass-form" data-pass-form="assignment-1" data-node-id="node-a">[\s\S]*value="Cy &lt;i&gt;"[\s\S]*data-assignment-pass-cancel="assignment-1"[^>]*>Cancel<\/button><\/div><\/form>/, 'its form, its draft kept, and Cancel');
  assert.doesNotMatch(assignmentCardHtml(map, node, { esc, live: true, passing: 'assignment-2' }), /<form/, 'another request\'s form is not this one');
  assert.match(assignmentCardHtml(map, node, { esc, live: true, drafts: { 'assignment-pass:node-a-note': 'Bring <tea>' }, passing: 'assignment-1' }), />Bring &lt;tea&gt;<\/textarea>/);
  assert.equal(assignFormHtml(map, node, { esc, live: true }), '', 'no second request while one is open');
  assert.doesNotMatch(assignmentCardHtml(map, node, { esc, live: false, passing: 'assignment-1' }), /data-assignment-|<form|data-menu/, 'nothing to do in history, even while it waits');
  map.assignments.items[0] = { ...map.assignments.items[0], status: 'taken', takenBy: { name: 'Ana <i>' } };
  html = assignmentCardHtml(map, node, { esc, live: true });
  assert.doesNotMatch(html, /Take it/); assert.match(html, /<p class="form-note">Taken by Ana &lt;i&gt;\.<\/p>/);
  const history = assignmentCardHtml(map, node, { esc, live: false });
  assert.doesNotMatch(history, /data-assignment-|<form/); assert.match(history, /Requested for Ana/);
  map.assignments.items[0].status = 'done';
  assert.equal(assignmentCardHtml(map, node, { esc, live: true }), '');
  assert.match(assignFormHtml(map, node, { esc, live: true, drafts: { 'assign:node-a-to': 'Dee <u>', 'assign:node-a-note': 'Why <s>' } }), /<summary>Ask someone to look at this branch<\/summary>[\s\S]*data-draft="assign:node-a-to" value="Dee &lt;u&gt;"[\s\S]*>Why &lt;s&gt;<\/textarea>/, 'its drafts kept through a redraw');
  assert.equal(assignFormHtml(map, node, { esc, live: false }), '');
  assert.deepEqual(assignmentRequest({ id: 'assign-form', dataset: {} }, { to: 'Ana', note: ' ' }), { type: 'assign', input: { to: 'Ana' } });
  assert.deepEqual(assignmentRequest({ id: '', dataset: { passForm: 'assignment-1' } }, { to: 'Cy', note: 'Hi.' }), { type: 'pass-assignment', input: { assignmentId: 'assignment-1', to: 'Cy', note: 'Hi.' } });
  assert.equal(assignmentRequest({ id: 'suggest-form', dataset: {} }, {}), null);
});

test('Take it, Pass on, Cancel and Mark done act through the app and keep focus on the card', async () => {
  const calls = [], toasts = [], focused = [], state = { drafts: { 'assignment-pass:node-a-to': 'Dee', 'assignment-pass:node-a-note': 'Hi', 'assign:node-a-to': 'Kept' }, assignmentPassing: null }; let rendered = 0;
  const ctx = { state, act: async (...args) => { calls.push(args); return true; }, toast: message => toasts.push(message), renderDetail: force => { assert.equal(force, true); rendered++; } };
  const click = dataset => assignmentClick({ target: { closest: selector => { const name = selector.match(/^\[data-([a-z-]+)\]$/)[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return name in dataset ? { dataset, disabled: false } : null; } } }, ctx);
  globalThis.document = { querySelector: selector => ({ focus: () => focused.push(selector) }) };
  try {
    assert.equal(await click({ assignmentTake: 'assignment-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'take-assignment', { assignmentId: 'assignment-1' }]); assert.equal(focused.at(-1), '#detail [data-menu="assignment-1"]');
    assert.equal(await click({ assignmentPass: 'assignment-1', nodeId: 'node-a' }), true);
    assert.equal(state.assignmentPassing, 'assignment-1'); assert.equal(calls.length, 1, 'opening the form saves nothing'); assert.equal(focused.at(-1), '#detail [data-pass-form] input');
    assert.equal(await click({ assignmentPassCancel: 'assignment-1', nodeId: 'node-a' }), true);
    assert.equal(state.assignmentPassing, null); assert.deepEqual(state.drafts, { 'assign:node-a-to': 'Kept' }, 'only its own drafts go'); assert.equal(focused.at(-1), '#detail [data-menu="assignment-1"]');
    assert.equal(await click({ assignmentDone: 'assignment-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'complete-assignment', { assignmentId: 'assignment-1' }]); assert.equal(focused.at(-1), '#detail [data-editor="assign"] summary', 'on to asking someone new');
    assert.deepEqual(toasts, ['It is yours now.', 'Marked done.']); assert.equal(rendered, 4);
    assert.equal(await click({ explore: 'node-a' }), false, 'other clicks are left alone');
  } finally { delete globalThis.document; }
});

test('passing on keeps only the new note: the old one was for someone else', async () => {
  const { store, map, branch, act } = await setup();
  let saved = await act({ type: 'assign', to: 'Ana', note: 'For Ana.' });
  const item = openAssignment(saved, branch.id);
  saved = await act({ type: 'pass-assignment', assignmentId: item.id, to: 'Gus' });
  assert.equal(openAssignment(saved, branch.id).note, undefined);
  saved = await act({ type: 'pass-assignment', assignmentId: item.id, to: 'Hal', note: 'For Hal.' });
  assert.equal(openAssignment(saved, branch.id).note, 'For Hal.');
  assert.deepEqual(validateMap(await store.get(map.id)).errors, []);
});

test('a hand-edited or newer assignments block the views cannot read is refused, never overwritten', async () => {
  const base = async () => { const { store, map, branch, act } = await setup(); await act({ type: 'assign', to: 'Ana', note: 'Look.' }); await act({ type: 'take-assignment', assignmentId: openAssignment(await store.get(map.id), branch.id).id }, ana); return { map: await store.get(map.id), branch }; };
  const { map, branch } = await base();
  assert.equal(readProblem(map), null);
  const broken = [
    ['a newer version', m => { m.assignments.version = 2; }, 'assignments'],
    ['items not a list', m => { m.assignments.items = {}; }, 'assignments'],
    ['an item that is not a record', m => { m.assignments.items.push(null); }, 'assignments.items[1]'],
    ['no events', m => { delete m.assignments.items[0].events; }, 'assignments.items[0].events'],
    ['an event that is not a record', m => { m.assignments.items[0].events.push(null); }, 'assignments.items[0].events[2]'],
    ['an event by someone without a name', m => { m.assignments.items[0].events[0].by = { name: 3 }; }, 'assignments.items[0].events[0].by'],
    ['a note that is not text', m => { m.assignments.items[0].note = 7; }, 'assignments.items[0].note'],
    ['who it is for, not text', m => { m.assignments.items[0].requestedFor = ['Ana']; }, 'assignments.items[0].requestedFor'],
    ['taken by someone without a name', m => { m.assignments.items[0].takenBy = {}; }, 'assignments.items[0].takenBy'],
    ['an ID that is not text', m => { m.assignments.items[0].id = 5; }, 'assignments.items[0].id'],
  ];
  for (const [name, spoil, at] of broken) {
    const copy = structuredClone(map); spoil(copy);
    assert.equal(readProblem(copy), 'invalid-map', name);
    assert.ok(validateMap(copy).errors.some(error => error.at === at && error.unreadable), `${name}: reported at ${at}`);
  }
  const listed = [
    ['an ID used twice', m => { m.assignments.items.push({ ...structuredClone(m.assignments.items[0]), status: 'done' }); }, 'duplicate-id', 'assignments.items[1].id'],
    ['an idea that does not exist', m => { m.assignments.items[0].nodeId = 'node-gone0000'; }, 'missing-node', 'assignments.items[0].nodeId'],
    ['two open requests on one idea', m => { m.assignments.items.push({ ...structuredClone(m.assignments.items[0]), id: 'assignment-other00' }); }, 'duplicate-open-assignment', 'assignments.items[1]'],
    ['an unknown status', m => { m.assignments.items[0].status = 'lost'; }, 'unknown-value', 'assignments.items[0].status'],
  ];
  for (const [name, spoil, code, at] of listed) {
    const copy = structuredClone(map); spoil(copy);
    assert.equal(readProblem(copy), null, `${name}: reported, the map still opens`);
    assert.ok(validateMap(copy).errors.some(error => error.code === code && error.at === at), `${name}: ${code} at ${at}`);
  }
  assert.deepEqual(assignmentsOf({ assignments: { items: [null, 3, [], { id: 'x' }, { id: 'y', events: [] }] } }).map(item => item.id), ['y'], 'the views skip what they cannot read');
  assert.equal(openAssignment(map, branch.id).takenBy.name, 'Ana');
});

test('Undo and restore name assignment changes; restarting or restoring a branch drops requests on the ideas it removes', async () => {
  for (const [label, words] of [['assignment-requested', 'Someone asked to look at a branch'], ['assignment-taken', 'Request taken'], ['assignment-passed', 'Request passed on'], ['assignment-done', 'Request marked done']]) assert.equal(versionLabel({ labels: [label] }), words);
  const { store, map, branch, act } = await setup();
  const before = await store.get(map.id), after = await act({ type: 'assign', to: 'Ana' });
  const counts = compareVersion(after, before, () => false).counts;
  assert.equal(counts.assignmentsChanged, 1); assert.equal(counts.nodesChanged, 0);
  assert.match(restoreSummary({ counts, reopened: [] }, { undo: true }), /^Undoing changes who is asked to look at branches\. /);
  const { versions } = await store.versions.list(map.id);
  assert.equal(versions[0].labels[0], 'assignment-requested', 'the version is labelled by it');
  // Restoring the branch from before it had a direction removes that direction, and the request to look at it.
  const version = versions.find(entry => entry.revision === after.revision);
  await act({ type: 'complete-assignment', assignmentId: openAssignment(after, branch.id).id });
  await act({ type: 'activate' });
  const run = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Phones hold a week.', body: 'Fixture.', suggestions: [{ title: 'Cache', body: 'What to keep.' }] });
  const cache = saved.nodes.find(node => node.title === 'Cache');
  saved = await store.action(map.id, { expectedRevision: saved.revision, nodeId: cache.id, type: 'assign', to: 'Cy' }, { actor: ben });
  saved = await store.action(map.id, { expectedRevision: saved.revision, nodeId: cache.id, type: 'comment', text: 'About the cache.' }, { actor: ben }); // H6: a discussion goes with it too.
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: branch.id });
  assert.deepEqual([preview.counts.requestsRemoved, preview.counts.discussionsRemoved], [1, 1]);
  assert.match(branchRestoreHtml(preview, { esc }), /1 idea added since this version removed, with 1 open request to look at them and 1 open discussion/);
  const restored = await store.action(map.id, { expectedRevision: saved.revision, type: 'restore-branch', nodeId: branch.id, version: version.id, previewHash: preview.hash }, { actor: ben });
  assert.equal(restored.nodes.some(node => node.id === cache.id), false);
  assert.equal(assignmentsOf(restored).some(item => item.nodeId === cache.id), false, 'its request went with it');
  assert.equal((restored.discussions?.threads ?? []).some(thread => thread.nodeId === cache.id), false, 'and its discussion');
  assert.equal(assignmentsOf(restored).filter(item => item.nodeId === branch.id).length, 1, 'requests elsewhere stay as they are now');
  assert.deepEqual(validateMap(restored).errors, []);
});

test('the Markdown view quotes a note line by line and keeps every name literal', () => {
  const map = { assignments: { version: 1, items: [{ id: 'assignment-1', nodeId: 'node-a', requestedFor: 'Ana *bold*', note: 'Line one.\n\nLine _two_ <b>.', status: 'taken', takenBy: { name: 'Cy [link](x)' }, events: [{ at: '2026-11-04T10:00:00.000Z', type: 'requested', by: { name: 'Ben #1' }, to: 'Ana *bold*' }] }] } };
  assert.deepEqual(assignmentLines(map, { id: 'node-a' }), ['', '_Requested for Ana \\*bold\\* by Ben \\#1 · 2026-11-04; taken by Cy \\[link\\](x)._', '', '> Line one.', '>', '> Line \\_two\\_ \\<b\\>.']);
  assert.deepEqual(assignmentLines(map, { id: 'node-b' }), []);
});
