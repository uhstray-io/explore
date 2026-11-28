import { handoffDialogHtml, handoffFileText, handoffFilename, HANDOFF } from './handoff.js';
import { controlKey, cssQuote as quote } from './dialog-focus.js';

// The Implementation handoff dialog (F4), opened from Map tools: pick what to write and the records it rests on, preview
// what the agent reads (F1's job preview), queue it, edit and accept the result, then copy or download it with Explore's
// footer. `act` and `api` come from the app, and `download(text, type, name)` saves a file. `map()` is the map shown;
// `live()` is false in history, which is read-only. A poll never redraws away an edit in progress, and focus stays on
// the same control through a redraw.
export function handoffDialog({ map, act, api, esc, toast, live, listening, download }) {
  const $ = selector => document.querySelector(selector), dialog = $('#handoff-dialog'), body = $('#handoff-body');
  let chosen = [], format = 'brief', preview = null, edits = {}, written = null;
  // Focus stays in the dialog: on the first of `selectors` found and enabled, else a heading.
  const focus = (...selectors) => { (selectors.filter(Boolean).map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? body.querySelector('#handoff-draft-heading') ?? $('#handoff-title'))?.focus(); };
  const render = () => {
    const shown = map(); if (!shown) return;
    if (preview && preview.mapRevision !== shown.revision) preview = null; // A preview describes the map it was made for.
    const html = handoffDialogHtml({ map: shown, esc, listening: listening(), live: live(), chosen, format, preview, edits });
    if (html === written) return; // Never compare with innerHTML read back.
    const active = document.activeElement, kept = active && body.contains?.(active) ? controlKey(active) : null;
    body.innerHTML = written = html;
    if (kept) focus(kept, '#handoff-status', '[data-handoff-node]');
  };
  const find = (proposalId, itemId) => { const proposal = (map()?.proposals ?? []).find(entry => entry.id === proposalId && entry.type === HANDOFF), item = proposal?.items.find(entry => entry.id === itemId); return item ? { proposal, item } : null; };
  $('#handoff-open').addEventListener('click', () => { chosen = []; preview = null; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); focus('#handoff-text', '#handoff-format'); });
  body.addEventListener('change', event => {
    if (event.target.id === 'handoff-format') { format = event.target.value; if (preview) { preview = null; render(); } return; } // A new format needs a new preview.
    const box = event.target.closest?.('[data-handoff-node]'); if (!box) return;
    const record = { nodeId: box.dataset.handoffNode, ...(box.dataset.handoffQuestion ? { questionId: box.dataset.handoffQuestion } : {}) };
    chosen = chosen.filter(entry => entry.nodeId !== record.nodeId || (entry.questionId ?? null) !== (record.questionId ?? null));
    if (box.checked) chosen.push(record);
    if (preview) { preview = null; render(); return; } // A changed choice needs a new preview; focus stays on the box.
    const ask = body.querySelector('[data-handoff-preview]'); if (ask) ask.disabled = !chosen.length;
  });
  body.addEventListener('input', event => { if (event.target.dataset?.handoffText) edits[event.target.dataset.handoffText] = event.target.value; });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset, shown = map();
    if (data.handoffPreview !== undefined) {
      const asked = JSON.stringify([chosen, format]);
      target.disabled = true;
      try {
        const answer = await api(`/maps/${shown.id}/job-preview?type=${HANDOFF}&selection=${encodeURIComponent(JSON.stringify(chosen))}&options=${encodeURIComponent(JSON.stringify({ format }))}`);
        if (JSON.stringify([chosen, format]) === asked) preview = answer; // Never a preview of a choice the user has since changed.
      } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus('[data-handoff-send]', '[data-handoff-preview]'); return;
    }
    if (data.handoffCancel !== undefined) { preview = null; render(); focus('[data-handoff-node]'); return; }
    if (data.handoffSend !== undefined) {
      if (await act(null, 'request-map-job', { jobType: HANDOFF, selection: chosen, options: { format } })) { chosen = []; preview = null; toast(listening() ? 'Your agent will write the handoff next.' : 'Queued. Connect your agent to write the handoff.'); }
      render(); focus('#handoff-status', '[data-handoff-preview]'); return;
    }
    if (data.handoffStop) { if (await act(null, 'cancel-job', { jobId: data.handoffStop })) toast('Stopped.'); render(); focus('[data-handoff-node]'); return; }
    if (data.handoffAccept) {
      const text = edits[data.handoffAccept] ?? find(data.proposal, data.handoffAccept)?.item.text;
      if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId: data.handoffAccept, decision: 'accepted', text })) { delete edits[data.handoffAccept]; toast('Accepted. Copy or download it when you are ready.'); }
      render(); focus(`[data-handoff-copy="${quote(data.handoffAccept)}"]`); return;
    }
    if (data.handoffDismiss) { if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId: data.handoffDismiss, decision: 'dismissed' })) { delete edits[data.handoffDismiss]; toast('Dismissed.'); } render(); focus('[data-handoff-node]', '#handoff-format'); return; }
    const itemId = data.handoffCopy || data.handoffDownload;
    if (itemId) {
      const found = find(data.proposal, itemId);
      if (found?.item.review !== 'accepted') return; // Only an accepted handoff leaves Explore.
      const text = handoffFileText(shown, found.proposal, found.item);
      if (data.handoffDownload) { download(text, 'text/markdown;charset=utf-8', handoffFilename(found.item.title)); toast('Downloaded as Markdown.'); return; }
      try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Copying is not available here.'); }
    }
  });
  return { mapChanged() { if (dialog.open && !body.contains?.(document.activeElement?.closest?.('textarea, input:not([type=checkbox])') ?? null)) render(); } };
}
