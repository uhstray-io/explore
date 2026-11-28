import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { downstreamOf } from '../skills/explore/assets/graph.js';
import { impactIndex, impactOf, impactPath, impactContext, impactBands, impactHtml, impactFilter } from '../skills/explore/assets/impact.js';
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
  const expected = impactOf(before, a).affected;
  const after = await act({ type: 'revise', nodeId: a, body: 'Sync over a mesh.' });
  const changed = after.nodes.filter(node => node.contentRevision !== before.nodes.find(old => old.id === node.id).contentRevision).map(node => node.id);
  assert.deepEqual(sorted(changed), sorted([a, ...expected]));
  assert.deepEqual(sorted(expected), sorted([a1, b, c]));
});

// root ─ a ─ a1 ─ a2      b depends on a1; c depends on b; a2 depends on c (a node reached both ways); x unrelated
const fixture = () => ({ rootId: 'root', nodes: ['root', 'a', 'a1', 'a2', 'b', 'c', 'x'].map(id => idea(id, { a: 'root', a1: 'a', a2: 'a1', b: 'root', c: 'root', x: 'root' }[id] ?? null)),
  edges: [contains('root', 'a'), contains('a', 'a1'), contains('a1', 'a2'), contains('root', 'b'), contains('root', 'c'), contains('root', 'x'), dependsOn('b', 'a1'), dependsOn('c', 'b'), dependsOn('a2', 'c')] });

test('the branch and the dependencies are counted apart, each idea once, and the traversal matches the Store', () => {
  const map = fixture(), before = structuredClone(map), a = impactOf(map, 'a');
  assert.deepEqual(a.inBranch, ['a1', 'a2']); assert.deepEqual(a.throughDependencies, ['b', 'c']);
  assert.deepEqual(a.affected, ['a1', 'a2', 'b', 'c'], 'a2 is reached both ways, counted once and in the branch; nearest first');
  assert.deepEqual(sorted(impactOf(map, 'b').affected), ['a2', 'c'], 'a dependency-only path, then a mixed one');
  assert.deepEqual(impactOf(map, 'x').affected, []);
  for (const node of map.nodes) assert.deepEqual(sorted(impactOf(map, node.id).affected), sorted([...downstreamOf(map, node.id)].filter(id => id !== node.id)), `${node.id} matches downstreamOf`);
  assert.deepEqual(map, before, 'reading impact never changes the map');
});

test('a change passes through an idea missing from the map, as the Store does, and lists only ideas that exist', () => {
  // b depends on a removed idea that depended on a: a Git merge or a hand edit can leave such a link, and the Store
  // still flags b when a changes.
  const map = { rootId: 'a', nodes: [idea('a', null), idea('b', null)], edges: [dependsOn('b', 'gone'), dependsOn('gone', 'a')] };
  assert.deepEqual([...downstreamOf(map, 'a')], ['a', 'gone', 'b']);
  assert.deepEqual(impactOf(map, 'a').affected, ['b']); assert.equal(impactIndex(map).a.band, 'medium');
  assert.match(impactHtml(map, map.nodes[0], { esc }), />Through dependencies: a missing idea<strong>Idea b<\/strong>/);
});

test('bands follow the documented thresholds, untouched suggestions do not count, and cycles end', () => {
  const star = (count, extra = {}) => ({ rootId: 'hub', nodes: [idea('hub', null), ...Array.from({ length: count }, (_, i) => idea(`n${i}`, 'hub', extra))], edges: Array.from({ length: count }, (_, i) => contains('hub', `n${i}`)) });
  const fan = (count, extra = {}) => ({ rootId: 'hub', nodes: [idea('hub', null), ...Array.from({ length: count }, (_, i) => idea(`d${i}`, null, extra))], edges: Array.from({ length: count }, (_, i) => dependsOn(`d${i}`, 'hub')) });
  const band = map => { const quick = impactIndex(map).hub.band; assert.equal(impactOf(map, 'hub').band, quick, 'the index stops early but agrees with the full walk'); return quick; };
  assert.deepEqual([4, 5, 19, 20, 60].map(n => band(star(n))), ['low', 'medium', 'medium', 'high', 'high']);
  assert.deepEqual([0, 1, 4, 5, 60].map(n => band(fan(n))), ['low', 'medium', 'medium', 'high', 'high']);
  assert.equal(band(star(25, { status: 'suggested' })), 'low', 'untouched suggestions cost little to redo');
  assert.equal(band(fan(6, { status: 'suggested' })), 'low', 'nor do they count when reached through dependencies');
  assert.deepEqual([star(20), fan(5), star(19)].map(map => impactIndex(map).hub.reason), ['At least 20 ideas rest on it.', 'At least 5 ideas elsewhere depend on it.', null]);
  assert.deepEqual(impactBands, { high: { affected: 20, throughDependencies: 5 }, medium: { affected: 5, throughDependencies: 1 } });
  const loop = { rootId: 'p', nodes: [idea('p', null), idea('q', null)], edges: [dependsOn('p', 'q'), dependsOn('q', 'p')] };
  assert.deepEqual(impactOf(loop, 'p').affected, ['q'], 'a dependency cycle ends, and an idea never counts itself');
  const mixed = { rootId: 'p', nodes: [idea('p', null), idea('q', 'p'), idea('r', 'q')], edges: [contains('p', 'q'), contains('q', 'r'), dependsOn('p', 'r')] };
  assert.deepEqual(sorted(impactOf(mixed, 'p').affected), ['q', 'r']); assert.deepEqual(sorted(impactOf(mixed, 'r').affected), ['p', 'q']);
  assert.equal(impactIndex(fixture()).a.open, true); assert.equal(impactIndex({ rootId: 'p', nodes: [idea('p', null, { reviewState: 'accepted' })], edges: [] }).p.open, false);
  assert.equal(impactIndex({ rootId: 'p', nodes: [idea('p', null, { reviewState: 'accepted', stale: true })], edges: [] }).p.open, true, 'an accepted finding that needs review is open');
});

test('a path goes down the branch, then along dependencies, each the shortest of its kind with ties by ID; none when not affected', () => {
  const map = fixture();
  assert.deepEqual(impactPath(map, 'a', 'c'), [{ from: 'a', to: 'a1', via: 'contains' }, { from: 'a1', to: 'b', via: 'depends on' }, { from: 'b', to: 'c', via: 'depends on' }]);
  assert.deepEqual(impactPath(map, 'a', 'a2'), [{ from: 'a', to: 'a1', via: 'contains' }, { from: 'a1', to: 'a2', via: 'contains' }], 'in the branch, though c also reaches it');
  const tie = { rootId: 's', nodes: ['s', 'm2', 'm1', 't'].map(id => idea(id, null)), edges: [dependsOn('m2', 's'), dependsOn('m1', 's'), dependsOn('t', 'm2'), dependsOn('t', 'm1')] };
  assert.deepEqual(impactPath(tie, 's', 't').map(step => step.to), ['m1', 't'], 'ties go to the smaller ID');
  const mixed = { rootId: 'p', nodes: [idea('p', null), idea('q', 'p'), idea('r', 'q')], edges: [contains('p', 'q'), contains('q', 'r'), dependsOn('r', 'p')] };
  assert.deepEqual(impactPath(mixed, 'p', 'r').map(step => step.via), ['contains', 'contains'], 'a branch idea keeps its branch path even when a dependency is shorter');
  assert.equal(impactPath(map, 'x', 'a'), null); assert.equal(impactPath(map, 'a', 'a'), null);
});

test('the filter lists exactly the high-impact ideas still open; dependency chains between them stay as context', () => {
  // h1 and h2 are high impact and open; m (settled) sits on the chain h2 → m → h1; done is settled and off the chain.
  const nodes = [idea('root', null), idea('h1', 'root'), idea('m', 'root', { reviewState: 'accepted' }), idea('h2', 'root'), idea('done', 'root', { reviewState: 'accepted' })];
  const edges = [contains('root', 'h1'), contains('root', 'm'), contains('root', 'h2'), contains('root', 'done'), dependsOn('m', 'h2'), dependsOn('h1', 'm')];
  for (let i = 0; i < 5; i++) { nodes.push(idea(`d${i}`, null)); edges.push(dependsOn(`d${i}`, 'h1'), dependsOn(`d${i}`, 'done')); }
  const map = { rootId: 'root', nodes, edges };
  const group = mapOverview(map, { filters: [impactFilter(map)] }).groups.find(item => item.id === 'impact:high-open');
  assert.equal(group.kind, 'impact'); assert.equal(group.short, 'High impact, still open');
  assert.deepEqual(sorted(group.nodes.map(node => node.id)), ['h1', 'h2', 'root'].sort(), 'the accepted, current one is settled');
  assert.deepEqual(sorted(impactContext(map, new Set(['h1', 'h2']))), ['m']);
  assert.deepEqual(sorted(group.context), ['m']);
  assert.deepEqual(group.lines(map.nodes.find(node => node.id === 'h1')), [{ text: 'At least 5 ideas elsewhere depend on it.' }], 'why it is high, from the index');  assert.equal(mapOverview(map).groups.some(item => item.kind === 'impact'), false, 'only the live map passes it in');
});

test('the inspector says the band and what a change would reach, and lists the affected ideas with how the change gets there', () => {
  const map = fixture();
  map.nodes.find(node => node.id === 'b').title = 'Storage <fast>';
  map.nodes.push(idea('b1', 'b')); map.edges.push(contains('b', 'b1'));
  for (const id of ['a1', 'b']) Object.assign(map.nodes.find(node => node.id === id), { hasFindings: true });
  const html = impactHtml(map, map.nodes.find(node => node.id === 'a'), { esc });
  assert.match(html, /<h3 class="section-label">Impact<\/h3><p class="impact-band medium">Medium impact<\/p>/);
  assert.match(html, /Changing this would affect 5 ideas: 2 in this branch, 3 elsewhere through dependencies\. 2 have findings that would need review\./);
  assert.match(html, /<details data-editor="impact"><summary>Show affected ideas<\/summary>/);
  assert.match(html, /<button type="button" class="relationship" data-select="a1">Below it<strong>Idea a1<\/strong><\/button>/, 'a direct child does not repeat its own title');
  assert.match(html, /data-select="a2">Below it · through Idea a1<strong>/);
  assert.match(html, /data-select="b">Through dependencies: Idea a1<strong>Storage &lt;fast&gt;<\/strong>/);
  assert.match(html, /data-select="b1">Through dependencies: Idea a1 → Storage &lt;fast&gt;<strong>Idea b1<\/strong>/, 'below a dependent is not below this idea');
  assert.doesNotMatch(html, /<fast>/);
  const direct = { rootId: 'p', nodes: [idea('p', null), idea('q', null)], edges: [dependsOn('q', 'p')] };
  assert.match(impactHtml(direct, direct.nodes[0], { esc }), /data-select="q">Depends on it<strong>Idea q<\/strong>/);
  assert.match(impactHtml(map, map.nodes.find(node => node.id === 'x'), { esc }), /Low impact<\/p><p class="impact-sentence">Changing this affects no other ideas\.<\/p>$/);
});

test('the sentence says how many affected ideas are untouched suggestions, which leave the band low', () => {
  const nodes = [idea('hub', null), ...['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((id, i) => idea(id, 'hub', i < 4 ? { status: 'suggested' } : {}))];
  const map = { rootId: 'hub', nodes, edges: nodes.slice(1).map(node => contains('hub', node.id)) };
  const html = impactHtml(map, nodes[0], { esc });
  assert.match(html, /Low impact<\/p><p class="impact-sentence">Changing this would affect 6 ideas: 6 in this branch\. 4 of them are untouched suggestions, which cost little to redo\.<\/p>/);
});

test('affected ideas are listed nearest first, and ideas as near as each other in reading order', () => {
  // The map lists zeta before alpha: reading order, not IDs, breaks the tie.
  const map = { rootId: 'r', nodes: [idea('r', null), idea('zeta', 'r'), idea('alpha', 'r'), idea('deep', 'zeta')], edges: [contains('r', 'zeta'), contains('r', 'alpha'), contains('zeta', 'deep')] };
  assert.deepEqual(impactOf(map, 'r').affected, ['zeta', 'alpha', 'deep']);
});
