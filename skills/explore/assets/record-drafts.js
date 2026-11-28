// Drafts written from records the user chose (F4 implementation handoff, F5 decision record), in the browser: their
// state, the markup they share, and one dialog controller. Each draft type plugs in what is its own: its words, its
// extra fields (a title hint, a format) and what an accepted draft offers (Save file, Copy, Download).
import { answerChooserHtml, proposalsOf, waitingWords, plural } from './workspace-view.js';
import { controlKey } from './dialog-focus.js';

// Today, or `at`, in the user's own time zone, as YYYY-MM-DD.
export const localDay = (at = new Date()) => { const day = new Date(at); return Number.isNaN(day.getTime()) ? 'an unknown date' : `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
// Text from the map as one line of at most `limit` characters: titles and questions are the agent's or a pulled file's,
// so a newline in one can never start a line of its own in a file Explore writes.
export const oneLineText = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
// The IDs that find a record again.
export const recordIds = (map, record) => [map.id, record.nodeId, ...(record.questionId ? [record.questionId] : [])].join(', ');

// A map's drafts of one type: `pending` (waiting or running), `failed` (the newest attempt, failed or interrupted), and
// every proposal's item, newest first.
export function draftsOf(map, type) {
  const jobs = (map.jobs ?? []).filter(job => job.type === type), last = jobs.at(-1);
  const items = proposalsOf(map, type).flatMap(proposal => proposal.items.map(item => ({ proposal, item }))).reverse();
  return { pending: jobs.find(job => job.status === 'queued' || job.status === 'running') ?? null, failed: last && (last.status === 'failed' || last.status === 'interrupted') ? last : null, items };
}
// Their progress line: waiting (with Stop), running, failed, or nothing; in history, `earlier`. `prefix` names its
// controls (#<prefix>-status, data-<prefix>-stop); `doing` (as in "Your agent is …") and `failure` are its words.
export function draftStatusHtml({ pending, failed }, { esc, listening, live, prefix, doing, failure, earlier }) {
  if (!live) return `<p class="form-note">${earlier}</p>`;
  if (pending) return `<p class="question-help-status" id="${prefix}-status" tabindex="-1" role="status">${waitingWords(pending, listening, doing)} <button type="button" class="text-button" data-${prefix}-stop="${esc(pending.id)}">Stop</button></p>`;
  return failed ? `<p class="state-note warning" id="${prefix}-status" tabindex="-1">${failure} ${esc(failed.error ?? 'It stopped before it finished.')}</p>` : '';
}
// The draft waiting for review: its heading, a warning when its sources changed, the editable text (the user's unsaved
// edit kept through a redraw), Accept and Dismiss, then `after` (such as Copy and Download, not yet available).
export function draftReviewHtml({ esc, prefix, draft, edits, heading, warning = '', note, label, after = '' }) {
  const id = esc(draft.item.id), proposal = esc(draft.proposal.id);
  return `<h3 class="section-label" id="${prefix}-draft-heading" tabindex="-1">${heading}</h3>${warning}<p class="form-note">${note}</p><label for="${prefix}-text" class="visually-hidden">${label}</label>`
    + `<textarea id="${prefix}-text" class="adr-text" rows="16" data-${prefix}-text="${id}">${esc(edits[draft.item.id] ?? draft.item.text)}</textarea>`
    + `<div class="brief-actions"><button type="button" class="primary" data-${prefix}-accept="${id}" data-proposal="${proposal}">Accept</button><button type="button" class="text-button" data-${prefix}-dismiss="${id}" data-proposal="${proposal}">Dismiss</button>${after}</div>`;
}
// A new draft's choice of records: `before` (fields ahead of the choice), the shared chooser, `after` (fields after
// it), what the preview reads, and Preview, then Send or Change the choice. `empty` when nothing can be chosen yet.
export function draftAskHtml({ map, esc, prefix, chosen, preview, heading, intro, before = '', after = '', reads, empty }) {
  const list = answerChooserHtml(map, { esc, prefix, chosen, findings: true });
  if (!list) return `<h3 class="section-label">${heading}</h3><p class="form-note">${empty}</p>`;
  const actions = preview ? `<button type="button" class="primary" data-${prefix}-send="">Send to your agent</button><button type="button" class="text-button" data-${prefix}-cancel="">Change the choice</button>`
    : `<button type="button" class="secondary" data-${prefix}-preview=""${chosen.length ? '' : ' disabled'}>Preview what it reads</button>`;
  return `<h3 class="section-label">${heading}</h3>${before}<p class="form-note">${intro}</p><div class="answer-choices">${list}</div>${after}${preview ? reads(preview) : ''}<div class="brief-actions">${actions}</div>`;
}
// What a preview reads, in words: so many answers and the findings of so many ideas.
export const readsWords = preview => `${plural(preview.records.filter(record => record.questionId).length, 'answer')} and the findings of ${plural(preview.records.filter(record => !record.questionId).length, 'idea')}`;

const camel = prefix => prefix.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
// The dialog for one draft type, opened from Map tools: choose records, preview what the agent reads (F1's job
// preview), queue the draft, edit and accept or dismiss it. `html(state)` draws the dialog from { map, esc, listening,
// live, chosen, preview, edits, ...the type's own state }. `extra` is the type's own part:
//   initial()          its own state, reset when the dialog opens and after a send
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
      if (await act(null, 'request-map-job', { jobType: type, selection: state.chosen, ...extra.request(state) })) { Object.assign(state, { chosen: [], preview: null, ...extra.initial() }); toast(extra.words.queued(listening())); }
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
