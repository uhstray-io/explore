import { inboxHtml, openThoughts, SORT_THOUGHTS } from './inbox.js';

// The inbox dialog (K8), opened from Map tools: jot a thought, edit or discard one, ask the agent where they belong
// (after F1's preview of what it reads), and accept or dismiss each suggestion. Capturing works with no agent connected.
// `act(nodeId, type, input)` is the app's action call and `api(route)` its read; `map()` the map shown; `live()` false
// (history) is read-only, with `readOnly()` saying why. `mapChanged()` redraws the open dialog unless a thought is being
// edited, and keeps the Map tools line current.
export function inboxDialog({ map, act, api, esc, toast, live, readOnly = () => '', listening, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#inbox-dialog'), body = $('#inbox-body'), capture = $('#inbox-capture'), text = $('#inbox-capture-text');
  let editing = null, preview = null, written = null, waiting = false;
  const summary = () => { const shown = map(); if (!shown) return; const count = openThoughts(shown).length; $('#inbox-summary').textContent = count ? `${count === 1 ? '1 open thought' : `${count} open thoughts`} in the inbox.` : 'No open thoughts.'; };
  const render = () => {
    const shown = map(); if (!shown) return;
    if (preview && preview.mapRevision !== shown.revision) preview = null; // A preview describes the map it was made for.
    const html = inboxHtml({ map: shown, esc, live: live(), editing, preview, listening: listening(), readOnly: readOnly() });
    const sorts = (shown.jobs ?? []).filter(job => job.type === SORT_THOUGHTS), pending = sorts.some(job => job.status === 'queued' || job.status === 'running');
    const ended = waiting && !pending && dialog.open ? sorts.at(-1)?.status : null; // How the sort being waited for ended.
    waiting = pending;
    if (html !== written) {
      // A redraw (a poll, or the agent taking the work) keeps focus on the same control, or the nearest one left.
      const active = document.activeElement, kept = active && body.contains?.(active) ? keyOf(active) : null;
      body.innerHTML = written = html; // Never compare with innerHTML read back.
      if (ended === 'completed') { toast('Your agent\'s suggestions are in.'); focus('[data-place-thought]', '[data-dismiss-item]', kept); }
      else if (ended === 'failed' || ended === 'interrupted') focus('#inbox-status', kept);
      else if (kept) focus(kept, '[data-inbox-stop]', '[data-inbox-sort]');
    }
    for (const control of [text, capture.querySelector('button')]) if (control) control.disabled = !live(); // Growth history and saved versions are read-only.
    summary();
  };
  // A control as a selector, to find it again after a redraw: its id, or its first data attribute.
  const quote = value => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
  const keyOf = element => (element.id ? `#${quote(element.id)}` : Object.entries(element.dataset ?? {}).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${quote(value)}"]`)[0] ?? null);
  // After a redraw, focus stays in the dialog: on the first of `selectors` found and enabled, else the capture field.
  const focus = (...selectors) => { (selectors.map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? text)?.focus(); };
  // The thought after (or else before) `id` in the list as it was, to move focus to once `id` leaves the list.
  const neighbour = id => { const ids = openThoughts(map()).map(thought => thought.id), at = ids.indexOf(id); return ids[at + 1] ?? ids[at - 1] ?? null; };
  // One action: send it, say so, redraw, and move focus.
  const run = async (type, input, done, ...focusOn) => { const ok = await act(null, type, input); if (ok && done) toast(done); render(); focus(...focusOn); return ok; };
  $('#inbox-open').addEventListener('click', () => { editing = null; preview = null; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); (live() ? text : $('#inbox-title'))?.focus(); });
  capture.addEventListener('submit', async event => {
    event.preventDefault();
    if (!live()) { toast('Return to the live map to add a thought.'); return; }
    if (await act(null, 'inbox-add', { text: text.value })) { text.value = ''; render(); toast('Added to the inbox.'); text.focus(); }
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.focusNode) { dialog.close(); focusNode(data.focusNode); return; }
    if (data.thoughtEdit) { editing = data.thoughtEdit; render(); focus('#thought-edit'); return; }
    if (data.thoughtCancel !== undefined) { editing = null; render(); focus(`[data-thought-edit="${data.thoughtCancel}"]`); return; }
    if (data.thoughtSave) { if (await act(null, 'inbox-edit', { thoughtId: data.thoughtSave, text: $('#thought-edit').value })) { editing = null; render(); focus(`[data-thought-edit="${data.thoughtSave}"]`); } return; }
    if (data.thoughtDiscard) { const next = neighbour(data.thoughtDiscard); await run('inbox-discard', { thoughtId: data.thoughtDiscard }, 'Discarded.', `[data-thought-edit="${next}"]`); return; }
    if (data.inboxSort !== undefined) {
      const shown = map(); target.disabled = true;
      try { preview = await api(`/maps/${shown.id}/job-preview?type=${SORT_THOUGHTS}`); } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus('[data-inbox-send]', '[data-inbox-sort]'); return;
    }
    if (data.inboxCancel !== undefined) { preview = null; render(); focus('[data-inbox-sort]'); return; }
    if (data.inboxSend !== undefined) { preview = null; await run('request-map-job', { jobType: SORT_THOUGHTS }, listening() ? 'Your agent will sort these next.' : 'Queued. Connect your agent to sort these.', '[data-inbox-stop]', '[data-inbox-sort]'); return; }
    if (data.inboxStop) { await run('cancel-job', { jobId: data.inboxStop }, 'Stopped.', '[data-inbox-sort]'); return; }
    // A placed thought leaves the list, so focus goes to the next one; a dismissed one stays, with its Edit.
    if (data.placeThought) { const next = neighbour(data.thought); await run('place-thought', { proposalId: data.proposal, itemId: data.placeThought }, 'Placed.', `[data-thought-edit="${next}"]`); return; }
    if (data.dismissItem) { await run('review-proposal', { proposalId: data.proposal, itemId: data.dismissItem, decision: 'dismissed' }, 'Dismissed; the thought stays in the inbox.', `[data-thought-edit="${data.thought}"]`); }
  });
  return { mapChanged() { if (dialog.open && !editing) render(); else summary(); } };
}
