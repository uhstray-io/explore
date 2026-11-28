// "Done when" for a branch (K4): what the user says would be enough, such as "a shortlist of two". It is optional
// and out of the way: a small field under Explore or Retry, an Edit control while the branch is unfinished and not
// running, and read-only once the branch is complete. Only the user sets it; the agent stops there.
const placeholder = 'a shortlist of two options';

// The inspector's part for `node`. `editing` shows the edit field; `live` is false while history is shown.
export function doneWhenSection(node, { esc, completed, live, editing = false }) {
  if (!live) return '';
  const id = esc(node.id), editable = !completed && node.status !== 'running';
  if (editing && editable) return `<div class="done-when-form"><label for="done-when-edit-${id}">Done when</label><input id="done-when-edit-${id}" data-done-when-text="${id}" maxlength="400" placeholder="${placeholder}" value="${esc(node.doneWhen ?? '')}"><button type="button" class="primary" data-done-when-save="${id}">Save</button><button type="button" class="secondary" data-done-when-cancel>Cancel</button></div>`;
  const shown = node.doneWhen ? `<p class="done-when"><strong>Done when:</strong> ${esc(node.doneWhen)}${editable ? ` <button type="button" class="text-button" data-done-when-edit="${id}">Edit</button>` : ''}</p>` : '';
  // Under Explore and Retry: hidden until asked for, and a retry starts from the saved value.
  const field = !completed && ['suggested', 'interrupted'].includes(node.status)
    ? `<details class="done-when-field"><summary>Set when it’s done (optional)</summary><label class="visually-hidden" for="done-when-${id}">Done when</label><input id="done-when-${id}" data-done-when-input="${id}" maxlength="400" placeholder="${placeholder}" value="${esc(node.doneWhen ?? '')}"></details>` : '';
  return shown + field;
}

// What Explore or Retry sends: the field's value once the user opened it (empty clears it), otherwise nothing.
export function doneWhenChoice(nodeId) {
  const input = [...document.querySelectorAll('[data-done-when-input]')].find(item => item.dataset.doneWhenInput === nodeId);
  return input && input.closest('details')?.open ? { doneWhen: input.value } : {};
}

// Edit, Save and Cancel in the inspector, and Enter to save. Returns true when it handled the click.
export async function doneWhenClick(event, { state, act, toast, renderDetail }) {
  const edit = event.target.closest('[data-done-when-edit]');
  if (edit) {
    state.doneWhenEditing = edit.dataset.doneWhenEdit; renderDetail(true);
    document.querySelector('#detail [data-done-when-text]')?.focus();
    return true;
  }
  if (event.target.closest('[data-done-when-cancel]')) { state.doneWhenEditing = null; renderDetail(true); return true; }
  const save = event.target.closest('[data-done-when-save]');
  if (!save) return false;
  const nodeId = save.dataset.doneWhenSave, input = document.querySelector(`#detail [data-done-when-text]`);
  save.disabled = true;
  if (await act(nodeId, 'set-done-when', { doneWhen: input?.value ?? '' })) { state.doneWhenEditing = null; toast(input?.value.trim() ? 'Stopping point saved.' : 'Stopping point cleared.'); }
  save.disabled = false; renderDetail(true);
  return true;
}
export function doneWhenKey(event) {
  if (event.key === 'Enter' && event.target.matches?.('[data-done-when-text]')) { event.preventDefault(); document.querySelector('#detail [data-done-when-save]')?.click(); }
}
