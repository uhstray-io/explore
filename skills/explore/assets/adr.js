// Lightweight ADR (F5): an architecture decision record drafted by the agent from chosen answers and findings, edited
// and accepted by the user, and saved by the user to docs/adr/ in the workspace. Explore renders the file from a fixed
// template: Status is always Proposed, and saving it approves nothing. Shared by the Store and the app.
import { answerChoices, plural } from './workspace-view.js';

export const ADR_DRAFT = 'adr-draft';
export const maxAdrRecords = 40, adrTitleMax = 120, adrSectionMax = 6000, adrFileMax = 64 * 1024;
export const adrSections = [['context', 'Context'], ['decision', 'Decision'], ['consequences', 'Consequences'], ['alternatives', 'Alternatives considered'], ['openQuestions', 'Open questions']];
const isOpenJob = job => job.status === 'queued' || job.status === 'running';
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

// The file's name, from a path under docs/adr/: four digits, then lowercase words joined by hyphens (at most 60), .md;
// null for anything else, so the folder is never left.
export function adrName(relative) {
  const name = typeof relative === 'string' ? /^docs\/adr\/(\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/.exec(relative)?.[1] : null;
  return name && name.length <= 4 + 1 + 60 + 3 ? name : null;
}
// Today in the user's own time zone, as the file's date.
export const adrToday = (at = new Date()) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
// A source line: what it is, a short excerpt, and the IDs that find it again.
export function adrSourceLine(map, ref) {
  const node = map.nodes.find(item => item.id === ref.nodeId), question = ref.questionId ? node?.questions.find(item => item.id === ref.questionId) : null;
  const ids = [map.id, ref.nodeId, ...(ref.questionId ? [ref.questionId] : [])].join(', ');
  if (ref.questionId) return `- ${clip(question?.text ?? 'A removed question', 200)}: ${clip(question?.answer ?? 'Not recorded', 200)} (${ids})`;
  return `- ${clip(node?.title ?? 'A removed idea', 120)} (findings): ${clip(node?.summary ?? 'Not recorded', 200)} (${ids})`;
}
// The draft as Explore renders it from the fixed template; a section the agent left empty says "Not recorded". The date
// is the day the file is saved, filled in then.
export function renderAdr(map, draft) {
  const sections = adrSections.map(([key, heading]) => `## ${heading}\n\n${draft[key]?.trim() || 'Not recorded.'}\n`);
  return `# ${draft.title}\n\nStatus: Proposed\nDate: <date saved>\n\n${sections.join('\n')}\n## Sources from the exploration\n\n${draft.refs.map(ref => adrSourceLine(map, ref)).join('\n')}\n`;
}
// The exact file: the accepted text with its header's Status set to Proposed and its Date to the save date. Only the
// header (before the first section) is touched, so the user's own lines are kept as they wrote them.
export function adrFileText(text, date) {
  const lines = text.replace(/\r\n/g, '\n').split('\n'), first = lines.findIndex(line => line.startsWith('## ')), end = first < 0 ? lines.length : first;
  const header = lines.slice(0, end).filter(line => line.trim() && !/^(Status|Date):/.test(line)), title = header.findIndex(line => line.startsWith('# '));
  const rest = header.slice(title + 1), head = [...header.slice(0, title + 1), '', 'Status: Proposed', `Date: ${date}`, ...(rest.length ? ['', ...rest] : [])];
  const body = lines.slice(end).join('\n').trimEnd();
  return `${head.join('\n').trim()}\n${body ? `\n${body}\n` : ''}`;
}
export const adrSlug = title => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'decision';
export const adrPath = (number, slug) => `docs/adr/${String(number).padStart(4, '0')}-${slug}.md`;
// A map's ADR drafts: `pending` (waiting or running), `failed` (the newest attempt, failed or interrupted), and every
// proposal's item, newest first.
export function adrDrafts(map) {
  const jobs = (map.jobs ?? []).filter(job => job.type === ADR_DRAFT), last = jobs.at(-1);
  const items = (map.proposals ?? []).filter(proposal => proposal.type === ADR_DRAFT).flatMap(proposal => proposal.items.map(item => ({ proposal, item }))).reverse();
  return { pending: jobs.find(isOpenJob) ?? null, failed: last && (last.status === 'failed' || last.status === 'interrupted') ? last : null, items };
}


// The path note under Save file: the path, and why it cannot be used yet. Updated in place as the user types.
export function adrPathNote({ number, slug, free }) {
  const path = adrPath(number, slug), valid = !!adrName(path);
  return { path, valid, text: `Path: ${path}${!valid ? ' — use four digits, then lowercase letters, digits and hyphens (at most 60).' : free === false ? ' — a file is already there; choose another number.' : ''}` };
}
// The dialog: the newest draft waiting for review, accepted records (each saved once), and a new draft's choices.
// `chosen` the records ticked; `preview` F1's job preview of them; `edits` the user's unsaved edits to a draft, by
// item; `hint` the title typed for a new draft; `save` the open save preview { itemId, proposalId, number, slug, free,
// text, sha256 }; `live` false (history) shows the records read-only.
export function adrDialogHtml({ map, esc, listening, live = true, chosen = [], preview = null, edits = {}, hint = '', save = null }) {
  const { pending, failed, items } = adrDrafts(map);
  const status = !live ? '<p class="form-note">An earlier view of the map: return to the live map to draft, accept or save records.</p>'
    : pending ? `<p class="question-help-status" id="adr-status" tabindex="-1" role="status">${pending.status === 'running' ? 'Your agent is drafting the record.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'} <button type="button" class="text-button" data-adr-stop="${esc(pending.id)}">Stop</button></p>`
    : failed ? `<p class="state-note warning" id="adr-status" tabindex="-1">Your agent could not draft this record. ${esc(failed.error ?? 'It stopped before it finished.')}</p>` : '';
  const draft = live ? items.find(entry => entry.item.review === 'unreviewed') : null;
  const review = draft ? `<h3 class="section-label" id="adr-draft-heading" tabindex="-1">Draft for review: ${esc(draft.item.title)}</h3>${draft.proposal.stale ? '<p class="state-note warning">Some of what it was drafted from changed since. Check it before you accept it.</p>' : ''}`
    + `<p class="form-note">Edit it as you like. Accepting keeps it here; nothing is written to your project until you save it.</p><label for="adr-text" class="visually-hidden">The draft, as Markdown</label><textarea id="adr-text" class="adr-text" rows="16" data-adr-text="${esc(draft.item.id)}">${esc(edits[draft.item.id] ?? draft.item.text)}</textarea>`
    + `<div class="brief-actions"><button type="button" class="primary" data-adr-accept="${esc(draft.item.id)}" data-proposal="${esc(draft.proposal.id)}">Accept</button><button type="button" class="text-button" data-adr-dismiss="${esc(draft.item.id)}" data-proposal="${esc(draft.proposal.id)}">Dismiss</button></div>` : '';
  const accepted = items.filter(entry => entry.item.review === 'accepted').map(({ proposal, item }) => {
    const done = item.file ? `<p class="state-note">Saved to <code>${esc(item.file.path)}</code>.</p>` : live ? `<button type="button" class="secondary" data-adr-save="${esc(item.id)}" data-proposal="${esc(proposal.id)}">Save to docs/adr/</button>` : '';
    const body = live && save?.itemId === item.id ? saveHtml(save, esc) : `<div class="brief-actions">${done}<button type="button" class="text-button" data-adr-copy="${esc(item.id)}">Copy</button></div>`;
    return `<li class="adr-item" id="adr-item-${esc(item.id)}"><p class="adr-title"><strong>${esc(item.title)}</strong></p>${body}</li>`;
  }).join('');
  const choices = answerChoices(map, { findings: true }), isChosen = (nodeId, questionId) => chosen.some(record => record.nodeId === nodeId && (record.questionId ?? null) === (questionId ?? null));
  const box = (nodeId, questionId, label) => `<label class="tools-choice"><input type="checkbox" data-adr-node="${esc(nodeId)}"${questionId ? ` data-adr-question="${esc(questionId)}"` : ''}${isChosen(nodeId, questionId) ? ' checked' : ''}> ${label}</label>`;
  const list = choices.map(group => `<fieldset class="tools-group"><legend>${esc(group.title)}</legend>${group.findings ? box(group.nodeId, null, 'Its findings') : ''}${group.answers.map(answer => box(group.nodeId, answer.questionId, esc(answer.question))).join('')}</fieldset>`).join('');
  const reads = preview ? `<p class="form-note" id="adr-preview">Your agent will read ${plural(preview.records.filter(record => record.questionId).length, 'answer')} and the findings of ${plural(preview.records.filter(record => !record.questionId).length, 'idea')}, and draft from those alone. Nothing is written to your project until you save the accepted record.</p>` : '';
  const ask = !live || pending || draft ? '' : `<h3 class="section-label">Draft a new record</h3>${choices.length ? `<p class="form-note">Choose up to ${maxAdrRecords} answers or findings the decision rests on.</p><div class="adr-choices">${list}</div>`
    + `<label for="adr-title-hint">Title, if you have one in mind</label><input id="adr-title-hint" maxlength="${adrTitleMax}" value="${esc(hint)}">${reads}<div class="brief-actions">${preview ? `<button type="button" class="primary" data-adr-send="">Send to your agent</button><button type="button" class="text-button" data-adr-cancel="">Change the choice</button>` : `<button type="button" class="secondary" data-adr-preview=""${chosen.length ? '' : ' disabled'}>Preview what it reads</button>`}</div>`
    : '<p class="form-note">Answer some questions or explore an idea first: a record is drafted from saved answers and findings.</p>'}`;
  return status + review + (accepted ? `<h3 class="section-label">Accepted records</h3><ul class="adr-items">${accepted}</ul>` : '') + ask;
}
function saveHtml(save, esc) {
  const note = adrPathNote(save);
  return `<div class="adr-save" id="adr-save"><div class="adr-path"><label for="adr-number">Number</label><input id="adr-number" inputmode="numeric" maxlength="4" value="${esc(String(save.number).padStart(4, '0'))}">`
    + `<label for="adr-slug">Name</label><input id="adr-slug" maxlength="60" value="${esc(save.slug)}"></div><p class="form-note" id="adr-path" aria-live="polite">${esc(note.text)}</p>`
    + `<p class="form-note">The exact file, as Save file writes it:</p><pre class="adr-file" tabindex="0" aria-label="The exact file">${esc(save.text)}</pre>`
    + `<div class="brief-actions"><button type="button" class="primary" data-adr-write="${esc(save.itemId)}" data-proposal="${esc(save.proposalId)}"${note.valid && save.free !== false ? '' : ' disabled'}>Save file</button><button type="button" class="text-button" data-adr-save-cancel="${esc(save.itemId)}">Cancel</button></div></div>`;
}
