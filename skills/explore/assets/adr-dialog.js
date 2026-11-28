import { adrDialogHtml, adrPathNote, adrSlug, adrFileText, adrToday, ADR_DRAFT } from './adr.js';
import { recordDraftDialog } from './record-draft-dialog.js';
import { cssQuote as quote } from './dialog-focus.js';

// The decision record dialog (F5), opened from Map tools, on the shared draft dialog (record-draft-dialog.js): choose answers
// and findings, preview what the agent reads, queue the draft, edit and accept it. Its own part: the title the user has
// in mind, Save file to docs/adr/ after previewing the exact file, and Copy. `act(nodeId, type, input, options)` is the
// app's action call (Save file sends through the ADR route with it), `api` its read.
export function adrDialog({ map, act, api, esc, toast, live, listening }) {
  // The path note and Save file follow the number and name as they are typed, without a redraw.
  const pathChanged = async ({ state, body }) => {
    const save = state.save, note = adrPathNote(save), noteBox = body.querySelector('#adr-path'), write = body.querySelector('[data-adr-write]');
    if (noteBox) noteBox.textContent = note.text; if (write) write.disabled = !note.valid || save.free === false;
    if (!note.valid) return;
    try { const answer = await api(`/maps/${map().id}/adr-file?proposal=${encodeURIComponent(save.proposalId)}&item=${encodeURIComponent(save.itemId)}&path=${encodeURIComponent(note.path)}`); if (state.save && adrPathNote(state.save).path === note.path) { state.save.free = answer.free; pathChanged({ state, body }); } } catch { /* Save file says why. */ }
  };
  return recordDraftDialog({ prefix: 'adr', type: ADR_DRAFT, map, act, api, esc, toast, live, listening, html: adrDialogHtml, extra: {
    initial: () => ({ hint: '', save: null }),
    sent: () => ({ hint: '' }), // An open Save preview stays open.
    request: state => (state.hint.trim() ? { titleHint: state.hint.trim() } : {}),
    words: { queued: listening => (listening ? 'Your agent will draft the record next.' : 'Queued. Connect your agent to draft the record.'), accepted: 'Accepted. Save it to docs/adr/ when you are ready.' },
    acceptedFocus: itemId => `[data-adr-save="${quote(itemId)}"]`,
    input: (event, ctx) => {
      if (event.target.id === 'adr-title-hint') ctx.state.hint = event.target.value;
      if (ctx.state.save && (event.target.id === 'adr-number' || event.target.id === 'adr-slug')) { ctx.state.save[event.target.id === 'adr-number' ? 'number' : 'slug'] = event.target.value.trim(); ctx.state.save.free = undefined; pathChanged(ctx); }
    },
    click: async (event, target, ctx) => {
      const data = target.dataset, { state } = ctx;
      if (data.adrSave) {
        try {
          const file = await api(`/maps/${map().id}/adr-file?proposal=${encodeURIComponent(data.proposal)}&item=${encodeURIComponent(data.adrSave)}`);
          const [, number, slug] = /^docs\/adr\/(\d{4})-(.+)\.md$/.exec(file.path) ?? [null, '0001', adrSlug(ctx.item(data.adrSave)?.item.title)];
          state.save = { itemId: data.adrSave, proposalId: data.proposal, number, slug, free: file.free, text: file.text, sha256: file.sha256 };
        } catch (error) { toast(error.message); return; }
        ctx.render(); ctx.focus('#adr-number'); return;
      }
      if (data.adrSaveCancel) { const itemId = state.save?.itemId; state.save = null; ctx.render(); ctx.focus(`[data-adr-save="${quote(itemId)}"]`); return; }
      if (data.adrWrite) {
        // Through the app's action pipeline on the ADR route: the same ordering, conflict handling and saved map.
        const note = adrPathNote(state.save); target.disabled = true; let refusal = '';
        const saved = await act(null, 'adr-save', { proposalId: state.save.proposalId, itemId: state.save.itemId, path: note.path, sha256: state.save.sha256 }, { route: 'adr-file', onError: message => { refusal = message; toast(message); } });
        if (saved) { toast(`Saved to ${note.path}.`); state.save = null; ctx.render(); ctx.focus(`#adr-item-${quote(data.adrWrite)} [data-adr-copy]`); return; }
        target.disabled = false;
        if (/A file is already at/.test(refusal)) { state.save.free = false; pathChanged(ctx); } // Another tab or person took the number.
        return;
      }
      if (data.adrCopy) { // A saved record copies as it was saved, dated that day.
        const copied = ctx.item(data.adrCopy)?.item;
        try { await navigator.clipboard.writeText(adrFileText(copied?.text ?? '', adrToday(copied?.file ? new Date(copied.file.savedAt) : undefined))); toast('Copied.'); } catch { toast('Copying is not available here.'); }
      }
    },
  } });
}
