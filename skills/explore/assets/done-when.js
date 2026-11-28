// "Done when" for a branch (K4): what the user says would be enough, such as "a shortlist of two". It is optional
// and out of the way: a small field under Explore or Retry, an Edit control while the branch is unfinished and not
// running, and read-only once complete or in history. Only the user sets it; the agent stops there.
const placeholder = 'a shortlist of two options';
// While the branch is unfinished and not running: running work already has its packet.
export const canSetDoneWhen = (node, completed) => !completed && node.status !== 'running';
// Explore or Retry, which carry the optional field.
export const canExplore = (node, completed) => !completed && ['suggested', 'interrupted'].includes(node.status);
// Drafts, so a poll that re-renders the inspector keeps what the user is typing.
const fieldKey = id => `done-when:${id}`, editKey = id => `done-when-edit:${id}`;
const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// The inspector's part for `node`. `editing` shows the edit field; `live` is false while history is shown.
export function doneWhenSection(node, { esc, completed, live, editing = false, drafts = {} }) {
  const id = esc(node.id), saved = node.doneWhen ?? '';
  const shown = edit => (node.doneWhen ? `<p class="done-when"><strong>Done when:</strong> ${esc(node.doneWhen)}${edit ? ` <button type="button" class="text-button" data-done-when-edit="${id}">Edit</button>` : ''}</p>` : '');
  if (!live) return shown(false);
  const editable = canSetDoneWhen(node, completed);
  if (editing && editable) return `<div class="done-when-form"><label for="done-when-edit-${id}">Done when</label><input id="done-when-edit-${id}" data-done-when-text="${id}" data-draft="${esc(editKey(node.id))}" maxlength="400" placeholder="${placeholder}" value="${esc(drafts[editKey(node.id)] ?? saved)}"><button type="button" class="primary" data-done-when-save="${id}">Save</button><button type="button" class="secondary" data-done-when-cancel="${id}">Cancel</button></div>`;
  // Under Explore and Retry: hidden until asked for, and a retry starts from the saved value.
  const field = canExplore(node, completed)
    ? `<details class="done-when-field" data-editor="done-when"><summary>Set when it’s done (optional)</summary><label class="visually-hidden" for="done-when-${id}">Done when</label><input id="done-when-${id}" data-done-when-input="${id}" data-draft="${esc(fieldKey(node.id))}" maxlength="400" placeholder="${placeholder}" value="${esc(drafts[fieldKey(node.id)] ?? saved)}"></details>` : '';
  return shown(editable) + field;
}
// The idea's ⋯ menu item, when the stopping point can be set now.
export function doneWhenMenuItem(node, { esc, completed, live }) {
  return live && canSetDoneWhen(node, completed) ? `<button type="button" role="menuitem" tabindex="-1" data-done-when-edit="${esc(node.id)}">Set when it’s done</button>` : '';
}

const focusAfter = () => (document.querySelector('#detail [data-done-when-edit]') ?? document.querySelector('#detail .done-when'))?.focus?.();
// Explore (with the field's value once the user opened it), Edit, Save and Cancel. Returns true when handled.
export async function doneWhenClick(event, { state, act, toast, renderDetail }) {
  const explore = event.target.closest('[data-explore]');
  if (explore) {
    const nodeId = explore.dataset.explore, input = [...document.querySelectorAll('[data-done-when-input]')].find(item => item.dataset.doneWhenInput === nodeId);
    const choice = input && input.closest('details')?.open ? { doneWhen: input.value } : {};
    explore.disabled = true;
    if (await act(nodeId, 'activate', choice)) { delete state.drafts[fieldKey(nodeId)]; toast('Exploration queued.'); }
    explore.disabled = false;
    return true;
  }
  const edit = event.target.closest('[data-done-when-edit]');
  if (edit) {
    state.doneWhenEditing = edit.dataset.doneWhenEdit; renderDetail(true);
    document.querySelector('#detail [data-done-when-text]')?.focus();
    return true;
  }
  const cancel = event.target.closest('[data-done-when-cancel]');
  if (cancel) { delete state.drafts[editKey(cancel.dataset.doneWhenCancel)]; state.doneWhenEditing = null; renderDetail(true); focusAfter(); return true; }
  const save = event.target.closest('[data-done-when-save]');
  if (!save) return false;
  const nodeId = save.dataset.doneWhenSave, value = document.querySelector('#detail [data-done-when-text]')?.value ?? '';
  const node = state.map?.nodes.find(item => item.id === nodeId);
  // Nothing changed: just close the field.
  if (oneLine(value) === (node?.doneWhen ?? '')) { delete state.drafts[editKey(nodeId)]; state.doneWhenEditing = null; renderDetail(true); focusAfter(); return true; }
  save.disabled = true;
  if (await act(nodeId, 'set-done-when', { doneWhen: value })) { delete state.drafts[editKey(nodeId)]; state.doneWhenEditing = null; toast(oneLine(value) ? 'Stopping point saved.' : 'Stopping point cleared.'); }
  save.disabled = false; renderDetail(true); focusAfter();
  return true;
}
export function doneWhenKey(event) {
  if (event.key !== 'Enter' || event.isComposing || !event.target.matches?.('[data-done-when-text]')) return;
  event.preventDefault(); document.querySelector('#detail [data-done-when-save]')?.click();
}
