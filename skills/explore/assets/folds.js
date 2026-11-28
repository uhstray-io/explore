import { shownNodes } from './workspace-view.js';
import { branchIds } from './graph.js';

// Collapse and focus branches (Z6) in the workspace. Folds are saved with the map (the `fold` and `reveal` actions),
// like positions; branch focus is this browser's own (state.branchFocus). Neither queues research or changes an idea.
// In growth history and a version preview, which are read-only, folds come from the map shown and can be opened in
// this browser only, until the user returns to live.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "5 hidden directions, 1 needs your answer, 2 need review, 1 queued or being explored": the folded idea's label adds this.
export function hiddenLabel({ total, needsAnswer, needsReview, working = 0 }) {
  return [count(total, 'hidden direction', 'hidden directions'), needsAnswer ? count(needsAnswer, 'needs your answer', 'need your answer') : '',
    needsReview ? count(needsReview, 'needs review', 'need review') : '', working ? `${working} queued or being explored` : ''].filter(Boolean).join(', ');
}
const noView = { folded: new Set(), locked: new Set(), focus: null };

// The idea's ⋯ menu items, from the view on screen. A fold on the path to a focused branch cannot change; in growth
// history (`live` false) a folded idea can only be opened, in this browser.
export function foldMenuItems(node, { esc, map, view = noView, live }) {
  const id = esc(node.id), item = (attribute, value, label) => `<button type="button" role="menuitem" tabindex="-1" ${attribute}="${value}">${label}</button>`;
  const below = branchIds(map, node.id).size - 1;
  const fold = below < 1 || view.locked.has(node.id) ? '' : view.folded.has(node.id) ? item('data-unfold', id, 'Show its directions') : live ? item('data-fold', id, `Hide its directions (${below})`) : '';
  const branch = node.id === map.rootId ? '' : view.focus === node.id ? item('data-branch-focus', '', 'Show whole map') : item('data-branch-focus', id, 'Show only this branch');
  return fold + branch;
}

// Above the canvas while one branch is shown.
export function branchBarHtml(map, focus, { esc }) {
  const node = focus ? map.nodes.find(item => item.id === focus) : null;
  return node ? `<p>Showing one branch: <strong>${esc(node.title)}</strong></p><button type="button" class="secondary" data-branch-focus="" data-command="whole-map" data-command-label="Show whole map">Show whole map</button>` : '';
}

// The ideas above `id`, nearest first; a loop of parents ends the walk.
export function ancestorsOf(map, id) {
  const byId = new Map(map.nodes.map(node => [node.id, node])), out = [];
  for (let at = byId.get(byId.get(id)?.parentId); at && at.id !== id && !out.includes(at.id); at = byId.get(at.parentId)) out.push(at.id);
  return out;
}
// The selection a view can show: the selected idea, or the nearest shown idea above it (a fold hid it).
export function shownSelection(map, view, selected) {
  if (!selected || view.shown.has(selected)) return selected;
  return ancestorsOf(map, selected).find(id => view.shown.has(id)) ?? (view.shown.has(map.rootId) ? map.rootId : null);
}
// What it takes to show a hidden idea: leaving branch focus, unfolding the folds above it, both or neither.
export function revealPlan(map, id, { folded = [], focus = null }) {
  const leaveFocus = !!focus && !shownNodes(map, { focus }).shown.has(id);
  return { leaveFocus, unfold: !shownNodes(map, { folded, focus: leaveFocus ? null : focus }).shown.has(id) };
}

// The folds in the workspace.
//   render()        the view for this redraw (the same object while nothing changed), with the selection a fold hid
//                   moved to the folded idea above it (and the address with it), and the branch bar
//   reveal(id)      shows a hidden idea, then chooses it: Find an idea, filter lists, links, the palette
//   click(event)    the ⋯ menu items and the bar; true when handled
//   foldRow(id, collapsed)  the outline's Left and Right; false where the fold cannot change (then the key moves)
// `redraw()` redraws the map as it is; `showAddress()` writes the selection into the address bar.
export function foldsPanel({ $, esc, state, act, toast, closeMenus, redraw, fitMap, focusNode, showAddress }) {
  const opened = new Set(); // Folds opened in a read-only view, in this browser only.
  const pending = new Set(); // Folds being saved: a second press while one is on its way sends nothing.
  let cached = null, bar = '';
  const live = () => state.historyStep === null;
  const folded = () => {
    const list = (state.historySource ?? state.map)?.view?.collapsed; // Folds belong to the map shown, as positions do.
    return (Array.isArray(list) ? list : []).filter(id => live() || !opened.has(id));
  };
  function view() {
    const key = JSON.stringify([folded(), state.branchFocus ?? null]);
    if (cached?.map !== state.visibleMap || cached.key !== key) cached = { map: state.visibleMap, key, view: shownNodes(state.visibleMap, { folded: folded(), focus: state.branchFocus }) };
    return cached.view;
  }
  function render() {
    if (live()) opened.clear();
    const current = view(), selected = shownSelection(state.visibleMap, current, state.selected);
    if (selected !== state.selected) { state.selected = selected; showAddress(); }
    const html = branchBarHtml(state.visibleMap, current.focus, { esc });
    if (html !== bar) { $('#branch-bar').innerHTML = bar = html; $('#branch-bar').hidden = !html; }
    return current;
  }
  async function reveal(nodeId) {
    const plan = revealPlan(state.visibleMap, nodeId, { folded: folded(), focus: state.branchFocus });
    const saved = plan.unfold && live();
    if (saved && !(await act(nodeId, 'reveal'))) return; // The save draws the map.
    if (plan.unfold && !saved) for (const id of ancestorsOf(state.visibleMap, nodeId)) opened.add(id);
    if (plan.leaveFocus) state.branchFocus = null;
    if (!saved || plan.leaveFocus) redraw();
    if (view().shown.has(nodeId)) focusNode(nodeId);
  }
  // Saves a fold while live; in a read-only view only opens one, in this browser. True when it changed or is on its way.
  async function setFold(id, collapsed) {
    const current = view();
    if (current.locked.has(id) || current.folded.has(id) === collapsed || pending.has(id)) return pending.has(id);
    if (!live()) { if (collapsed) return false; opened.add(id); redraw(); return true; }
    pending.add(id);
    try { return await act(id, 'fold', { collapsed }); } finally { pending.delete(id); }
  }
  async function click(event) {
    const fold = event.target.closest('[data-fold], [data-unfold]');
    if (fold) {
      closeMenus();
      const hide = fold.dataset.fold !== undefined;
      if (await setFold(hide ? fold.dataset.fold : fold.dataset.unfold, hide) && live()) toast(hide ? 'Its directions are hidden. Find an idea still finds them.' : 'Its directions are shown.');
      return true;
    }
    const branch = event.target.closest('[data-branch-focus]');
    if (!branch) return false;
    closeMenus();
    state.branchFocus = branch.dataset.branchFocus || null;
    redraw(); fitMap();
    return true;
  }
  function foldRow(id, collapsed) {
    const current = view();
    if (pending.has(id)) return true; // Already on its way: the second press does nothing.
    if (current.locked.has(id) || current.folded.has(id) === collapsed || (!live() && collapsed)) return false;
    setFold(id, collapsed);
    return true;
  }
  return { render, view, reveal, click, foldRow };
}
