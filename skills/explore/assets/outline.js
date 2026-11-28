import { treeOrder, branchIds, presentation } from './graph.js';

// The outline (Z7): every idea as an indented list in reading order, for keyboard and screen-reader use and for
// scanning large maps. It follows the WAI-ARIA tree pattern with flat rows (aria-level, -setsize, -posinset) and
// one tab stop. Choosing a row opens the idea in the inspector; nothing here writes to the map.
const maxIndent = 10;
const moves = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight'];

// Rows in reading order: { id, node, level, parentId, connected, childCount, position, setSize }. Ideas not under
// the starting idea come last, `connected: false`; one whose parent is gone starts a level-1 row of its own.
export function outlineRows(map) {
  const connected = branchIds(map, map.rootId);
  const rows = treeOrder(map).map(({ node, depth }) => ({ id: node.id, node, level: depth + 1, parentId: depth ? node.parentId : null, connected: connected.has(node.id) }));
  const sets = new Map(), children = new Map();
  for (const row of rows) {
    const set = JSON.stringify([row.parentId, row.connected]);
    if (!sets.has(set)) sets.set(set, []);
    sets.get(set).push(row);
    if (row.parentId) children.set(row.parentId, (children.get(row.parentId) ?? 0) + 1);
  }
  for (const set of sets.values()) set.forEach((row, index) => Object.assign(row, { position: index + 1, setSize: set.length }));
  for (const row of rows) row.childCount = children.get(row.id) ?? 0;
  return rows;
}

// The row a key moves to from `id`, or null: Up and Down, Home and End, Left to the parent, Right to the first child.
export function outlineMove(rows, id, key) {
  const index = rows.findIndex(row => row.id === id), row = rows[index];
  if (!row) return null;
  if (key === 'ArrowDown') return rows[index + 1]?.id ?? null;
  if (key === 'ArrowUp') return rows[index - 1]?.id ?? null;
  if (key === 'Home') return rows[0].id;
  if (key === 'End') return rows.at(-1).id;
  if (key === 'ArrowLeft') return row.parentId;
  if (key === 'ArrowRight') return rows[index + 1]?.parentId === row.id ? rows[index + 1].id : null;
  return null;
}

// The tree's rows. `active` holds the one tab stop; ideas outside `muted` (a Set, when a filter is on) are dimmed.
export function outlineHtml(rows, { esc, glyphs, selected, active, muted }) {
  const row = item => {
    const node = item.node, deep = item.level - 1 > maxIndent;
    // presentation() already says what the user must do (Needs your answer, needs review).
    const status = presentation(node), notes = [status.label, deep ? `level ${item.level}` : ''].filter(Boolean);
    return `<div role="treeitem" class="outline-row ${esc(node.status)}${status.lit ? ' lit' : ''}${node.stale ? ' stale' : ''}${muted && !muted.has(item.id) ? ' filter-muted' : ''}" data-outline-node="${esc(item.id)}" aria-level="${item.level}" aria-setsize="${item.setSize}" aria-posinset="${item.position}" aria-selected="${item.id === selected}" tabindex="${item.id === active ? 0 : -1}" style="--indent:${Math.min(item.level - 1, maxIndent)}">`
      + `<span class="outline-glyph" aria-hidden="true">${glyphs[node.kind] ?? '·'}</span><span class="outline-title">${esc(node.title)}</span><span class="outline-state">${esc(notes.join(' · '))}</span></div>`;
  };
  const inTree = rows.filter(item => item.connected), apart = rows.filter(item => !item.connected);
  return inTree.map(row).join('') + (apart.length ? `<div role="group" aria-label="Not connected to the starting idea"><p class="outline-divider" aria-hidden="true">Not connected to the starting idea</p>${apart.map(row).join('')}</div>` : '');
}

// The outline panel and the Map / Outline switch, remembered in this browser.
//   render()      redraws the rows when their markup changed, keeping focus on the same row
//   focusRow(id)  makes an idea's row the tab stop and focuses it (Find an idea, filter lists, links)
//   dim(ids)      dims the rows a filter leaves out; null shows them all
//   active()      whether the outline is the view on screen
// `select(id)` opens an idea in the inspector; `showMap()` runs when the user returns to the map.
export function outlinePanel({ $, $$, esc, glyphs, state, select, showMap }) {
  const box = $('#outline');
  let view = 'map', written = '', current = null, muted = null;
  try { if (localStorage.getItem('explore-view') === 'outline') view = 'outline'; } catch {}
  const rows = () => (state.visibleMap ? outlineRows(state.visibleMap) : []);
  const focusOn = id => { const element = $(`[data-outline-node="${CSS.escape(id)}"]`); element?.scrollIntoView?.({ block: 'nearest' }); element?.focus({ preventScroll: true }); };
  function render() {
    if (view !== 'outline' || !state.visibleMap) return;
    const list = rows(), focused = box.contains(document.activeElement);
    if (!list.some(item => item.id === current)) current = list.some(item => item.id === state.selected) ? state.selected : list[0]?.id ?? null;
    const html = outlineHtml(list, { esc, glyphs, selected: state.selected, active: current, muted });
    if (html === written) return;
    box.innerHTML = written = html;
    if (focused && current) focusOn(current);
  }
  // The view on screen: the outline in the canvas's place, and the switch's pressed button. Only the other view is
  // a command, so the palette never offers a switch that does nothing.
  function show() {
    $('#workspace').classList.toggle('outline-mode', view === 'outline'); box.hidden = view !== 'outline';
    for (const button of $$('[data-view]')) { button.setAttribute('aria-pressed', String(button.dataset.view === view)); button.toggleAttribute('data-command', button.dataset.view !== view); }
  }
  function setView(next) {
    view = next;
    try { localStorage.setItem('explore-view', view); } catch {}
    show();
    if (view === 'outline') { written = ''; render(); } else showMap();
  }
  function moveTo(id, choose = false) { current = id; if (choose) select(id); render(); focusOn(id); }
  for (const button of $$('[data-view]')) button.addEventListener('click', () => { if (button.dataset.view !== view) setView(button.dataset.view); });
  box.addEventListener('click', event => { const row = event.target.closest('[data-outline-node]'); if (row) moveTo(row.dataset.outlineNode, true); });
  box.addEventListener('keydown', event => {
    const row = event.target.closest('[data-outline-node]'); if (!row) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); moveTo(row.dataset.outlineNode, true); return; }
    if (!moves.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const target = outlineMove(rows(), row.dataset.outlineNode, event.key);
    if (target) moveTo(target);
  });
  show(); render();
  return { render, active: () => view === 'outline', focusRow: id => moveTo(id), dim(ids) { muted = ids; render(); } };
}
