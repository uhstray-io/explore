import test from 'node:test';
import assert from 'node:assert/strict';
import { minimapPanel } from '../skills/explore/assets/minimap.js';
import { minimapProjection, viewRect, centredView } from '../skills/explore/assets/graph.js';

// The minimap (Z10, #68): the whole map in a corner, with the current view outlined. Illustrative fixtures only.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const size = { width: 180, height: 120 }, viewport = { width: 900, height: 450 };
const idea = (id, status, extra = {}) => ({ id, kind: 'idea', title: `Idea ${id}`, status, reviewState: 'unreviewed', ...extra });

// A fake page: the toggle, the panel (180 × 120 on screen), its dots and its view rectangle.
function page({ stored = null } = {}) {
  const storage = new Map(stored ? [['explore-minimap', stored]] : []);
  const map = { nodes: [idea('root', 'explored'), idea('a', 'awaiting-answer'), idea('b', 'suggested', { stale: true }), idea('hidden', 'suggested')] };
  const state = { visibleMap: map, selected: 'a', positions: { root: { x: 0, y: 0 }, a: { x: 400, y: 200 }, b: { x: -300, y: 100 } }, x: 100, y: 60, scale: 1 };
  const io = { dotWrites: 0, dots: '', moves: [], focused: null, stopped: 0 };
  const element = extra => ({ attributes: {}, dataset: {}, listeners: {}, setAttribute(name, value) { this.attributes[name] = String(value); }, addEventListener(type, handler) { this.listeners[type] = handler; }, ...extra });
  const toggle = element({ focus: () => { io.focused = 'toggle'; } });
  const panel = element({ hidden: true, getBoundingClientRect: () => ({ left: 1000, top: 500, width: 180, height: 120 }), setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} });
  const dots = { set innerHTML(value) { io.dots = value; io.dotWrites++; }, get innerHTML() { return io.dots; } };
  const frame = element();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  const $ = selector => ({ '#minimap-toggle': toggle, '#minimap': panel, '#minimap-dots': dots, '#minimap-view': frame })[selector];
  const before = structuredClone(map);
  const minimap = minimapPanel({ $, esc, state, viewport: () => viewport, moveView: view => { io.moves.push(view); Object.assign(state, view); } });
  const event = extra => ({ button: 0, pointerId: 7, clientX: 1000, clientY: 500, preventDefault() {}, stopPropagation() { io.stopped++; }, ...extra });
  return { minimap, state, io, toggle, panel, frame, storage, event, before, map };
}
test.afterEach(() => { delete globalThis.localStorage; });

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

test('one dot per shown idea in its state, a ring on the selected one, and the view drawn where the canvas looks', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const circles = p.io.dots.match(/<circle [^>]*>/g);
  assert.equal(circles.length, 3, 'only ideas with a position are shown');
  assert.match(p.io.dots, /class="awaiting-answer selected"/); assert.match(p.io.dots, /class="explored lit"/); assert.match(p.io.dots, /class="suggested stale"/);
  const projection = minimapProjection(p.state.positions, size), rect = viewRect(p.state, viewport), corner = projection.toMap(rect);
  assert.ok(Math.abs(Number(p.frame.attributes.x) - corner.x) < 0.01 && Math.abs(Number(p.frame.attributes.y) - corner.y) < 0.01);
  assert.ok(Math.abs(Number(p.frame.attributes.width) - rect.width * projection.scale) < 0.01);
  const writes = p.io.dotWrites;
  Object.assign(p.state, { x: -200, y: 10, scale: 0.5 }); p.minimap.view();
  assert.equal(p.io.dotWrites, writes, 'panning moves only the rectangle');
  assert.ok(Math.abs(Number(p.frame.attributes.width) - viewRect(p.state, viewport).width * projection.scale) < 0.01);
  p.minimap.render(); assert.equal(p.io.dotWrites, writes, 'an unchanged map is not redrawn');
});

test('a click or drag centres the view there at the same zoom, without touching selection, the map or the canvas', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const projection = minimapProjection(p.state.positions, size);
  p.panel.listeners.pointerdown(p.event({ clientX: 1000 + 90, clientY: 500 + 60 }));
  assert.deepEqual(p.io.moves.at(-1), centredView(projection.toWorld({ x: 90, y: 60 }), viewport, 1));
  p.panel.listeners.pointermove(p.event({ clientX: 1000 + 30, clientY: 500 + 20 }));
  assert.deepEqual(p.io.moves.at(-1), centredView(projection.toWorld({ x: 30, y: 20 }), viewport, 1));
  p.panel.listeners.pointerup(p.event());
  const moves = p.io.moves.length;
  p.panel.listeners.pointermove(p.event({ clientX: 1100 }));
  assert.equal(p.io.moves.length, moves, 'moving without a press does nothing');
  p.panel.listeners.wheel(p.event());
  assert.equal(p.io.stopped, 5, 'no pointer or wheel event reaches the canvas');
  assert.equal(p.state.selected, 'a'); assert.deepEqual(p.map, p.before);
});

test('arrow keys pan by a step, Enter centres the selected idea, Escape hides it and returns to the toggle', () => {
  const p = page({ stored: 'on' });
  p.minimap.render();
  const key = name => p.panel.listeners.keydown(p.event({ key: name }));
  key('ArrowRight'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 20, y: 60 });
  key('ArrowDown'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 20, y: -20 });
  key('ArrowLeft'); key('ArrowUp'); assert.deepEqual(p.io.moves.at(-1), { scale: 1, x: 100, y: 60 });
  p.state.scale = 2; key('Enter');
  assert.deepEqual(p.io.moves.at(-1), centredView(p.state.positions.a, viewport, 2));
  key('Escape');
  assert.equal(p.panel.hidden, true); assert.equal(p.io.focused, 'toggle'); assert.equal(p.storage.get('explore-minimap'), 'off');
  assert.equal(p.state.selected, 'a');
});
