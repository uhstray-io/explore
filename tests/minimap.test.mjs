import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { minimapPanel } from '../skills/explore/assets/minimap.js';
import { fitView, toScreen, toWorld, viewRect, centredView, detailLevel } from '../skills/explore/assets/graph.js';

// The minimap (Z10, #68): the whole map in a corner, with the current view outlined. Illustrative fixtures only.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const size = { width: 180, height: 120 }, viewport = { width: 900, height: 450 }, fit = { margin: { x: 16, y: 16 }, maxScale: 0.25 };
const idea = (id, status, extra = {}) => ({ id, kind: 'idea', title: `Idea ${id}`, status, reviewState: 'unreviewed', ...extra });
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

// A fake page: the toggle, the panel (180 × 120 on screen at 1000, 500), its dots, the selection ring and the view
// rectangle. Events bubble from the panel to a stand-in for the canvas's own handlers unless they are stopped.
function page({ stored = null } = {}) {
  const storage = new Map(stored ? [['explore-minimap', stored]] : []);
  const map = { nodes: [idea('root', 'explored'), idea('a', 'awaiting-answer'), idea('b', 'suggested', { stale: true }), idea('hidden', 'suggested')] };
  const state = { visibleMap: map, selected: 'a', positions: { root: { x: 0, y: 0 }, a: { x: 400, y: 200 }, b: { x: -300, y: 100 } }, x: 100, y: 60, scale: 1 };
  const io = { dotWrites: 0, dots: '', moves: [], focused: null, canvasSaw: [], resize: null };
  const element = extra => ({ attributes: {}, dataset: {}, listeners: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener(type, handler) { this.listeners[type] = handler; }, ...extra });
  const toggle = element({ focus: () => { io.focused = 'toggle'; } });
  const panel = element({ hidden: true, getBoundingClientRect: () => ({ left: 1000, top: 500, width: 180, height: 120 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} });
  const dots = { set innerHTML(value) { io.dots = value; io.dotWrites++; }, get innerHTML() { return io.dots; } };
  const frame = element(), ring = element();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  globalThis.ResizeObserver = class { constructor(callback) { io.resize = callback; } observe(target) { io.observed = target; } };
  const $ = selector => ({ '#minimap-toggle': toggle, '#minimap': panel, '#minimap-dots': dots, '#minimap-view': frame, '#minimap-selected': ring, '#canvas': 'canvas' })[selector];
  const positions = () => Object.fromEntries(map.nodes.filter(node => state.positions[node.id]).map(node => [node.id, state.positions[node.id]]));
  const before = structuredClone(map);
  const minimap = minimapPanel({ $, esc, state, positions, viewport: () => viewport, moveView: view => { io.moves.push(view); Object.assign(state, view); } });
  // Dispatches on the panel, then lets the event bubble to the canvas unless the panel stopped it.
  const fire = (type, extra = {}) => {
    let stopped = false;
    const event = { type, button: 0, pointerId: 7, clientX: 1000, clientY: 500, preventDefault() {}, stopPropagation() { stopped = true; }, ...extra };
    panel.listeners[type](event);
    if (!stopped) io.canvasSaw.push(type);
  };
  return { minimap, state, io, toggle, panel, frame, ring, storage, fire, before, map };
}
test.afterEach(() => { delete globalThis.localStorage; delete globalThis.ResizeObserver; });

test('the minimap is off until the toggle turns it on, and remembers the choice', () => {
  let p = page();
  p.minimap.render();
  assert.equal(p.panel.hidden, true); assert.equal(p.io.dotWrites, 0, 'nothing is drawn while it is off');
  assert.equal(p.toggle.attributes['aria-pressed'], 'false'); assert.equal(p.toggle.dataset.commandLabel, 'Show minimap');
  p.toggle.listeners.click();
  assert.equal(p.panel.hidden, false); assert.equal(p.storage.get('explore-minimap'), 'on');
  assert.equal(p.toggle.attributes['aria-pressed'], 'true'); assert.equal(p.toggle.dataset.commandLabel, 'Hide minimap');
  assert.equal(p.io.dotWrites, 1);
  p.toggle.listeners.click();
  assert.equal(p.panel.hidden, true); assert.equal(p.storage.get('explore-minimap'), 'off');
  p = page({ stored: 'on' });
  assert.equal(p.panel.hidden, false);
});

test('one dot per shown idea in its state, and the view drawn where the canvas looks, also after the canvas resizes', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  assert.equal(p.io.dots.match(/<circle [^>]*>/g).length, 3, 'only ideas with a position are shown');
  assert.match(p.io.dots, /class="awaiting-answer"/); assert.match(p.io.dots, /class="explored lit"/); assert.match(p.io.dots, /class="suggested stale"/);
  const view = fitView(p.state.positions, size, fit), check = () => {
    const rect = viewRect(p.state, viewport), corner = toScreen(view, rect);
    assert.ok(near(p.frame.attributes.x, corner.x) && near(p.frame.attributes.y, corner.y)); assert.ok(near(p.frame.attributes.width, rect.width * view.scale));
  };
  check();
  const writes = p.io.dotWrites;
  Object.assign(p.state, { x: -200, y: 10, scale: 0.5 }); p.minimap.view(); check();
  assert.equal(p.io.dotWrites, writes, 'panning moves only the rectangle');
  p.minimap.render(); assert.equal(p.io.dotWrites, writes, 'an unchanged map is not redrawn');
  assert.equal(p.io.observed, 'canvas', 'it watches the canvas size');
  viewport.height = 300; p.io.resize(); check(); viewport.height = 450;
});

test('the selection ring follows the selected idea without redrawing the dots', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const view = fitView(p.state.positions, size, fit), writes = p.io.dotWrites;
  const ringAt = id => { const point = toScreen(view, p.state.positions[id]); return near(p.ring.attributes.cx, point.x) && near(p.ring.attributes.cy, point.y); };
  assert.ok(ringAt('a')); assert.equal(p.ring.attributes.visibility, 'visible');
  p.state.selected = 'b'; p.minimap.view();
  assert.ok(ringAt('b')); assert.equal(p.io.dotWrites, writes);
  p.state.selected = 'hidden'; p.minimap.view(); assert.equal(p.ring.attributes.visibility, 'hidden', 'an idea without a dot has no ring');
});

test('a click or drag centres the view there at the same zoom, never past the panel, and never reaches the canvas', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const view = fitView(p.state.positions, size, fit);
  p.fire('pointerdown', { clientX: 1000 + 90, clientY: 500 + 60 });
  assert.deepEqual(p.io.moves.at(-1), centredView(toWorld(view, { x: 90, y: 60 }), viewport, 1));
  p.fire('pointermove', { clientX: 1000 + 30, clientY: 500 + 20 });
  assert.deepEqual(p.io.moves.at(-1), centredView(toWorld(view, { x: 30, y: 20 }), viewport, 1));
  p.fire('pointermove', { clientX: 1000 + 300, clientY: 500 - 90 });
  assert.deepEqual(p.io.moves.at(-1), centredView(toWorld(view, { x: 180, y: 0 }), viewport, 1), 'a drag past the edge stops at the edge');
  p.fire('pointerup');
  const moves = p.io.moves.length;
  p.fire('pointermove', { clientX: 1100 });
  assert.equal(p.io.moves.length, moves, 'moving without a press does nothing');
  p.fire('wheel'); p.fire('click'); p.fire('pointercancel');
  assert.deepEqual(p.io.canvasSaw, [], 'the canvas never pans, zooms or drags underneath');
  assert.equal(p.state.selected, 'a'); assert.deepEqual(p.map, p.before);
});

test('arrow keys pan by a step, Enter centres the selected idea, Escape hides it and returns to the toggle', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const key = name => p.fire('keydown', { key: name });
  key('ArrowRight'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 20, y: 60 });
  key('ArrowDown'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 20, y: -20 });
  key('ArrowLeft'); key('ArrowUp'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 100, y: 60 });
  p.state.scale = 2; key('Enter');
  assert.deepEqual(p.io.moves.at(-1), centredView(p.state.positions.a, viewport, 2));
  assert.deepEqual(p.io.canvasSaw, [], 'the keys it handles stay with it');
  p.fire('keydown', { key: 'k', ctrlKey: true }); p.fire('keydown', { key: '/' });
  assert.deepEqual(p.io.canvasSaw, ['keydown', 'keydown'], 'Ctrl+K and / still reach the page');
  key('Escape');
  assert.equal(p.panel.hidden, true); assert.equal(p.io.focused, 'toggle'); assert.equal(p.storage.get('explore-minimap'), 'off');
  assert.equal(p.io.canvasSaw.length, 2, 'Escape closes the minimap only, not the page panels too');
  assert.equal(p.state.selected, 'a');
});

// The app's side: the real transform() from app.js keeps the detail level in its state and moves the minimap.
test('every pan or zoom sets the detail level from the app state and moves the minimap rectangle', async () => {
  const app = await readFile(new URL('../skills/explore/assets/app.js', import.meta.url), 'utf8');
  const from = app.indexOf('function transform()'), to = app.indexOf('\nfunction viewport()', from);
  assert.ok(from >= 0 && to > from, 'transform is still in app.js');
  const writes = [], world = { style: { setProperty() {} }, dataset: new Proxy({}, { set(target, key, value) { writes.push(value); target[key] = value; return true; } }) };
  const state = { x: 0, y: 0, scale: 1 }, calls = [];
  const context = vm.createContext({ state, detailLevel, $: selector => (selector === '#world' ? world : { textContent: '' }), minimap: { view: () => calls.push('view') } });
  vm.runInContext(app.slice(from, to), context);
  context.transform(); assert.equal(state.detail, 'standard'); assert.deepEqual(writes, ['standard']); assert.equal(calls.length, 1);
  state.scale = 1.25; context.transform(); assert.equal(state.detail, 'standard', 'below the way up');
  state.scale = 1.4; context.transform(); assert.equal(state.detail, 'near');
  state.scale = 1.2; context.transform(); assert.equal(state.detail, 'near', 'just under the way up stays, from the state rather than the page');
  assert.deepEqual(writes, ['standard', 'near'], 'the page is written only when the level changes'); assert.equal(calls.length, 4);
});

test('caption visibility does not depend on where rules sit in the stylesheet', async () => {
  const css = await readFile(new URL('../skills/explore/assets/constellation.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.node:not\(\.selected\) \.node-caption/, 'the old hiding rule is gone');
  assert.match(css, /\.node-caption\{display:none\}\.node\.major\.selected \.node-caption,:is\(\[data-detail=near\],\[data-detail=close\]\) \.node-caption\{display:block\}#world\[data-detail=far\] \.node:not\(\.root\) \.node-caption\{display:none\}/);
});
