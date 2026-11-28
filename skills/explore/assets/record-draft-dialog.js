// The one dialog controller for drafts written from records the user chose (F4 implementation handoff, F5 decision
// record), in the browser only. Each draft type plugs in what is its own: its words, its extra fields (a title hint, a
// format) and what an accepted draft offers (Save file, Copy, Download).
import { draftsOf } from './record-drafts.js';
import { controlKey } from './dialog-focus.js';

const camel = prefix => prefix.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
// The dialog for one draft type, opened from Map tools: choose records, preview what the agent reads (F1's job
// preview), queue the draft, edit and accept or dismiss it. `html(state)` draws the dialog from { map, esc, listening,
// live, chosen, preview, edits, ...the type's own state }. `extra` is the type's own part:
//   initial()          its own state, reset when the dialog opens
//   sent()             what a send resets (initial() when absent): the ADR keeps an open Save preview, as it did
//   request(state)     extra input for request-map-job (a title hint), and options for the preview (a format)
//   change, input, click(event, target, ctx)  its own controls; true when handled
//   words              { queued(listening), accepted } toasts; acceptedFocus(itemId) where focus goes after Accept
// A poll never redraws away an edit in progress, focus stays on the same control through a redraw, and a preview
// that answers an earlier choice is dropped.
export function recordDraftDialog({ prefix, type, map, act, api, esc, toast, live, listening, html, extra }) {
  const $ = selector => document.querySelector(selector), dialog = $(`#${prefix}-dialog`), body = $(`#${prefix}-body`), key = camel(prefix);
  const state = { chosen: [], preview: null, edits: {}, ...extra.initial() };
  let written = null;
  const focus = (...selectors) => { (selectors.filter(Boolean).map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? body.querySelector(`#${prefix}-draft-heading`) ?? $(`#${prefix}-title`))?.focus(); };
  const render = () => {
    const shown = map(); if (!shown) return;
    if (state.preview && state.preview.mapRevision !== shown.revision) state.preview = null; // A preview describes the map it was made for.
    const page = html({ map: shown, esc, listening: listening(), live: live(), ...state });
    if (page === written) return; // Never compare with innerHTML read back.
    const active = document.activeElement, kept = active && body.contains?.(active) ? controlKey(active) : null;
    body.innerHTML = written = page;
    if (kept) focus(kept, `#${prefix}-status`, `[data-${prefix}-node]`);
  };
  const item = itemId => draftsOf(map(), type).items.find(entry => entry.item.id === itemId);
  const ctx = { state, render, focus, body, item, act, api, toast, map, listening, live };
  const asked = () => JSON.stringify([state.chosen, extra.request(state)]);
  $(`#${prefix}-open`).addEventListener('click', () => { Object.assign(state, { chosen: [], preview: null, ...extra.initial() }); written = null; render(); $('#tools-dialog').close(); dialog.showModal(); focus(`#${prefix}-text`, ...(extra.openFocus ?? [`[data-${prefix}-node]`])); });
  body.addEventListener('change', event => {
    if (extra.change?.(event, ctx)) return;
    const box = event.target.closest?.(`[data-${prefix}-node]`); if (!box) return;
    const record = { nodeId: box.dataset[`${key}Node`], ...(box.dataset[`${key}Question`] ? { questionId: box.dataset[`${key}Question`] } : {}) };
    state.chosen = state.chosen.filter(entry => entry.nodeId !== record.nodeId || (entry.questionId ?? null) !== (record.questionId ?? null));
    if (box.checked) state.chosen.push(record);
    if (state.preview) { state.preview = null; render(); return; } // A changed choice needs a new preview; focus stays on the box.
    const ask = body.querySelector(`[data-${prefix}-preview]`); if (ask) ask.disabled = !state.chosen.length;
  });
  body.addEventListener('input', event => { const text = event.target.dataset?.[`${key}Text`]; if (text) state.edits[text] = event.target.value; extra.input?.(event, ctx); });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset, shown = map(), own = name => data[`${key}${name}`];
    if (own('Preview') !== undefined) {
      const choice = asked(), { options } = extra.request(state);
      target.disabled = true;
      try {
        const answer = await api(`/maps/${shown.id}/job-preview?type=${type}&selection=${encodeURIComponent(JSON.stringify(state.chosen))}${options ? `&options=${encodeURIComponent(JSON.stringify(options))}` : ''}`);
        if (asked() === choice) state.preview = answer; // Never a preview of a choice the user has since changed.
      } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus(`[data-${prefix}-send]`, `[data-${prefix}-preview]`); return;
    }
    if (own('Cancel') !== undefined) { state.preview = null; render(); focus(`[data-${prefix}-node]`); return; }
    if (own('Send') !== undefined) {
      if (await act(null, 'request-map-job', { jobType: type, selection: state.chosen, ...extra.request(state) })) { Object.assign(state, { chosen: [], preview: null, ...(extra.sent ?? extra.initial)() }); toast(extra.words.queued(listening())); }
      render(); focus(`#${prefix}-status`, `[data-${prefix}-preview]`); return;
    }
    if (own('Stop')) { if (await act(null, 'cancel-job', { jobId: own('Stop') })) toast('Stopped.'); render(); focus(`[data-${prefix}-node]`); return; }
    if (own('Accept')) {
      const itemId = own('Accept'), text = state.edits[itemId] ?? item(itemId)?.item.text;
      if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId, decision: 'accepted', text })) { delete state.edits[itemId]; toast(extra.words.accepted); }
      render(); focus(extra.acceptedFocus(itemId)); return;
    }
    if (own('Dismiss')) { const itemId = own('Dismiss'); if (await act(null, 'review-proposal', { proposalId: data.proposal, itemId, decision: 'dismissed' })) { delete state.edits[itemId]; toast('Dismissed.'); } render(); focus(`[data-${prefix}-node]`, ...(extra.openFocus ?? [])); return; }
    await extra.click?.(event, target, ctx);
  });
  return { mapChanged() { if (dialog.open && !body.contains?.(document.activeElement?.closest?.('textarea, input:not([type=checkbox])') ?? null)) render(); } };
}
