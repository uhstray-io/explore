import { presentation, minimapProjection, viewRect, centredView } from './graph.js';

// The minimap (Z10): the whole map in the canvas's corner, one dot per shown idea, with the current view outlined.
// A click or drag centres the view there, at the same zoom. It only moves the view: it never selects, never edits the
// map, and its pointer and wheel events never reach the canvas.
//   render()  redraws the dots (after the map is redrawn), skipping unchanged markup
//   view()    moves the rectangle (after every pan or zoom)
// `moveView({ x, y, scale })` sets the canvas view; `viewport()` gives the canvas's size.
const size = { width: 180, height: 120 }, step = 80;
const round = value => Math.round(value * 100) / 100;
const pans = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };

export function minimapPanel({ $, esc, state, viewport, moveView }) {
  const toggle = $('#minimap-toggle'), panel = $('#minimap'), dots = $('#minimap-dots'), frame = $('#minimap-view');
  let on = false, written = '', projection = null, dragging = null;
  try { on = localStorage.getItem('explore-minimap') === 'on'; } catch {}
  const shown = () => (state.visibleMap?.nodes ?? []).filter(node => state.positions[node.id]);
  function render() {
    if (!on || !state.visibleMap) return;
    const nodes = shown(), radius = nodes.length > 150 ? 1.3 : 2.2; // Smaller dots keep a large map legible.
    projection = minimapProjection(Object.fromEntries(nodes.map(node => [node.id, state.positions[node.id]])), size);
    const html = nodes.map(node => {
      const point = projection.toMap(state.positions[node.id]), selected = node.id === state.selected;
      return `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${selected ? 3.4 : radius}" class="${esc(node.status)}${presentation(node).lit ? ' lit' : ''}${node.stale ? ' stale' : ''}${selected ? ' selected' : ''}"/>`;
    }).join('');
    if (html !== written) dots.innerHTML = written = html;
    view();
  }
  function view() {
    if (!on || !projection) return;
    const rect = viewRect(state, viewport()), corner = projection.toMap(rect);
    frame.setAttribute('x', round(corner.x)); frame.setAttribute('y', round(corner.y));
    frame.setAttribute('width', round(rect.width * projection.scale)); frame.setAttribute('height', round(rect.height * projection.scale));
  }
  function show(next) {
    on = next;
    try { localStorage.setItem('explore-minimap', on ? 'on' : 'off'); } catch {}
    apply();
    if (on) { written = ''; render(); }
  }
  function apply() {
    panel.hidden = !on; toggle.setAttribute('aria-pressed', String(on)); toggle.dataset.commandLabel = on ? 'Hide minimap' : 'Show minimap';
  }
  // Centres the view on the map point under the pointer, keeping the zoom.
  function centreAt(event) {
    if (!projection) return;
    const box = panel.getBoundingClientRect();
    const point = projection.toWorld({ x: (event.clientX - box.left) * size.width / box.width, y: (event.clientY - box.top) * size.height / box.height });
    moveView(centredView(point, viewport(), state.scale));
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
  panel.addEventListener('keydown', event => {
    if (pans[event.key]) { event.preventDefault(); const [dx, dy] = pans[event.key]; moveView({ scale: state.scale, x: state.x + dx, y: state.y + dy }); }
    else if (event.key === 'Enter') { event.preventDefault(); const point = state.positions[state.selected]; if (point) moveView(centredView(point, viewport(), state.scale)); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); show(false); toggle.focus(); }
  });
  apply();
  return { render, view };
}
