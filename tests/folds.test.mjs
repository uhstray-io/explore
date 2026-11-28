import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { presentationOnly } from '../skills/explore/scripts/versions.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { tidyFolds } from '../skills/explore/scripts/folds.mjs';
import { shownNodes } from '../skills/explore/assets/workspace-view.js';
import { mapAtGrowthStep } from '../skills/explore/assets/history.js';
import { foldMenuItems, hiddenLabel, branchBarHtml, revealPlan, shownSelection, foldsPanel } from '../skills/explore/assets/folds.js';

// Collapse and focus branches (Z6, #64). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const day = n => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`;
const idea = (id, parentId, extra = {}) => ({ id, parentId, kind: 'idea', title: `Idea ${id}`, status: 'suggested', reviewState: 'unreviewed', questions: [], sources: [], createdAt: day(1), ...extra });
//   root ─ a ─ a1 ─ a1x
//        │    └ a2 (needs your answer)
//        └ b ─ b1 (stale) ─ b1x (queued)
//   lost (parent gone) ─ lost1
const fixture = () => ({ id: 'map-1', rootId: 'root', edges: [], nodes: [
  idea('root', null), idea('a', 'root', { createdAt: day(2) }), idea('a1', 'a', { createdAt: day(3) }), idea('a1x', 'a1', { createdAt: day(4) }),
  idea('a2', 'a', { status: 'awaiting-answer', createdAt: day(5) }), idea('b', 'root', { createdAt: day(6) }), idea('b1', 'b', { stale: true, createdAt: day(7) }),
  idea('b1x', 'b1', { status: 'queued', createdAt: day(8) }), idea('lost', 'gone', { createdAt: day(9) }), idea('lost1', 'lost', { createdAt: day(10) }),
] });
const ids = set => [...set].sort();

test('folds hide every descendant and count what needs the user; nested folds and unknown or malformed IDs are fine', () => {
  const map = fixture(), before = structuredClone(map);
  assert.deepEqual(ids(shownNodes(map).shown), ids(map.nodes.map(node => node.id)), 'nothing folded shows everything');
  const view = shownNodes(map, { folded: ['a', 'a1', 'nope', 7] });
  assert.deepEqual(ids(view.shown), ['a', 'b', 'b1', 'b1x', 'lost', 'lost1', 'root']);
  assert.deepEqual(view.hiddenBelow.get('a'), { total: 3, needsAnswer: 1, needsReview: 0, working: 0 });
  assert.equal(view.hiddenBelow.has('a1'), false, 'a fold inside a hidden branch has no marker');
  assert.deepEqual(shownNodes(map, { folded: ['b'] }).hiddenBelow.get('b'), { total: 2, needsAnswer: 0, needsReview: 1, working: 1 });
  assert.deepEqual(ids(shownNodes(map, { folded: ['root'] }).shown), ['lost', 'lost1', 'root'], 'the starting idea is never hidden; unconnected ideas stay');
  assert.deepEqual(ids(shownNodes(map, { folded: { a: true } }).shown).length, 10, 'a malformed list folds nothing');
  assert.deepEqual(map, before, 'reading never changes the map');
});

test('ideas in a loop of parents stay shown, and folding inside the loop ends', () => {
  const map = { rootId: 'root', edges: [], nodes: [idea('root', null), idea('a', 'root'), idea('p', 'q'), idea('q', 'r'), idea('r', 'p')] };
  assert.deepEqual(ids(shownNodes(map).shown), ['a', 'p', 'q', 'r', 'root']);
  assert.deepEqual(ids(shownNodes(map, { folded: ['p'] }).shown), ['a', 'p', 'root']);
});

test('branch focus shows the starting idea, the path and the subtree; folds on the path are locked and ignored', () => {
  const map = fixture();
  assert.deepEqual(ids(shownNodes(map, { focus: 'a1' }).shown), ['a', 'a1', 'a1x', 'root']);
  const view = shownNodes(map, { focus: 'a1', folded: ['a', 'a1'] });
  assert.deepEqual(ids(view.shown), ['a', 'a1', 'root']); assert.deepEqual(ids(view.locked), ['a', 'root']); assert.deepEqual(ids(view.folded), ['a1']); assert.equal(view.focus, 'a1');
  assert.deepEqual(ids(shownNodes(map, { focus: 'missing' }).shown).length, 10, 'an unknown focus shows the whole map');
});

test('a growth step folds only the ideas it has', () => {
  const step = mapAtGrowthStep(fixture(), 3);
  assert.deepEqual(ids(shownNodes(step, { folded: ['a'] }).shown), ['a', 'root']);
  assert.deepEqual(shownNodes(step, { folded: ['a'] }).hiddenBelow.get('a'), { total: 2, needsAnswer: 0, needsReview: 0, working: 0 }, 'a2 is not there yet');
});

test('the marker and label say how many ideas are hidden and which need the user', () => {
  assert.equal(hiddenLabel({ total: 1, needsAnswer: 0, needsReview: 0, working: 0 }), '1 hidden direction');
  assert.equal(hiddenLabel({ total: 5, needsAnswer: 1, needsReview: 2, working: 1 }), '5 hidden directions, 1 needs your answer, 2 need review, 1 queued or being explored');
});

test('the idea menu reads the view: no fold offered where it cannot change, and branch focus everywhere but the start', () => {
  const map = fixture(), items = (node, view, live = true) => foldMenuItems(map.nodes.find(item => item.id === node), { esc, map, view, live });
  const plain = shownNodes(map, { folded: ['b'] });
  assert.match(items('a', plain), /data-fold="a"[^>]*>Hide its directions \(3\)</); assert.match(items('b', plain), /data-unfold="b"[^>]*>Show its directions</);
  assert.doesNotMatch(items('a2', plain), /directions/, 'an idea without directions has nothing to hide');
  assert.match(items('a', plain), /data-branch-focus="a"[^>]*>Show only this branch</); assert.doesNotMatch(items('root', plain), /data-branch-focus/);
  const focused = shownNodes(map, { focus: 'a1', folded: ['a'] });
  assert.doesNotMatch(items('root', focused), /directions/, 'the starting idea cannot fold while one branch is shown');
  assert.doesNotMatch(items('a', focused), /directions/, 'nor can an idea on the path, folded or not');
  assert.match(items('a1', focused), /data-fold="a1"/); assert.match(items('a1', focused), /data-branch-focus=""[^>]*>Show whole map</);
  assert.doesNotMatch(items('a', plain, false), /data-fold/, 'growth history never saves a fold'); assert.match(items('a', plain, false), /Show only this branch/);
  assert.match(items('b', plain, false), /data-unfold="b"[^>]*>Show its directions</, 'but a folded idea can be opened there');
  assert.match(foldMenuItems(map.nodes[1], { esc, map, live: true }), /data-fold="a"/, 'without a view, nothing is folded');
  assert.equal(branchBarHtml(map, null, { esc }), '');
  assert.match(branchBarHtml({ ...map, nodes: [...map.nodes.slice(0, 1), { ...map.nodes[1], title: 'Sync <fast>' }] }, 'a', { esc }), /Showing one branch: <strong>Sync &lt;fast&gt;<\/strong>[\s\S]*data-branch-focus=""[^>]*>Show whole map<\/button>/);
});

test('revealing leaves branch focus if needed and unfolds only folded ancestors; a hidden selection moves to the folded idea', () => {
  const map = fixture();
  assert.deepEqual(revealPlan(map, 'a1x', { folded: ['a', 'a1', 'b'], focus: null }), { leaveFocus: false, unfold: true });
  assert.deepEqual(revealPlan(map, 'b1', { folded: [], focus: 'a' }), { leaveFocus: true, unfold: false });
  assert.deepEqual(revealPlan(map, 'a', { folded: ['a'], focus: null }), { leaveFocus: false, unfold: false }, 'a folded idea itself is shown');
  const view = shownNodes(map, { folded: ['a'] });
  assert.equal(shownSelection(map, view, 'a1x'), 'a'); assert.equal(shownSelection(map, view, 'b1'), 'b1'); assert.equal(shownSelection(map, view, null), null);
});

// The panel on a fake page: the bar, the selection and the address, revealing live and read-only, and the clicks.
function panel({ historic = false, folded = [], selected = 'root' } = {}) {
  const map = fixture(); map.view = { positions: {}, collapsed: folded };
  const io = { acts: [], addresses: 0, redraws: 0, fits: 0, focused: [], toasts: [] }, bar = { innerHTML: '', hidden: true };
  const state = { map, visibleMap: map, selected, historyStep: historic ? 2 : null, historySource: historic ? map : null, branchFocus: null };
  let folds;
  // The Store's answer to an action, after a round trip: a new map, drawn again as renderMap would.
  const act = async (id, type, extra = {}) => {
    io.acts.push([id, type, extra]);
    await new Promise(resolve => setImmediate(resolve)); // The map changes only when the save returns.
    const next = structuredClone(state.map), list = next.view.collapsed ?? [];
    if (type === 'fold') next.view.collapsed = extra.collapsed ? [...list, id] : list.filter(item => item !== id);
    if (type === 'reveal') { const above = new Set(); for (let at = next.nodes.find(n => n.id === id); at?.parentId; at = next.nodes.find(n => n.id === at.parentId)) above.add(at.parentId); next.view.collapsed = list.filter(item => !above.has(item)); }
    state.map = state.visibleMap = next; state.view = folds.render();
    return true;
  };
  folds = foldsPanel({ $: () => bar, esc, state, act, toast: message => io.toasts.push(message), closeMenus() {}, redraw: () => { io.redraws++; state.view = folds.render(); },
    fitMap: () => io.fits++, focusNode: id => io.focused.push(id), showAddress: () => io.addresses++ });
  state.view = folds.render();
  const click = target => folds.click({ target: { closest: selector => (target[selector] ? target.element : null) } });
  return { folds, state, io, bar, click };
}

test('Left in the outline on the parent of the selection selects the folded idea and writes the address; a double press saves once', async () => {
  const p = panel({ selected: 'a1x' });
  const first = p.folds.view(); assert.equal(p.folds.view(), first, 'the same view while nothing changed');
  assert.equal(p.folds.foldRow('a', true), true); assert.equal(p.folds.foldRow('a', true), true, 'the second press is taken as on its way');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.io.acts, [['a', 'fold', { collapsed: true }]], 'one save');
  assert.equal(p.state.selected, 'a'); assert.equal(p.io.addresses, 1, 'the address names the folded idea, so a reload keeps the fold');
  assert.notEqual(p.folds.view(), first);
  await p.click({ '[data-fold], [data-unfold]': true, element: { dataset: { unfold: 'a' } } });
  assert.deepEqual(p.io.acts.at(-1), ['a', 'fold', { collapsed: false }]); assert.match(p.io.toasts.at(-1), /shown/);
  await p.click({ '[data-branch-focus]': true, element: { dataset: { branchFocus: 'b' } } });
  assert.equal(p.state.branchFocus, 'b'); assert.equal(p.io.fits, 1); assert.match(p.bar.innerHTML, /Showing one branch: <strong>Idea b/); assert.equal(p.bar.hidden, false);
  assert.equal(p.folds.foldRow('root', true), false, 'the start cannot fold while one branch is shown');
  assert.equal(p.folds.foldRow('b', false), false, 'nothing to change');
  assert.equal(p.folds.foldRow('b', true), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.io.acts.at(-1), ['b', 'fold', { collapsed: true }]);
});

test('revealing saves the unfold while live, but in a read-only view opens the fold in this browser only, until live again', async () => {
  let p = panel({ folded: ['a'] });
  await p.folds.reveal('a1x');
  assert.deepEqual(p.io.acts, [['a1x', 'reveal', {}]]); assert.deepEqual(p.io.focused, ['a1x']);
  p = panel({ folded: ['a'], historic: true });
  await p.folds.reveal('a1x');
  assert.deepEqual(p.io.acts, [], 'nothing is saved from history'); assert.ok(p.folds.view().shown.has('a1x')); assert.deepEqual(p.io.focused, ['a1x']);
  assert.equal(p.folds.foldRow('root', true), false, 'history never saves a fold');
  const q = panel({ folded: ['a', 'b'], historic: true });
  assert.equal(q.folds.foldRow('a', false), true, 'Right opens a folded idea in this browser'); assert.ok(q.folds.view().shown.has('a1'));
  await q.click({ '[data-fold], [data-unfold]': true, element: { dataset: { unfold: 'b' } } });
  assert.ok(q.folds.view().shown.has('b1'), 'the menu opens another folded idea there');
  assert.deepEqual(q.io.acts, [], 'neither saves anything');
  p.state.historyStep = null; p.state.historySource = null; p.folds.render();
  assert.equal(p.folds.view().shown.has('a1x'), false, 'back to live, the saved fold applies again');
});

async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'folds-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const act = async fields => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...fields });
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Sync', body: 'How edits sync.' });
  const saved = await store.get(map.id), child = saved.nodes.find(node => node.id !== map.rootId);
  await act({ type: 'suggest', nodeId: child.id, title: 'Conflicts', body: 'When edits clash.' });
  return { store, map, act, child };
}

test('a fold is saved with the map as view state: no idea, edge, history event or version changes; saves that change nothing are refused', async () => {
  const { store, map, act, child } = await workspace();
  const before = await store.get(map.id), versions = (await store.versions.list(map.id)).versions.length, bytes = await readFile(store.file(map.id));
  let saved = await act({ type: 'fold', nodeId: child.id, collapsed: true });
  assert.deepEqual(saved.view.collapsed, [child.id]);
  assert.deepEqual(saved.nodes, before.nodes); assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.history, before.history); assert.deepEqual(saved.jobs, before.jobs);
  assert.equal((await store.versions.list(map.id)).versions.length, versions, 'no version is recorded');
  assert.ok(presentationOnly(bytes, await readFile(store.file(map.id))), 'a teammate\'s fold is not an outside change');
  await assert.rejects(act({ type: 'fold', nodeId: child.id, collapsed: true }), error => error.status === 409 && /already hidden/.test(error.message));
  const grandchild = saved.nodes.find(node => node.title === 'Conflicts');
  await assert.rejects(act({ type: 'fold', nodeId: grandchild.id, collapsed: true }), error => error.status === 400 && /no directions/.test(error.message));
  await assert.rejects(act({ type: 'fold', nodeId: child.id, collapsed: 'yes' }), error => error.status === 400);
  saved = await act({ type: 'reveal', nodeId: grandchild.id });
  assert.equal(Object.hasOwn(saved.view, 'collapsed'), false, 'revealing unfolds its folded ancestors; an empty list is removed');
  await assert.rejects(act({ type: 'reveal', nodeId: grandchild.id }), error => error.status === 409 && /already shown/.test(error.message));
  await assert.rejects(act({ type: 'fold', nodeId: child.id, collapsed: false }), error => error.status === 409);
});

test('map reads report a malformed fold list, and a restart drops folds of ideas gone or left without directions', () => {
  const map = { ...fixture(), schemaVersion: 1, title: 'Field notebook', revision: 1, updatedAt: 'x', history: [], jobs: [], view: { positions: {}, collapsed: { a: true } } };
  assert.ok(validateMap(map).errors.some(error => error.at === 'view.collapsed' && !error.unreadable));
  const restarted = fixture(); restarted.view = { positions: {}, collapsed: ['a', 'a1', 'gone', 'b'] };
  restarted.nodes = restarted.nodes.filter(node => !['a1x', 'a2', 'b1', 'b1x'].includes(node.id)); // b and a1 lost their directions.
  tidyFolds(restarted);
  assert.deepEqual(restarted.view.collapsed, ['a']);
});
