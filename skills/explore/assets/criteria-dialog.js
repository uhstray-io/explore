import { criteriaDialogHtml, criteriaKey } from './criteria.js';

// The criteria dialog (C9), opened by Compare with my criteria under an idea's options on the live map. The user adds,
// edits and removes criteria and sets priorities, asks the agent to reconsider (saving unsaved edits first), and uses
// the revised comparison or keeps the original. `act(nodeId, type, input)` is the app's action call; `map()` is the map
// shown. `mapChanged()` redraws it unless the criteria are being edited; then it only says if they were saved elsewhere.
export function criteriaDialog({ map, act, esc, toast, listening }) {
  const $ = selector => document.querySelector(selector), dialog = $('#criteria-dialog'), body = $('#criteria-body');
  let nodeId = null, draft = [], base = [], written = null;
  const node = () => map()?.nodes.find(item => item.id === nodeId);
  const saved = () => (node()?.criteria ?? []).map(({ id, label, priority }) => ({ id, label, priority }));
  // Edited while the draft differs from the criteria it started from (`base`), compared as the Store does: typing the
  // original back counts as unedited. Changed elsewhere while the saved criteria moved away from `base`.
  const edited = () => criteriaKey(draft) !== criteriaKey(base);
  const changedElsewhere = () => criteriaKey(saved()) !== criteriaKey(base);
  const reset = () => { base = saved(); draft = base.map(item => ({ ...item })); };
  const render = () => {
    const current = node(); if (!current) return;
    const html = criteriaDialogHtml({ map: map(), node: current, esc, draft, edited: edited(), changedElsewhere: edited() && changedElsewhere(), listening: listening() });
    if (html !== written) body.innerHTML = written = html; // Never compare with innerHTML read back.
  };
  // After a redraw, focus stays in the dialog: on the first of `selectors` found, else its heading.
  const focus = (...selectors) => { (selectors.map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? $('#criteria-title'))?.focus(); };
  // Use revised comparison waits while the criteria are edited and unsaved; typing does not redraw the dialog.
  const editedChanged = () => {
    const adopt = body.querySelector('[data-reconsider-adopt]'), note = body.querySelector('#criteria-adopt-note'), now = edited();
    if (adopt) { adopt.disabled = now; if (now) adopt.setAttribute('aria-describedby', 'criteria-adopt-note'); else adopt.removeAttribute('aria-describedby'); }
    if (note) note.hidden = !now;
  };
  // `expected` is what the edits started from, so the Store refuses them if the criteria were saved elsewhere since.
  const save = () => act(nodeId, 'set-criteria', { criteria: draft.map(({ id, label, priority }) => (id ? { id, label, priority } : { label, priority })), expected: base });
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
    if ('criteriaReload' in data) { reset(); render(); focus('#criterion-0', '[data-criterion-add]'); return; }
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
  return { mapChanged() {
    if (!dialog.open) return;
    if (!edited()) { reset(); render(); return; }
    const note = body.querySelector('#criteria-elsewhere'); if (note) note.hidden = !changedElsewhere(); // Typing is never redrawn away.
  } };
}
