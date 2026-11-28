import { assumptionRegister, assumptionsHtml } from './assumptions.js';

// The assumptions register dialog (K6), opened from Map tools. The user adds, edits or removes what would disprove
// one of their own assumptions; choosing an idea closes it and focuses that idea. Opening it never starts work.
// `act(nodeId, type, input)` is the app's action call; `map()` is the map shown, and `note()` the inspector's read-only
// note for growth history or a saved version ('' on the live map), shown above the register, which then offers no
// edits. `mapChanged()` redraws the open dialog unless a note is being edited.
export function assumptionsDialog({ act, map, note, esc, toast, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#assumptions-dialog'), body = $('#assumptions-body');
  let editing = null;
  const render = () => {
    const shown = map(); if (!shown) return false;
    const entries = assumptionRegister(shown), yours = entries.filter(entry => entry.kind === 'answer').length;
    const readOnly = note();
    body.innerHTML = `${readOnly ? `<p class="form-note">${esc(readOnly)}</p>` : ''}${assumptionsHtml(entries, { esc, live: !readOnly, editing, map: shown })}`;
    $('#assumptions-summary').textContent = `Your assumptions: ${yours} · Agent interpretations: ${entries.length - yours}. Opening this never starts work.`;
    return true;
  };
  $('#assumptions-open').addEventListener('click', () => {
    editing = null;
    if (!render()) return;
    $('#tools-dialog').close(); dialog.showModal();
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.focusNode) { dialog.close(); focusNode(data.focusNode); return; }
    if (data.assumptionEdit) { editing = data.assumptionEdit; render(); body.querySelector('textarea')?.focus(); return; }
    if ('assumptionCancel' in data) { editing = null; render(); return; }
    const key = data.assumptionSave || data.assumptionRemove; if (!key) return;
    const [nodeId, questionId] = key.split(' ');
    if (await act(nodeId, 'set-disprove-if', { questionId, text: data.assumptionSave ? $('#assumption-disprove').value : '' })) {
      editing = null; render(); toast(data.assumptionSave ? 'Saved.' : 'Removed.');
    }
  });
  return { mapChanged() { if (dialog.open && !editing) render(); } };
}
