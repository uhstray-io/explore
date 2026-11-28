import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { downstreamOf } from '../skills/explore/assets/graph.js';
import { impactIndex, impactPath, impactContext, impactBands, impactHtml } from '../skills/explore/assets/impact.js';
import { mapOverview } from '../skills/explore/assets/workspace-view.js';

// Impact level and critical paths (D4, #19). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const idea = (id, parentId, extra = {}) => ({ id, parentId, kind: 'idea', title: `Idea ${id}`, status: 'explored', reviewState: 'unreviewed', questions: [], sources: [], ...extra });
const contains = (from, to) => ({ from, to, type: 'contains' });
const dependsOn = (dependent, prerequisite) => ({ from: dependent, to: prerequisite, type: 'depends_on' });
const sorted = list => [...list].sort();

test('a change reaches what the Store flags for review: revising an idea changes exactly the ideas impact lists, and that idea', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'impact-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const act = async fields => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...fields });
  const add = async (parent, title) => { const saved = await act({ type: 'suggest', nodeId: parent, title, body: `${title}.` }); return saved.nodes.at(-1).id; };
  const a = await add(map.rootId, 'Sync'), b = await add(map.rootId, 'Storage'), a1 = await add(a, 'Conflicts'), c = await add(b, 'Quotas');
  await act({ type: 'link', nodeId: b, to: a1, relation: 'depends_on' }); // Storage depends on Conflicts.
  await act({ type: 'link', nodeId: a, to: c, relation: 'supports' }); // Not a dependency: never spreads a change.
  const before = await store.get(map.id);
  const expected = impactIndex(before)[a].affected;
  const after = await act({ type: 'revise', nodeId: a, body: 'Sync over a mesh.' });
  const changed = after.nodes.filter(node => node.contentRevision !== before.nodes.find(old => old.id === node.id).contentRevision).map(node => node.id);
  assert.deepEqual(sorted(changed), sorted([a, ...expected]));
  assert.deepEqual(sorted(expected), sorted([a1, b, c]));
});

// root ─ a ─ a1 ─ a2      b depends on a1; c depends on b; a2 depends on c (a node reached both ways); x unrelated
const fixture = () => ({ rootId: 'root', nodes: ['root', 'a', 'a1', 'a2', 'b', 'c', 'x'].map(id => idea(id, { a: 'root', a1: 'a', a2: 'a1', b: 'root', c: 'root', x: 'root' }[id] ?? null)),
  edges: [contains('root', 'a'), contains('a', 'a1'), contains('a1', 'a2'), contains('root', 'b'), contains('root', 'c'), contains('root', 'x'), dependsOn('b', 'a1'), dependsOn('c', 'b'), dependsOn('a2', 'c')] });

test('the branch and the dependencies are counted apart, each idea once, and the traversal matches the Store', () => {
  const map = fixture(), before = structuredClone(map), index = impactIndex(map);
  assert.deepEqual(sorted(index.a.inBranch), ['a1', 'a2']); assert.deepEqual(sorted(index.a.throughDependencies), ['b', 'c']);
  assert.deepEqual(sorted(index.a.affected), ['a1', 'a2', 'b', 'c'], 'a2 is reached both ways and counted once');
  assert.deepEqual(sorted(index.b.affected), ['a2', 'c'], 'a dependency-only path, then a mixed one');
  assert.deepEqual(index.x.affected, []);
  for (const node of map.nodes) assert.deepEqual(sorted(index[node.id].affected), sorted([...downstreamOf(map, node.id)].filter(id => id !== node.id)), `${node.id} matches downstreamOf`);
  assert.deepEqual(map, before, 'reading impact never changes the map');
});

test('bands follow the documented thresholds, untouched suggestions do not count, and cycles end', () => {
  const star = (count, extra = {}) => ({ rootId: 'hub', nodes: [idea('hub', null), ...Array.from({ length: count }, (_, i) => idea(`n${i}`, 'hub', extra))], edges: Array.from({ length: count }, (_, i) => contains('hub', `n${i}`)) });
  const fan = count => ({ rootId: 'hub', nodes: [idea('hub', null), ...Array.from({ length: count }, (_, i) => idea(`d${i}`, null))], edges: Array.from({ length: count }, (_, i) => dependsOn(`d${i}`, 'hub')) });
  const band = map => impactIndex(map).hub.band;
  assert.deepEqual([4, 5, 19, 20].map(n => band(star(n))), ['low', 'medium', 'medium', 'high']);
  assert.deepEqual([0, 1, 4, 5].map(n => band(fan(n))), ['low', 'medium', 'medium', 'high']);
  assert.equal(band(star(25, { status: 'suggested' })), 'low', 'untouched suggestions cost little to redo');
  assert.deepEqual(impactBands, { high: { affected: 20, throughDependencies: 5 }, medium: { affected: 5, throughDependencies: 1 } });
  const loop = { rootId: 'p', nodes: [idea('p', null), idea('q', null)], edges: [dependsOn('p', 'q'), dependsOn('q', 'p')] };
  assert.deepEqual(impactIndex(loop).p.affected, ['q'], 'a dependency cycle ends, and an idea never counts itself');
  const mixed = { rootId: 'p', nodes: [idea('p', null), idea('q', 'p'), idea('r', 'q')], edges: [contains('p', 'q'), contains('q', 'r'), dependsOn('p', 'r')] };
  assert.deepEqual(sorted(impactIndex(mixed).p.affected), ['q', 'r']); assert.deepEqual(sorted(impactIndex(mixed).r.affected), ['p', 'q']);
  assert.equal(impactIndex(fixture()).a.open, true); assert.equal(impactIndex({ rootId: 'p', nodes: [idea('p', null, { reviewState: 'accepted' })], edges: [] }).p.open, false);
  assert.equal(impactIndex({ rootId: 'p', nodes: [idea('p', null, { reviewState: 'accepted', stale: true })], edges: [] }).p.open, true, 'an accepted finding that needs review is open');
});

test('a path is one of the shortest, labelled step by step, with ties broken by ID; none when the idea is not affected', () => {
  const map = fixture();
  assert.deepEqual(impactPath(map, 'a', 'c'), [{ from: 'a', to: 'a1', via: 'contains' }, { from: 'a1', to: 'b', via: 'depends on' }, { from: 'b', to: 'c', via: 'depends on' }]);
  assert.deepEqual(impactPath(map, 'a', 'a2'), [{ from: 'a', to: 'a1', via: 'contains' }, { from: 'a1', to: 'a2', via: 'contains' }]);
  const tie = { rootId: 's', nodes: ['s', 'm2', 'm1', 't'].map(id => idea(id, null)), edges: [dependsOn('m2', 's'), dependsOn('m1', 's'), dependsOn('t', 'm2'), dependsOn('t', 'm1')] };
  assert.deepEqual(impactPath(tie, 's', 't').map(step => step.to), ['m1', 't'], 'ties go to the smaller ID');
  assert.equal(impactPath(map, 'x', 'a'), null); assert.equal(impactPath(map, 'a', 'a'), null);
});

test('the filter lists exactly the high-impact ideas still open; dependency chains between them stay as context', () => {
  // h1 and h2 are high impact and open; m (settled) sits on the chain h2 → m → h1; done is settled and off the chain.
  const nodes = [idea('root', null), idea('h1', 'root'), idea('m', 'root', { reviewState: 'accepted' }), idea('h2', 'root'), idea('done', 'root', { reviewState: 'accepted' })];
  const edges = [contains('root', 'h1'), contains('root', 'm'), contains('root', 'h2'), contains('root', 'done'), dependsOn('m', 'h2'), dependsOn('h1', 'm')];
  for (let i = 0; i < 5; i++) { nodes.push(idea(`d${i}`, null)); edges.push(dependsOn(`d${i}`, 'h1'), dependsOn(`d${i}`, 'done')); }
  const map = { rootId: 'root', nodes, edges };
  const group = mapOverview(map).groups.find(item => item.id === 'impact:high-open');
  assert.equal(group.kind, 'impact'); assert.equal(group.short, 'High impact, still open');
  assert.deepEqual(sorted(group.nodes.map(node => node.id)), ['h1', 'h2', 'root'].sort(), 'the accepted, current one is settled');
  assert.deepEqual(sorted(impactContext(map, new Set(['h1', 'h2']))), ['m']);
  assert.deepEqual(sorted(group.context), ['m']);
  assert.match(group.lines(map.nodes.find(node => node.id === 'h1'))[0].text, /^Changing this would affect 5 ideas/);
  assert.equal(mapOverview(map, { impact: false }).groups.some(item => item.kind === 'impact'), false, 'growth history leaves it out');
});

test('the inspector says the band and what a change would reach, and lists the affected ideas with their paths', () => {
  const map = fixture();
  map.nodes.find(node => node.id === 'b').title = 'Storage <fast>';
  for (const id of ['a1', 'b']) Object.assign(map.nodes.find(node => node.id === id), { hasFindings: true });
  const html = impactHtml(map, map.nodes.find(node => node.id === 'a'), { esc });
  assert.match(html, /<h3 class="section-label">Impact<\/h3><p class="impact-band medium">Medium impact<\/p>/);
  assert.match(html, /Changing this would affect 4 ideas: 2 in this branch, 2 elsewhere through dependencies\. 2 have findings that would need review\./);
  assert.match(html, /<details data-editor="impact"><summary>Show affected ideas<\/summary>/);
  assert.match(html, /data-select="b"[^>]*>Storage &lt;fast&gt;<\/button><small>Depends on it · through Idea a1<\/small>/);
  assert.match(html, /data-select="a1"[^>]*>Idea a1<\/button><small>Below it<\/small>/, 'a direct child does not repeat its own title');
  assert.doesNotMatch(html, /<fast>/);
  assert.match(impactHtml(map, map.nodes.find(node => node.id === 'x'), { esc }), /Low impact<\/p><p class="impact-sentence">Changing this affects no other ideas\.<\/p>$/);
});
