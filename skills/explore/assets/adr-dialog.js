import { adrDialogHtml, adrDrafts, adrPathNote, adrSlug, adrFileText, adrToday, ADR_DRAFT } from './adr.js';
import { controlKey, cssQuote as quote } from './dialog-focus.js';

// The decision record dialog (F5), opened from Map tools: choose answers and findings, preview what the agent reads
// (F1's job preview), queue the draft, edit and accept it, then save it to docs/adr/ after previewing the exact file.
// `act(nodeId, type, input, options)` is the app's action call (Save file sends through the ADR route with it), `api`
// its read; `map()` the map shown; `live()` false in history, which is read-only. A poll never redraws away an edit in
// progress, and focus stays on the same control through a redraw.
export function adrDialog({ map, act, api, esc, toast, live, listening }) {
  const $ = selector => document.querySelector(selector), dialog = $('#adr-dialog'), body = $('#adr-body');
  let chosen = [], preview = null, edits = {}, hint = '', save = null, written = null;
  // Focus stays in the dialog: on the first of `selectors` found and enabled, else a heading.
  const focus = (...selectors) => { (selectors.filter(Boolean).map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? body.querySelector('#adr-draft-heading') ?? $('#adr-title'))?.focus(); };
  const render = () => {
    const shown = map(); if (!shown) return;
    if (preview && preview.mapRevision !== shown.revision) preview = null; // A preview describes the map it was made for.
    const html = adrDialogHtml({ map: shown, esc, listening: listening(), live: live(), chosen, preview, edits, hint, save });
    if (html === written) return; // Never compare with innerHTML read back.
    const active = document.activeElement, kept = active && body.contains?.(active) ? controlKey(active) : null;
    body.innerHTML = written = html;
    if (kept) focus(kept, '#adr-status', '[data-adr-node]');
  };
  const item = itemId => adrDrafts(map()).items.find(entry => entry.item.id === itemId);
  // The path note and Save file follow the number and name as they are typed, without a redraw.
  const pathChanged = async () => {
    const note = adrPathNote(save), noteBox = body.querySelector('#adr-path'), write = body.querySelector('[data-adr-write]');
    if (noteBox) noteBox.textContent = note.text; if (write) write.disabled = !note.valid || save.free === false;
    if (!note.valid) return;
    try { const answer = await api(`/maps/${map().id}/adr-file?proposal=${encodeURIComponent(save.proposalId)}&item=${encodeURIComponent(save.itemId)}&path=${encodeURIComponent(note.path)}`); if (save && adrPathNote(save).path === note.path) { save.free = answer.free; pathChanged(); } } catch { /* Save file says why. */ }
  };
  $('#adr-open').addEventListener('click', () => { chosen = []; preview = null; save = null; hint = ''; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); focus('#adr-text', '[data-adr-node]'); });
  body.addEventListener('change', event => {
    const box = event.target.closest?.('[data-adr-node]'); if (!box) return;
    const record = { nodeId: box.dataset.adrNode, ...(box.dataset.adrQuestion ? { questionId: box.dataset.adrQuestion } : {}) };
    chosen = chosen.filter(entry => entry.nodeId !== record.nodeId || (entry.questionId ?? null) !== (record.questionId ?? null));
    if (box.checked) chosen.push(record);
    if (preview) { preview = null; render(); return; } // A changed choice needs a new preview; focus stays on the box.
    const ask = body.querySelector('[data-adr-preview]'); if (ask) ask.disabled = !chosen.length;
  });
  body.addEventListener('input', event => {
    if (event.target.dataset?.adrText) edits[event.target.dataset.adrText] = event.target.value;
    if (event.target.id === 'adr-title-hint') hint = event.target.value;
    if (save && (event.target.id === 'adr-number' || event.target.id === 'adr-slug')) { save[event.target.id === 'adr-number' ? 'number' : 'slug'] = event.target.value.trim(); save.free = undefined; pathChanged(); }
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset, shown = map();
    if (data.adrPreview !== undefined) {
      target.disabled = true;
      try { preview = await api(`/maps/${shown.id}/job-preview?type=${ADR_DRAFT}&selection=${encodeURIComponent(JSON.stringify(chosen))}`); } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus('[data-adr-send]', '[data-adr-preview]'); return;
    }
    if (data.adrCancel !== undefined) { preview = null; render(); focus('[data-adr-node]'); return; }
    if (data.adrSend !== undefined) {
      if (await act(null, 'request-map-job', { jobType: ADR_DRAFT, selection: chosen, ...(hint.trim() ? { titleHint: hint.trim() } : {}) })) { chosen = []; preview = null; hint = ''; toast(listening() ? 'Your agent will draft the record next.' : 'Queued. Connect your agent to draft the record.'); }
      render(); focus('#adr-status', '[data-adr-preview]'); return;
    }
    if (data.adrStop) { if (await act(null, 'cancel-job', { jobId: data.adrStop })) toast('Stopped.'); render(); focus('[data-adr-node]'); return; }
    if (data.adrAccept) {
      const text = edits[data.adrAccept] ?? item(data.adrAccept)?.item.text;
      if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId: data.adrAccept, decision: 'accepted', text })) { delete edits[data.adrAccept]; toast('Accepted. Save it to docs/adr/ when you are ready.'); }
      render(); focus(`[data-adr-save="${quote(data.adrAccept)}"]`); return;
    }
    if (data.adrDismiss) { if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId: data.adrDismiss, decision: 'dismissed' })) { delete edits[data.adrDismiss]; toast('Dismissed.'); } render(); focus('[data-adr-node]'); return; }
    if (data.adrSave) {
      try {
        const file = await api(`/maps/${shown.id}/adr-file?proposal=${encodeURIComponent(data.proposal)}&item=${encodeURIComponent(data.adrSave)}`);
        const [, number, slug] = /^docs\/adr\/(\d{4})-(.+)\.md$/.exec(file.path) ?? [null, '0001', adrSlug(item(data.adrSave)?.item.title)];
        save = { itemId: data.adrSave, proposalId: data.proposal, number, slug, free: file.free, text: file.text, sha256: file.sha256 };
      } catch (error) { toast(error.message); return; }
      render(); focus('#adr-number'); return;
    }
    if (data.adrSaveCancel) { const itemId = save?.itemId; save = null; render(); focus(`[data-adr-save="${quote(itemId)}"]`); return; }
    if (data.adrWrite) {
      // Through the app's action pipeline on the ADR route: the same ordering, conflict handling and saved map.
      const note = adrPathNote(save); target.disabled = true; let refusal = '';
      const saved = await act(null, 'adr-save', { proposalId: save.proposalId, itemId: save.itemId, path: note.path, sha256: save.sha256 }, { route: 'adr-file', onError: message => { refusal = message; toast(message); } });
      if (saved) { toast(`Saved to ${note.path}.`); save = null; render(); focus(`#adr-item-${quote(data.adrWrite)} [data-adr-copy]`); return; }
      target.disabled = false;
      if (/A file is already at/.test(refusal)) { save.free = false; pathChanged(); } // Another tab or person took the number.
      return;
    }
    if (data.adrCopy) { // A saved record copies as it was saved, dated that day.
      const copied = item(data.adrCopy)?.item;
      try { await navigator.clipboard.writeText(adrFileText(copied?.text ?? '', adrToday(copied?.file ? new Date(copied.file.savedAt) : undefined))); toast('Copied.'); } catch { toast('Copying is not available here.'); } }
  });
  return { mapChanged() { if (dialog.open && !body.contains?.(document.activeElement?.closest?.('textarea, input:not([type=checkbox])') ?? null)) render(); } };
}
