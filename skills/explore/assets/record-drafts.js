// Drafts written from records the user chose (F4 implementation handoff, F5 decision record): their state and the
// markup they share, loaded by the Store and the app. Their one dialog controller is record-draft-dialog.js.
import { answerChooserHtml, proposalsOf, waitingWords, plural } from './workspace-view.js';

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
