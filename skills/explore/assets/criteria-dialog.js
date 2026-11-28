import { criteriaDialogHtml, criteriaKey } from './criteria.js';

// The criteria dialog (C9), opened by Compare with my criteria under an idea's options on the live map. The user adds,
// edits and removes criteria and sets priorities, asks the agent to reconsider (saving unsaved edits first), and uses
// the revised comparison or keeps the original. `act(nodeId, type, input)` is the app's action call; `map()` is the map
// shown. `mapChanged()` redraws it unless the criteria differ from what is saved.
export function criteriaDialog({ map, act, esc, toast, listening }) {
  const $ = selector => document.querySelector(selector), dialog = $('#criteria-dialog'), body = $('#criteria-body');
  let nodeId = null, draft = [], written = null;
  const node = () => map()?.nodes.find(item => item.id === nodeId);
  const saved = () => (node()?.criteria ?? []).map(({ id, label, priority }) => ({ id, label, priority }));
  // Edited while the draft differs from the saved criteria: typing the original back counts as unedited.
  const edited = () => criteriaKey(draft) !== criteriaKey(saved());
  const reset = () => { draft = saved(); };
  const render = () => {
    const current = node(); if (!current) return;
    const html = criteriaDialogHtml({ map: map(), node: current, esc, draft, edited: edited(), listening: listening() });
    if (html !== written) body.innerHTML = written = html; // Never compare with innerHTML read back.
  };
  // After a redraw, focus stays in the dialog: on the first of `selectors` found, else its heading.
  const focus = (...selectors) => { (selectors.map(selector => body.querySelector(selector)).find(Boolean) ?? $('#criteria-title'))?.focus(); };
  // Use revised comparison waits while the criteria are edited and unsaved; typing does not redraw the dialog.
  const editedChanged = () => { const adopt = body.querySelector('[data-reconsider-adopt]'), note = body.querySelector('#criteria-adopt-note'); if (adopt) adopt.disabled = edited(); if (note) note.hidden = !edited(); };
  const save = () => act(nodeId, 'set-criteria', { criteria: draft.map(({ id, label, priority }) => (id ? { id, label, priority } : { label, priority })) });
  $('#detail').addEventListener('click', event => {
    const open = event.target.closest('[data-criteria-open]'); if (!open) return;
    nodeId = open.dataset.criteriaOpen; reset(); written = null; render(); dialog.showModal();
  });
  body.addEventListener('input', event => { const at = event.target.dataset?.criterionLabel; if (at !== undefined && draft[at]) { draft[at].label = event.target.value; editedChanged(); } });
  body.addEventListener('change', event => { const at = event.target.dataset?.criterionPriority; if (at !== undefined && draft[at]) { draft[at].priority = event.target.value; editedChanged(); } });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if ('criterionAdd' in data) { draft.push({ label: '', priority: 'normal' }); render(); focus(`#criterion-${draft.length - 1}`); return; }
    if (data.criterionRemove !== undefined) {
      const at = Number(data.criterionRemove); draft.splice(at, 1); render();
      focus(`#criterion-${at}`, `#criterion-${at - 1}`, '[data-criterion-add]'); return;
    }
    if ('criteriaSave' in data) { if (await save()) { reset(); render(); toast('Criteria saved.'); focus('[data-criteria-save]'); } return; }
    if ('reconsiderAsk' in data) {
      target.disabled = true;
      if (edited() && !(await save())) { target.disabled = false; return; } // Nothing is asked with criteria that did not save.
      reset();
      if (await act(nodeId, 'reconsider', {})) toast(listening() ? 'Your agent will reconsider next.' : 'Queued. Connect your agent to reconsider.');
      target.disabled = false; // A redraw replaces the button only when something changed.
      render(); focus('#criteria-status', '[data-reconsider-ask]'); return;
    }
    if (data.reconsiderAdopt) { if (await act(nodeId, 'adopt-reconsideration', { jobId: data.reconsiderAdopt })) toast('Using the revised comparison.'); render(); focus('#criteria-proposal'); return; }
    if (data.reconsiderDismiss) { if (await act(nodeId, 'dismiss-reconsideration', { jobId: data.reconsiderDismiss })) toast('Kept the original recommendation.'); render(); focus('[data-reconsider-ask]'); return; }
    if (data.reconsiderStop) { if (await act(null, 'cancel-job', { jobId: data.reconsiderStop })) toast('Stopped.'); render(); focus('[data-reconsider-ask]'); }
  });
  return { mapChanged() { if (dialog.open && !edited()) { reset(); render(); } } };
}
