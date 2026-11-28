import { shownNodes } from './workspace-view.js';

// Collapse and focus branches (Z6) in the workspace: the idea's ⋯ menu items, the marker's words, the branch bar
// and their clicks. Folds are saved with the map (the `fold` and `reveal` actions); branch focus is this browser's
// own (state.branchFocus) and resets when another map opens. Neither queues research or changes an idea.

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "5 hidden directions, 1 needs your answer, 2 need review": the folded idea's accessible label adds this.
export function hiddenLabel({ total, needsAnswer, needsReview }) {
  return [count(total, 'hidden direction', 'hidden directions'), needsAnswer ? `${needsAnswer} ${needsAnswer === 1 ? 'needs' : 'need'} your answer` : '',
    needsReview ? `${needsReview} ${needsReview === 1 ? 'needs' : 'need'} review` : ''].filter(Boolean).join(', ');
}

// The idea's ⋯ menu items. Folds are view state saved with the map, so growth history (`live` false) offers only
// branch focus, which is this browser's own.
export function foldMenuItems(node, { esc, map, folded = [], focus = null, live }) {
  const id = esc(node.id), item = (attribute, value, label) => `<button type="button" role="menuitem" tabindex="-1" ${attribute}="${value}">${label}</button>`;
  const below = [], children = new Map();
  for (const other of map.nodes) { if (!children.has(other.parentId)) children.set(other.parentId, []); children.get(other.parentId).push(other); }
  for (const stack = [...(children.get(node.id) ?? [])]; stack.length;) { const next = stack.pop(); below.push(next); stack.push(...(children.get(next.id) ?? [])); }
  const fold = !live || !below.length ? '' : folded.includes(node.id) ? item('data-unfold', id, 'Show its directions') : item('data-fold', id, `Hide its directions (${below.length})`);
  const branch = node.id === map.rootId ? '' : focus === node.id ? item('data-branch-focus', '', 'Show whole map') : item('data-branch-focus', id, 'Show only this branch');
  return fold + branch;
}

// Above the canvas while one branch is shown.
export function branchBarHtml(map, focus, { esc }) {
  const node = focus ? map.nodes.find(item => item.id === focus) : null;
  return node ? `<p>Showing one branch: <strong>${esc(node.title)}</strong></p><button type="button" class="secondary" data-branch-focus="" data-command="whole-map" data-command-label="Show whole map">Show whole map</button>` : '';
}

// The selection a view can show: the selected idea, or the nearest shown idea above it (a fold hid it).
export function shownSelection(map, view, selected) {
  const byId = new Map(map.nodes.map(node => [node.id, node]));
  let at = selected;
  for (const seen = new Set(); at && !view.shown.has(at) && !seen.has(at); at = byId.get(at)?.parentId ?? null) seen.add(at);
  return at && view.shown.has(at) ? at : selected && view.shown.has(map.rootId) ? map.rootId : null;
}
// What it takes to show a hidden idea: leaving branch focus, unfolding the folds above it, both or neither.
export function revealPlan(map, id, { folded = [], focus = null }) {
  const leaveFocus = !!focus && !shownNodes(map, { focus }).shown.has(id);
  return { leaveFocus, unfold: !shownNodes(map, { folded, focus: leaveFocus ? null : focus }).shown.has(id) };
}

// Hide or show an idea's directions, and branch focus, from the ⋯ menu or the branch bar. Returns true when handled.
export async function foldsClick(event, { state, act, show, toast, closeMenus }) {
  const fold = event.target.closest('[data-fold], [data-unfold]');
  if (fold) {
    closeMenus();
    const hide = fold.dataset.fold !== undefined;
    if (await act(hide ? fold.dataset.fold : fold.dataset.unfold, 'fold', { collapsed: hide })) toast(hide ? 'Its directions are hidden. Find an idea still finds them.' : 'Its directions are shown.');
    return true;
  }
  const branch = event.target.closest('[data-branch-focus]');
  if (!branch) return false;
  closeMenus();
  state.branchFocus = branch.dataset.branchFocus || null;
  show();
  return true;
}
