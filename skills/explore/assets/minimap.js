import { presentation, fitView, toScreen, toWorld, viewRect, centredView } from './graph.js';

// The minimap (Z10): the whole map in the canvas's corner, one dot per shown idea, a ring on the selected one, and the
// current view outlined. A click or drag centres the view there, at the same zoom. It only moves the view: it never
// selects, never edits the map, and its pointer and wheel events never reach the canvas.
//   render()  redraws the dots after the map is redrawn, skipping unchanged markup
//   view()    places the rectangle and the ring after every pan, zoom or resize of the canvas
// `positions()` gives the shown ideas' positions, `viewport()` the canvas's size, and `moveView({ x, y, scale })`
// sets the canvas view.
const size = { width: 180, height: 120 }, fit = { margin: { x: 16, y: 16 }, maxScale: 0.25 }, step = 80;
const round = value => Math.round(value * 100) / 100;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const pans = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };

export function minimapPanel({ $, esc, state, positions, viewport, moveView }) {
  const toggle = $('#minimap-toggle'), panel = $('#minimap'), dots = $('#minimap-dots'), frame = $('#minimap-view'), ring = $('#minimap-selected');
  let on = false, written = null, shown = {}, picture = null, dragging = null;
  try { on = localStorage.getItem('explore-minimap') === 'on'; } catch {}
  function render() {
    if (!on || !state.visibleMap) return;
    shown = positions();
    picture = fitView(shown, size, fit);
    const nodes = state.visibleMap.nodes.filter(node => shown[node.id]), radius = nodes.length > 150 ? 1.3 : 2.2; // Smaller dots keep a large map legible.
    const html = nodes.map(node => {
      const point = toScreen(picture, shown[node.id]);
      return `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${radius}" class="${esc(node.status)}${presentation(node).lit ? ' lit' : ''}${node.stale ? ' stale' : ''}"/>`;
    }).join('');
    if (html !== written) dots.innerHTML = written = html;
    view();
  }
  function view() {
    if (!on || !picture) return;
    const rect = viewRect(state, viewport()), corner = toScreen(picture, rect);
    frame.setAttribute('x', round(corner.x)); frame.setAttribute('y', round(corner.y));
    frame.setAttribute('width', round(rect.width * picture.scale)); frame.setAttribute('height', round(rect.height * picture.scale));
    const selected = shown[state.selected], point = selected && toScreen(picture, selected);
    ring.setAttribute('visibility', point ? 'visible' : 'hidden');
    if (point) { ring.setAttribute('cx', round(point.x)); ring.setAttribute('cy', round(point.y)); }
  }
  function apply() {
    panel.hidden = !on; toggle.setAttribute('aria-pressed', String(on)); toggle.dataset.commandLabel = on ? 'Hide minimap' : 'Show minimap';
  }
  function show(next) {
    on = next;
    try { localStorage.setItem('explore-minimap', on ? 'on' : 'off'); } catch {}
    apply();
    if (on) { written = null; render(); }
  }
  // Centres the view on the map point under the pointer, keeping the zoom. A drag past the panel stops at its edge.
  function centreAt(event) {
    if (!picture) return;
    const box = panel.getBoundingClientRect();
    const point = { x: clamp((event.clientX - box.left) * size.width / box.width, 0, size.width), y: clamp((event.clientY - box.top) * size.height / box.height, 0, size.height) };
    moveView(centredView(toWorld(picture, point), viewport(), state.scale));
  }
  toggle.addEventListener('click', () => show(!on));
  panel.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (event.button !== 0) return;
    dragging = event.pointerId; panel.setPointerCapture(event.pointerId); centreAt(event);
  });
  panel.addEventListener('pointermove', event => { event.stopPropagation(); if (event.pointerId === dragging) centreAt(event); });
  for (const type of ['pointerup', 'pointercancel']) panel.addEventListener(type, event => {
    event.stopPropagation();
    if (event.pointerId !== dragging) return;
    dragging = null; if (panel.hasPointerCapture(event.pointerId)) panel.releasePointerCapture(event.pointerId);
  });
  panel.addEventListener('wheel', event => { event.stopPropagation(); event.preventDefault(); }, { passive: false });
  panel.addEventListener('click', event => event.stopPropagation());
  // The keys it handles stay with it (Escape would also close the page's panels); Ctrl+K and / still reach the page.
  panel.addEventListener('keydown', event => {
    const handled = pans[event.key] || event.key === 'Enter' || event.key === 'Escape';
    if (!handled || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    if (pans[event.key]) { const [dx, dy] = pans[event.key]; moveView({ scale: state.scale, x: state.x + dx, y: state.y + dy }); }
    else if (event.key === 'Enter') { const point = state.positions[state.selected]; if (point) moveView(centredView(point, viewport(), state.scale)); }
    else { show(false); toggle.focus(); }
  });
  // The canvas changes size without a window resize too (the Versions panel, growth history): keep the rectangle true.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => view()).observe($('#canvas'));
  apply();
  return { render, view };
}
