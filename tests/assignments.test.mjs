import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { mapOverview } from '../skills/explore/assets/workspace-view.js';
import { assignmentCardHtml, assignFormHtml, assignmentRequest, assignmentClick, assignedFilter, openAssignment } from '../skills/explore/assets/assignments.js';

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
// Everything an assignment must leave alone.
const untouched = map => JSON.stringify([map.nodes.map(({ id, status, reviewState, stale, contentRevision, questions }) => ({ id, status, reviewState, stale, contentRevision, questions })), map.edges, map.jobs, map.growth]);

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

test('the card shows the request as literal text, Take it while nobody has, Pass on and Mark done in its menu, and nothing to do in history', () => {
  const map = { nodes: [{ id: 'node-a', title: 'A' }], assignments: { version: 1, items: [{ id: 'assignment-1', nodeId: 'node-a', requestedFor: 'Ana <b>', note: 'Look <here>.', status: 'requested', events: [{ at: '2026-11-04T10:00:00.000Z', type: 'requested', by: { name: 'Ben & co' }, to: 'Ana <b>', note: 'Look <here>.' }] }] } };
  const node = map.nodes[0];
  let html = assignmentCardHtml(map, node, { esc, live: true, drafts: { 'assignment-pass:node-a-to': 'Cy <i>' } });
  assert.match(html, /<strong>Requested for Ana &lt;b&gt; by Ben &amp; co · [^<]+<\/strong>/); assert.match(html, /<p class="assignment-note">Look &lt;here&gt;\.<\/p>/);
  assert.match(html, /data-assignment-take="assignment-1" data-node-id="node-a">Take it<\/button>/);
  assert.match(html, /role="menu"[\s\S]*data-assignment-pass="assignment-1"[^>]*>Pass on<\/button>[\s\S]*data-assignment-done="assignment-1"[^>]*>Mark done<\/button>/);
  assert.match(html, /value="Cy &lt;i&gt;"/, 'a draft survives a redraw'); assert.match(html, /<details class="assignment-history"><summary>History \(1\)<\/summary>/);
  assert.equal(assignFormHtml(map, node, { esc, live: true }), '', 'no second request while one is open');
  assert.doesNotMatch(assignmentCardHtml(map, node, { esc, live: false }), /data-assignment-|<form/, 'nothing to do in history, even while it waits');
  map.assignments.items[0] = { ...map.assignments.items[0], status: 'taken', takenBy: { name: 'Ana' } };
  html = assignmentCardHtml(map, node, { esc, live: true });
  assert.doesNotMatch(html, /Take it/); assert.match(html, /Taken by Ana\./);
  const history = assignmentCardHtml(map, node, { esc, live: false });
  assert.doesNotMatch(history, /data-assignment-|<form/); assert.match(history, /Requested for Ana/);
  map.assignments.items[0].status = 'done';
  assert.equal(assignmentCardHtml(map, node, { esc, live: true }), '');
  assert.match(assignFormHtml(map, node, { esc, live: true, drafts: { 'assign:node-a-to': 'Dee' } }), /<summary>Ask someone to look at this branch<\/summary>[\s\S]*data-draft="assign:node-a-to" value="Dee"/);
  assert.equal(assignFormHtml(map, node, { esc, live: false }), '');
  assert.deepEqual(assignmentRequest({ id: 'assign-form', dataset: {} }, { to: 'Ana', note: ' ' }), { type: 'assign', input: { to: 'Ana' } });
  assert.deepEqual(assignmentRequest({ id: '', dataset: { passForm: 'assignment-1' } }, { to: 'Cy', note: 'Hi.' }), { type: 'pass-assignment', input: { assignmentId: 'assignment-1', to: 'Cy', note: 'Hi.' } });
  assert.equal(assignmentRequest({ id: 'suggest-form', dataset: {} }, {}), null);
});

test('Take it, Pass on and Mark done act through the app; Pass on opens its form', async () => {
  const calls = [], toasts = [], state = { editors: {} }; let rendered = 0;
  const ctx = { state, act: async (...args) => { calls.push(args); return true; }, toast: message => toasts.push(message), renderDetail: () => rendered++ };
  const click = dataset => assignmentClick({ target: { closest: selector => { const name = selector.match(/^\[data-([a-z-]+)\]$/)[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return name in dataset ? { dataset, disabled: false } : null; } } }, ctx);
  globalThis.document = { querySelector: () => null };
  try {
    assert.equal(await click({ assignmentTake: 'assignment-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'take-assignment', { assignmentId: 'assignment-1' }]);
    assert.equal(await click({ assignmentPass: 'assignment-1', nodeId: 'node-a' }), true);
    assert.equal(state.editors['node-a:assignment-pass'], true); assert.equal(rendered, 1); assert.equal(calls.length, 1, 'opening the form saves nothing');
    assert.equal(await click({ assignmentDone: 'assignment-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'complete-assignment', { assignmentId: 'assignment-1' }]);
    assert.equal(await click({ explore: 'node-a' }), false, 'other clicks are left alone');
  } finally { delete globalThis.document; }
});
