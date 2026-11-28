import { inboxHtml, openThoughts } from './inbox.js';

// The inbox dialog (K8), opened from Map tools: jot a thought, edit or discard one, ask the agent where they belong
// (after a preview of what it reads), and accept or dismiss each proposal. Capturing works with no agent connected.
// `act(nodeId, type, input)` is the app's action call; `map()` the map shown; `live()` false (history) is read-only.
// `mapChanged()` redraws the open dialog unless a thought is being edited, and keeps the Map tools line current.
export function inboxDialog({ map, act, esc, toast, live, listening, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#inbox-dialog'), body = $('#inbox-body'), capture = $('#inbox-capture'), text = $('#inbox-capture-text');
  let editing = null, preview = false, written = null;
  const summary = () => { const shown = map(); if (!shown) return; const count = openThoughts(shown).length; $('#inbox-summary').textContent = count ? `${count === 1 ? '1 open thought' : `${count} open thoughts`} in the inbox.` : 'No open thoughts.'; };
  const render = () => {
    const shown = map(); if (!shown) return;
    const html = inboxHtml({ map: shown, esc, live: live(), editing, preview, listening: listening() });
    if (html !== written) body.innerHTML = written = html; // Never compare with innerHTML read back.
    summary();
  };
  $('#inbox-open').addEventListener('click', () => { editing = null; preview = false; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); text.focus(); });
  capture.addEventListener('submit', async event => {
    event.preventDefault();
    if (!live()) { toast('Return to the live map to add a thought.'); return; }
    if (await act(null, 'inbox-add', { text: text.value })) { text.value = ''; render(); toast('Added to the inbox.'); }
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.focusNode) { dialog.close(); focusNode(data.focusNode); return; }
    if (data.thoughtEdit) { editing = data.thoughtEdit; render(); body.querySelector('textarea')?.focus(); return; }
    if (data.thoughtCancel !== undefined) { editing = null; render(); return; }
    if (data.thoughtSave) { if (await act(null, 'inbox-edit', { thoughtId: data.thoughtSave, text: $('#thought-edit').value })) { editing = null; render(); } return; }
    if (data.thoughtDiscard) { if (await act(null, 'inbox-discard', { thoughtId: data.thoughtDiscard })) { render(); toast('Discarded.'); } return; }
    if (data.inboxSort !== undefined) { preview = true; render(); return; }
    if (data.inboxCancel !== undefined) { preview = false; render(); return; }
    if (data.inboxSend !== undefined) {
      preview = false;
      if (await act(null, 'request-map-job', { jobType: 'sort-thoughts' })) toast(listening() ? 'Your agent will sort these next.' : 'Queued. Connect your agent to sort these.');
      render(); return;
    }
    if (data.inboxStop) { if (await act(null, 'cancel-job', { jobId: data.inboxStop })) toast('Stopped.'); render(); return; }
    if (data.placeThought) { if (await act(null, 'place-thought', { proposalId: data.proposal, itemId: data.placeThought })) toast('Placed.'); render(); return; }
    if (data.dismissItem) { if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId: data.dismissItem, decision: 'dismissed' })) toast('Dismissed; the thought stays in the inbox.'); render(); }
  });
  return { mapChanged() { if (dialog.open && !editing) render(); else summary(); } };
}
