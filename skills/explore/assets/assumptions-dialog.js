import { assumptionRegister, assumptionsHtml, dependentsHtml } from './assumptions.js';

// The assumptions register dialog (K6), opened from Map tools. The user adds, edits or removes what would disprove
// one of their own assumptions; choosing an idea closes it and focuses that idea. Opening it never starts work.
// `act(nodeId, type, input)` is the app's action call; `map()` is the map shown, and `note()` the inspector's read-only
// note for growth history or a saved version ('' on the live map), shown above the register, which then offers no
// edits. `mapChanged()` redraws the open dialog unless a note is being edited, and only when its content changed.
export function assumptionsDialog({ act, map, note, esc, toast, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#assumptions-dialog'), body = $('#assumptions-body');
  let editing = null, written = null;
  const render = () => {
    const shown = map(); if (!shown) return false;
    const entries = assumptionRegister(shown), yours = entries.filter(entry => entry.kind === 'answer').length, readOnly = note();
    const html = `${readOnly ? `<p class="form-note">${esc(readOnly)}</p>` : ''}${assumptionsHtml(entries, { esc, live: !readOnly, editing })}`;
    if (html !== written) body.innerHTML = written = html; // Never compare with innerHTML read back.
    $('#assumptions-summary').textContent = `Your assumptions: ${yours} · Agent interpretations: ${entries.length - yours}. Opening this never starts work.`;
    return true;
  };
  // After the editor closes, focus returns to the entry's Add or Edit button.
  const closeEditor = key => { editing = null; render(); body.querySelector(`[data-assumption-edit="${key}"]`)?.focus(); };
  $('#assumptions-open').addEventListener('click', () => {
    editing = null;
    if (!render()) return;
    $('#tools-dialog').close(); dialog.showModal();
  });
  // A list of what rests on an entry is filled each time it opens, from the map as it is then.
  body.addEventListener('toggle', event => {
    const list = event.target.dataset?.dependents !== undefined && event.target.open ? event.target.querySelector('.assumption-dependent-list') : null;
    if (list) list.innerHTML = dependentsHtml(map(), event.target.dataset.dependents, { esc });
  }, true);
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.focusNode) { dialog.close(); focusNode(data.focusNode); return; }
    if (data.assumptionEdit) { editing = data.assumptionEdit; render(); body.querySelector('textarea')?.focus(); return; }
    if (data.assumptionCancel !== undefined) { closeEditor(data.assumptionCancel); return; }
    const key = data.assumptionSave || data.assumptionRemove; if (!key) return;
    const [nodeId, questionId] = key.split(' ');
    if (await act(nodeId, 'set-disprove-if', { questionId, text: data.assumptionSave ? $('#assumption-disprove').value : '' })) {
      closeEditor(key); toast(data.assumptionSave ? 'Saved.' : 'Removed.');
    }
  });
  return { mapChanged() { if (dialog.open && !editing) render(); } };
}
