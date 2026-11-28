import test from 'node:test';
import assert from 'node:assert/strict';
import { constellationLayout, connectionPath, presentation, overviewView, focusedView, detailLevel, fitView, toScreen, toWorld, viewRect, centredView } from '../skills/explore/assets/graph.js';

test('saved maps lay out deterministically without moving saved nodes or modifying research', () => {
  const map = { rootId: 'root', nodes: [{ id: 'root', status: 'explored' }, { id: 'a', parentId: 'root', status: 'suggested' }, { id: 'b', parentId: 'root', status: 'queued' }], view: { positions: { a: { x: -123.5, y: 410 } } }, jobs: [{ nodeId: 'b', status: 'queued' }] };
  const before = JSON.stringify(map), graph = constellationLayout(map);
  assert.deepEqual(graph.positions.a, { x: -123.5, y: 410 });
  assert.deepEqual(constellationLayout(map), graph);
  assert.equal(JSON.stringify(map), before);
  map.nodes.push({ id: 'c', parentId: 'a', status: 'suggested' });
  const extended = constellationLayout(map);
  assert.deepEqual(extended.positions.a, graph.positions.a);
  assert.equal(extended.domains.c, extended.domains.a);
  assert.equal(Object.keys(extended.positions).length, 4);
});

test('all node centers and relation endpoints remain finite for deep and disconnected maps', () => {
  const nodes = [{ id: 'root' }];
  for (let i = 0; i < 250; i++) nodes.push({ id: `n${i}`, parentId: i ? `n${i - 1}` : 'root' });
  nodes.push({ id: 'orphan', parentId: 'missing' });
  const graph = constellationLayout({ rootId: 'root', nodes });
  assert.equal(Object.keys(graph.positions).length, nodes.length);
  for (const point of Object.values(graph.positions)) assert(Number.isFinite(point.x) && Number.isFinite(point.y));
  const from = graph.positions.root, to = { x: -55, y: 102 };
  assert.equal(connectionPath(from, to), 'M 0 0 L -55 102');
  assert.equal(connectionPath(to, from), 'M -55 102 L 0 0');
});

test('research completion, acceptance, stale conclusions and active work remain distinct', () => {
  assert.equal(presentation({ status: 'explored', reviewState: 'unreviewed' }).label, 'Explored');
  assert.equal(presentation({ status: 'explored', reviewState: 'accepted' }).label, 'Explored · accepted');
  assert.deepEqual(presentation({ status: 'explored', reviewState: 'accepted', stale: true }), { label: 'Explored · needs review', lit: false });
  for (const status of ['suggested', 'queued', 'running', 'awaiting-answer', 'interrupted']) assert.equal(presentation({ status }).lit, false);
  assert.equal(presentation({ status: 'queued', reviewState: 'accepted' }).label, 'Queued · accepted');
});

test('overview contains every node even below five percent zoom, including saved outliers', () => {
  const positions = { root: { x: 0, y: 0 }, a: { x: -99000, y: 48000 }, b: { x: 92000, y: -72000 } };
  for (const viewport of [{ width: 867, height: 850 }, { width: 390, height: 220 }]) {
    const view = overviewView(positions, viewport);
    assert.ok(view.scale > 0 && view.scale < .05);
    for (const p of Object.values(positions)) {
      const x = p.x * view.scale + view.x, y = p.y * view.scale + view.y;
      assert.ok(x > 0 && x < viewport.width && y > 0 && y < viewport.height);
    }
    const focused = focusedView(positions.a, viewport, view.scale);
    assert.equal(focused.scale, 1);
    assert.equal(positions.a.x * focused.scale + focused.x, viewport.width / 2);
    assert.equal(positions.a.y * focused.scale + focused.y, viewport.height / 2);
  }
});

test('dense trees keep connected steps local and their neighborhood fits around the selected idea', () => {
  const nodes = Array.from({ length: 500 }, (_,index) => ({ id: `n${index}`, parentId: index ? `n${Math.floor((index - 1) / 4)}` : null }));
  const { positions } = constellationLayout({ rootId: 'n0', nodes });
  const distances = nodes.slice(1).map(node => Math.hypot(positions[node.id].x - positions[node.parentId].x, positions[node.id].y - positions[node.parentId].y)).sort((a,b) => a - b);
  assert.ok(distances[Math.floor(distances.length / 2)] < 180, 'Typical steps should remain local as the map grows');
  assert.ok(distances.at(-1) < 650, 'Dense branches must not stretch into multi-thousand-pixel connections');
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    assert.ok(Math.hypot(positions[nodes[a].id].x - positions[nodes[b].id].x, positions[nodes[a].id].y - positions[nodes[b].id].y) > 50, 'Automatic circle nodes should not overlap');
  }
  for (const node of nodes) {
    const point = positions[node.id];
    const neighbors = nodes.filter(n => n.id === node.parentId || n.parentId === node.id).map(n => positions[n.id]);
    const view = focusedView(point, { width: 867, height: 486 }, 1, neighbors);
    assert.ok(Math.abs(point.x * view.scale + view.x - 433.5) < .001);
    assert.ok(Math.abs(point.y * view.scale + view.y - 243) < .001);
    for (const p of neighbors) {
      assert.ok(p.x * view.scale + view.x > 15 && p.x * view.scale + view.x < 852);
      assert.ok(p.y * view.scale + view.y > 15 && p.y * view.scale + view.y < 471);
    }
  }
});

// Zoom detail levels and the minimap (Z10, #68).
test('detail levels rise at 0.45, 1.3 and 2.2 and fall about 10% lower, so a boundary never flickers', () => {
  assert.deepEqual([0.05, 0.44, 0.45, 1, 1.29, 1.3, 2.19, 2.2, 3].map(scale => detailLevel(scale)), ['far', 'far', 'standard', 'standard', 'standard', 'near', 'near', 'close', 'close']);
  assert.equal(detailLevel(0.42, 'standard'), 'standard', 'just under the way up stays'); assert.equal(detailLevel(0.4, 'standard'), 'far');
  assert.equal(detailLevel(0.44, 'far'), 'far'); assert.equal(detailLevel(0.45, 'far'), 'standard');
  assert.equal(detailLevel(1.2, 'near'), 'near'); assert.equal(detailLevel(1.1, 'near'), 'standard');
  assert.equal(detailLevel(2, 'close'), 'close'); assert.equal(detailLevel(1.9, 'close'), 'near');
  assert.equal(detailLevel(3, 'far'), 'close', 'a jump crosses several levels'); assert.equal(detailLevel(0.1, 'close'), 'far');
  assert.equal(detailLevel(1, 'unknown'), 'standard');
});

test('one fitting rule serves the canvas overview and the minimap: every idea fits, outliers included, and maps back', () => {
  const size = { width: 180, height: 120 }, minimap = { margin: { x: 16, y: 16 }, maxScale: 0.25 };
  const positions = { a: { x: 0, y: 0 }, b: { x: 1900, y: 700 }, far: { x: -99999, y: 99999 } };
  const view = fitView(positions, size, minimap);
  for (const point of Object.values(positions)) {
    const p = toScreen(view, point);
    assert.ok(p.x >= 0 && p.x <= size.width && p.y >= 0 && p.y <= size.height, `${JSON.stringify(point)} lands inside the minimap`);
    const back = toWorld(view, p);
    assert.ok(Math.abs(back.x - point.x) < 1e-6 && Math.abs(back.y - point.y) < 1e-6);
  }
  const small = fitView({ a: { x: 10, y: 20 } }, size, minimap);
  assert.deepEqual(toScreen(small, { x: 10, y: 20 }), { x: 90, y: 60 }, 'one idea sits in the middle'); assert.equal(small.scale, 0.25, 'a small map is not magnified');
  const empty = fitView({}, size, minimap);
  assert.deepEqual(toScreen(empty, { x: 0, y: 0 }), { x: 90, y: 60 }); assert.deepEqual(toWorld(empty, { x: 90, y: 60 }), { x: 0, y: 0 });
  assert.deepEqual(overviewView({}, { width: 800, height: 400 }), { scale: 1, x: 400, y: 200 }, 'an empty canvas overview is unchanged');
  const viewport = { width: 867, height: 486 }, corner = toWorld(view, { x: 0, y: 0 });
  assert.deepEqual(viewRect(view, viewport), { x: corner.x, y: corner.y, width: viewport.width / view.scale, height: viewport.height / view.scale }, 'the visible rectangle is the same transform read backwards');
});

test('a view centred on a point keeps its scale, and its visible rectangle is centred there', () => {
  const viewport = { width: 900, height: 500 };
  for (const scale of [0.05, 0.4, 1, 2.5]) {
    const point = { x: 340, y: -120 }, view = centredView(point, viewport, scale), rect = viewRect(view, viewport);
    assert.equal(view.scale, scale);
    assert.ok(Math.abs(rect.x + rect.width / 2 - point.x) < 1e-9 && Math.abs(rect.y + rect.height / 2 - point.y) < 1e-9);
    assert.ok(Math.abs(rect.width - viewport.width / scale) < 1e-9 && Math.abs(rect.height - viewport.height / scale) < 1e-9);
  }
  assert.deepEqual(viewRect({ x: 100, y: 50, scale: 2 }, viewport), { x: -50, y: -25, width: 450, height: 250 });
  assert.deepEqual(focusedView({ x: 10, y: 10 }, viewport, 0.5), centredView({ x: 10, y: 10 }, viewport, 1), 'focusing still zooms in to at least 100%');
});
