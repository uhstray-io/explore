import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { presentationOnly } from '../skills/explore/scripts/versions.mjs';

import { shownNodes } from '../skills/explore/assets/workspace-view.js';
import { mapAtGrowthStep } from '../skills/explore/assets/history.js';
import { foldMenuItems, hiddenLabel, branchBarHtml, revealPlan } from '../skills/explore/assets/folds.js';

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

test('folds hide every descendant and count what needs the user; nested folds and unknown IDs are fine', () => {
  const map = fixture(), before = structuredClone(map);
  assert.deepEqual(ids(shownNodes(map).shown), ids(map.nodes.map(node => node.id)), 'nothing folded shows everything');
  const { shown, hiddenBelow } = shownNodes(map, { folded: ['a', 'a1', 'nope'] });
  assert.deepEqual(ids(shown), ['b', 'b1', 'b1x', 'lost', 'lost1', 'root', 'a'].sort());
  assert.deepEqual(hiddenBelow.get('a'), { total: 3, needsAnswer: 1, needsReview: 0, working: 0 });
  assert.equal(hiddenBelow.has('a1'), false, 'a fold inside a hidden branch has no marker');
  assert.deepEqual(shownNodes(map, { folded: ['b'] }).hiddenBelow.get('b'), { total: 2, needsAnswer: 0, needsReview: 1, working: 1 });
  assert.deepEqual(ids(shownNodes(map, { folded: ['root'] }).shown), ['lost', 'lost1', 'root'], 'the starting idea is never hidden; unconnected ideas stay');
  assert.deepEqual(map, before, 'reading never changes the map');
});

test('branch focus shows the starting idea, the path and the subtree; folds apply inside it only', () => {
  const map = fixture();
  assert.deepEqual(ids(shownNodes(map, { focus: 'a1' }).shown), ['a', 'a1', 'a1x', 'root']);
  assert.deepEqual(ids(shownNodes(map, { focus: 'a1', folded: ['a', 'a1'] }).shown), ['a', 'a1', 'root'], 'a fold on the path is ignored; one inside applies');
  assert.deepEqual(ids(shownNodes(map, { focus: 'missing' }).shown).length, 10, 'an unknown focus shows the whole map');
});

test('a growth step folds only the ideas it has', () => {
  const step = mapAtGrowthStep(fixture(), 3);
  assert.deepEqual(ids(shownNodes(step, { folded: ['a'] }).shown), ['a', 'root']);
  assert.deepEqual(shownNodes(step, { folded: ['a'] }).hiddenBelow.get('a'), { total: 2, needsAnswer: 0, needsReview: 0, working: 0 }, 'a2 is not there yet');
});

test('the marker and label say how many ideas are hidden and which need the user', () => {
  assert.equal(hiddenLabel({ total: 1, needsAnswer: 0, needsReview: 0, working: 0 }), '1 hidden direction');
  assert.equal(hiddenLabel({ total: 5, needsAnswer: 1, needsReview: 2, working: 1 }), '5 hidden directions, 1 needs your answer, 2 need review');
});

test('the idea menu offers hiding or showing its directions and one branch, and the bar returns to the whole map', () => {
  const map = fixture(), view = shownNodes(map, { folded: ['b'] });
  const items = (node, options) => foldMenuItems(map.nodes.find(item => item.id === node), { esc, map, view, folded: ['b'], focus: null, live: true, ...options });
  assert.match(items('a'), /data-fold="a"[^>]*>Hide its directions \(3\)</);
  assert.match(items('b'), /data-unfold="b"[^>]*>Show its directions</);
  assert.doesNotMatch(items('a2'), /directions/, 'an idea without directions has nothing to hide');
  assert.match(items('a'), /data-branch-focus="a"[^>]*>Show only this branch</);
  assert.match(items('a', { focus: 'a' }), /data-branch-focus=""[^>]*>Show whole map</);
  assert.doesNotMatch(items('a', { live: false }), /data-fold/, 'folds are read-only in growth history');
  assert.match(items('a', { live: false }), /Show only this branch/, 'branch focus works there');
  assert.equal(branchBarHtml(map, null, { esc }), '');
  assert.match(branchBarHtml({ ...map, nodes: [...map.nodes.slice(0, 1), { ...map.nodes[1], title: 'Sync <fast>' }] }, 'a', { esc }), /Showing one branch: <strong>Sync &lt;fast&gt;<\/strong>[\s\S]*<button type="button"[^>]*data-branch-focus=""[^>]*>Show whole map<\/button>/);
});

test('revealing a hidden idea leaves branch focus if needed and unfolds only its folded ancestors', () => {
  const map = fixture();
  assert.deepEqual(revealPlan(map, 'a1x', { folded: ['a', 'a1', 'b'], focus: null }), { leaveFocus: false, unfold: true });
  assert.deepEqual(revealPlan(map, 'b1', { folded: [], focus: 'a' }), { leaveFocus: true, unfold: false });
  assert.deepEqual(revealPlan(map, 'a', { folded: ['a'], focus: null }), { leaveFocus: false, unfold: false }, 'a folded idea itself is shown');
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

test('a fold is saved with the map as view state: no idea, edge, history event or version changes, and reveal unfolds', async () => {
  const { store, map, act, child } = await workspace();
  const before = await store.get(map.id), versions = (await store.versions.list(map.id)).versions.length, bytes = await readFile(store.file(map.id));
  let saved = await act({ type: 'fold', nodeId: child.id, collapsed: true });
  assert.deepEqual(saved.view.collapsed, [child.id]);
  assert.deepEqual(saved.nodes, before.nodes); assert.deepEqual(saved.edges, before.edges); assert.deepEqual(saved.history, before.history); assert.deepEqual(saved.jobs, before.jobs);
  assert.equal((await store.versions.list(map.id)).versions.length, versions, 'no version is recorded');
  assert.ok(presentationOnly(bytes, await readFile(store.file(map.id))), 'a teammate\'s fold is not an outside change');
  await assert.rejects(act({ type: 'fold', nodeId: saved.nodes.find(node => node.title === 'Conflicts').id, collapsed: true }), error => error.status === 400 && /no directions/.test(error.message));
  await assert.rejects(act({ type: 'fold', nodeId: child.id, collapsed: 'yes' }), error => error.status === 400);
  const grandchild = saved.nodes.find(node => node.title === 'Conflicts');
  saved = await act({ type: 'reveal', nodeId: grandchild.id });
  assert.equal(Object.hasOwn(saved.view, 'collapsed'), false, 'revealing unfolds its folded ancestors; an empty list is removed');
  saved = await act({ type: 'fold', nodeId: child.id, collapsed: true });
  saved = await act({ type: 'fold', nodeId: child.id, collapsed: false });
  assert.equal(Object.hasOwn(saved.view, 'collapsed'), false);
});
