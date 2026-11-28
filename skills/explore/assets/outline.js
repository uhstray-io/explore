import { treeOrder, branchIds, presentation } from './graph.js';
import { hiddenLabel } from './folds.js';

// The outline (Z7): every idea as an indented list in reading order, for keyboard and screen-reader use and for
// scanning large maps. It follows the WAI-ARIA tree pattern with flat rows (aria-level, -setsize, -posinset) and
// one tab stop. Choosing a row opens the idea in the inspector. With folds (Z6), a parent row is open or closed, and
// Right and Left open and fold it, as the tree pattern says; that saves the fold like the canvas's ⋯ menu does.
// Rows past this depth stop indenting and say their level instead, on every screen size.
const maxIndent = 8;
const moves = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowLeft', 'ArrowRight']);

// Rows in reading order: { id, node, level, parentId, connected, position, setSize }. Ideas not under the starting
// idea come last, `connected: false`; one whose parent is gone starts a level-1 row of its own. With `view` (from
// shownNodes), only the shown ideas are rows, and a parent row has `expanded` (false when folded) and `hidden` counts.
export function outlineRows(map, view = null) {
  const shown = view ? { ...map, nodes: map.nodes.filter(node => view.shown.has(node.id)) } : map, parents = new Set(map.nodes.map(node => node.parentId));
  const connected = branchIds(shown, shown.rootId);
  const rows = treeOrder(shown).map(({ node, depth }) => ({ id: node.id, node, level: depth + 1, parentId: depth ? node.parentId : null, connected: connected.has(node.id),
    ...(view && parents.has(node.id) ? { expanded: !view.hiddenBelow.has(node.id), hidden: view.hiddenBelow.get(node.id) ?? null, foldable: !view.locked.has(node.id) } : {}) }));
  const sets = new Map();
  for (const row of rows) {
    const set = JSON.stringify([row.parentId, row.connected]);
    if (!sets.has(set)) sets.set(set, []);
    sets.get(set).push(row);
  }
  for (const set of sets.values()) set.forEach((row, index) => Object.assign(row, { position: index + 1, setSize: set.length }));
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

// The tree's rows, from the map alone: the tab stop, the selection and a filter are set on the page (`mark`), so
// moving, selecting and filtering never redraw. Each row is named "title, state", as an idea on the canvas is.
export function outlineHtml(rows, { esc, glyphs }) {
  const row = item => {
    const node = item.node, shown = presentation(node), state = shown.label, deep = item.level - 1 > maxIndent;
    // presentation() already says what the user must do (Needs your answer, needs review); a folded row adds what it hides.
    const name = `${node.title}, ${state}${item.hidden ? `, ${hiddenLabel(item.hidden)}` : ''}`, open = item.expanded === undefined ? '' : ` aria-expanded="${item.expanded}"`;
    return `<div role="treeitem" class="outline-row ${esc(node.status)}${shown.lit ? ' lit' : ''}${node.stale ? ' stale' : ''}" data-outline-node="${esc(item.id)}" aria-label="${esc(name)}"${open} aria-level="${item.level}" aria-setsize="${item.setSize}" aria-posinset="${item.position}" aria-selected="false" tabindex="-1" style="--indent:${Math.min(item.level - 1, maxIndent)}">`
      + `<span class="outline-glyph" aria-hidden="true">${glyphs[node.kind] ?? '·'}</span><span class="outline-title">${esc(node.title)}</span><span class="outline-state">${esc(state)}${item.hidden ? ` · +${item.hidden.total} hidden` : ''}</span>${deep ? `<span class="outline-depth" aria-hidden="true">level ${item.level}</span>` : ''}</div>`;
  };
  const inTree = rows.filter(item => item.connected), apart = rows.filter(item => !item.connected);
  return inTree.map(row).join('') + (apart.length ? `<div role="group" aria-label="Not connected to the starting idea"><p class="outline-divider" aria-hidden="true">Not connected to the starting idea</p>${apart.map(row).join('')}</div>` : '');
}

// The outline panel and the Map / Outline switch, remembered in this browser.
//   render()         redraws the rows when the map changed (focus stays on its row, without scrolling)
//   showSelection()  marks the selected idea's row, after the selection changed
//   focusRow(id)     makes an idea's row the tab stop, brings it into view and focuses it (Find an idea, links)
//   dim(ids, context) dims the rows a filter leaves out, and marks `context` rows as quieter context; null shows them all
//   active()         whether the outline is the view on screen
// `select(id)` opens an idea in the inspector; `showMap({ refocus })` runs when the user returns to the map, with
// `refocus` true when focus was in the outline and needs a new place. The rows follow `state.view` (shownNodes), and
// `fold(id, collapsed)` saves a fold, returning false where folds cannot change (growth history).
export function outlinePanel({ $, $$, esc, glyphs, state, select, showMap, fold = () => false }) {
  const box = $('#outline');
  let view = 'map', rows = [], drawnFrom = null, drawnView = null, written = '', current = null, muted = null, quiet = null;
  try { if (localStorage.getItem('explore-view') === 'outline') view = 'outline'; } catch {}
  const rowOf = id => (id ? $(`[data-outline-node="${CSS.escape(id)}"]`) : null);
  const set = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
  // The tab stop, the selection and the filter, set on the rows in place.
  function mark() {
    if (!rows.some(row => row.id === current)) current = rows.some(row => row.id === state.selected) ? state.selected : rows[0]?.id ?? null;
    for (const element of box.querySelectorAll('[data-outline-node]')) {
      const id = element.dataset.outlineNode;
      set(element, 'tabindex', id === current ? '0' : '-1');
      set(element, 'aria-selected', String(id === state.selected));
      element.classList.toggle('filter-muted', !!muted && !muted.has(id) && !quiet?.has(id)); element.classList.toggle('filter-context', !!quiet?.has(id));
    }
  }
  function render() {
    if (view !== 'outline' || !state.visibleMap) return;
    // The same map and view objects as last time: nothing to redraw. A changed map is a new object, and the folds
    // panel returns the same view object until the map, its folds or the branch focus change.
    if (drawnFrom === state.visibleMap && drawnView === state.view && written) { mark(); return; }
    rows = outlineRows(state.visibleMap, state.view); drawnFrom = state.visibleMap; drawnView = state.view;
    const html = outlineHtml(rows, { esc, glyphs });
    if (html === written) { mark(); return; }
    const focused = box.contains(document.activeElement);
    box.innerHTML = written = html;
    mark();
    if (focused) rowOf(current)?.focus({ preventScroll: true });
  }
  // A move the user made: the row becomes the tab stop and comes into view.
  function moveTo(id) {
    current = id; mark();
    const element = rowOf(id);
    element?.scrollIntoView?.({ block: 'nearest' }); element?.focus({ preventScroll: true });
  }
  // The view on screen. Only the other view is a command, so the palette never offers a switch that does nothing.
  function show() {
    $('#workspace').classList.toggle('outline-mode', view === 'outline'); box.hidden = view !== 'outline';
    for (const button of $$('[data-view]')) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
      if (button.dataset.view === view) delete button.dataset.command; else button.dataset.command = 'view';
    }
  }
  function setView(next) {
    // Focus in a row that is about to hide (a switch from the palette returns it there) goes to the map's idea.
    const lost = box.contains(document.activeElement) || document.activeElement === document.body;
    view = next;
    try { localStorage.setItem('explore-view', view); } catch {}
    show();
    if (view === 'outline') { current = state.selected; written = ''; render(); } else showMap({ refocus: lost });
  }
  for (const button of $$('[data-view]')) button.addEventListener('click', () => { if (button.dataset.view !== view) setView(button.dataset.view); });
  box.addEventListener('click', event => { const row = event.target.closest('[data-outline-node]'); if (row) { select(row.dataset.outlineNode); moveTo(row.dataset.outlineNode); } });
  box.addEventListener('keydown', event => {
    const row = event.target.closest('[data-outline-node]');
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.dataset.outlineNode); moveTo(row.dataset.outlineNode); return; }
    if (!moves.has(event.key)) return;
    event.preventDefault();
    const item = rows.find(entry => entry.id === row.dataset.outlineNode);
    if (item?.foldable !== false && ((event.key === 'ArrowRight' && item?.expanded === false) || (event.key === 'ArrowLeft' && item?.expanded === true))) { if (fold(item.id, item.expanded)) return; }
    const target = outlineMove(rows, row.dataset.outlineNode, event.key);
    if (target) moveTo(target);
  });
  show(); render();
  return {
    render, active: () => view === 'outline', focusRow: id => { if (view === 'outline') moveTo(id); },
    showSelection: () => { if (view === 'outline') mark(); },
    dim(ids, context = null) { muted = ids; quiet = context; if (view === 'outline') mark(); },
  };
}
