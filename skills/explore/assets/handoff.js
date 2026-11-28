// Implementation handoff (F4): from answers and findings the user chose, the agent writes a brief, specification, plan,
// prompt or task list for whoever implements the work. The user edits and accepts it, then copies or downloads it with
// a footer Explore adds. Nothing is executed, sent or created anywhere. Shared by the Store and the app.
import { answerChooserHtml, answerRefLabel, draftsOf, draftStatusHtml, downloadName, plural } from './workspace-view.js';

export const HANDOFF = 'handoff';
export const maxHandoffRecords = 40, handoffTitleMax = 120, handoffTextMax = 24000;
export const handoffFormats = { brief: 'Brief', spec: 'Specification', plan: 'Plan', prompt: 'Prompt for a coding agent', tasks: 'Task list' };
export const handoffFilename = title => downloadName(title, '-handoff.md');
export const handoffsOf = map => draftsOf(map, HANDOFF);
const localDay = at => { const day = new Date(at); return Number.isNaN(day.getTime()) ? 'an unknown date' : `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`; };
// A record as the user knows it: the question it answers, or the idea whose findings it is.
const recordLabel = (map, record) => (record.questionId ? answerRefLabel(map, record) : `${map.nodes.find(node => node.id === record.nodeId)?.title ?? 'A removed idea'} (findings)`);
// The sources that changed since the handoff was written (the server names them), or null while none did.
const changedSources = (map, proposal) => (proposal.stale ? ((proposal.changed ?? []).map(record => recordLabel(map, record)).join('; ') || 'some of its sources') : null);

// The footer Explore adds to a copied or downloaded handoff, never the agent: the map and its revision, each record it
// was written from with the IDs that find it again, who wrote and accepted it, and which sources changed since.
export function handoffFooter(map, proposal, item) {
  const changed = changedSources(map, proposal);
  return ['---', '', `Explore map ${map.id}, revision ${map.revision}.`, '', 'Written from:',
    ...(proposal.included ?? []).map(record => `- ${recordLabel(map, record)} (${[map.id, record.nodeId, ...(record.questionId ? [record.questionId] : [])].join(', ')})`), '',
    `Drafted by an agent; ${item.editedByUser ? 'edited and ' : ''}accepted on ${localDay(item.reviewedAt)}.`,
    ...(changed ? ['', `Changed since it was written: ${changed}. Check them before relying on this.`] : [])].join('\n');
}
// The file a copy or download gives: the accepted text, then the footer.
export const handoffFileText = (map, proposal, item) => `${item.text.trimEnd()}\n\n${handoffFooter(map, proposal, item)}\n`;

// The dialog: progress, the newest handoff waiting for review (Copy and Download only once accepted), accepted ones,
// and a new handoff's format and records. `chosen` the records ticked; `format` the one picked; `preview` F1's job
// preview of them; `edits` the user's unsaved edits, by item; `live` false (history) is read-only.
export function handoffDialogHtml({ map, esc, listening, live, chosen = [], format = 'brief', preview = null, edits = {} }) {
  const drafts = handoffsOf(map), { pending, items } = drafts;
  const status = draftStatusHtml(drafts, { esc, listening, live, prefix: 'handoff', doing: 'Your agent is writing the handoff.', failure: 'Your agent could not write this handoff.', earlier: 'An earlier view of the map: return to the live map to write or accept a handoff.' });
  const changedNote = proposal => { const changed = changedSources(map, proposal); return changed ? `<p class="state-note warning">Changed since it was written: ${esc(changed)}. Check them before relying on it.</p>` : ''; };
  const draft = live ? items.find(entry => entry.item.review === 'unreviewed') : null;
  const review = draft ? `<h3 class="section-label" id="handoff-draft-heading" tabindex="-1">${esc(handoffFormats[draft.item.format] ?? 'Handoff')} for review: ${esc(draft.item.title)}</h3>${changedNote(draft.proposal)}`
    + `<p class="form-note">Edit it as you like. Copy and Download become available once you accept it.</p><label for="handoff-text" class="visually-hidden">The handoff, as Markdown</label><textarea id="handoff-text" class="adr-text" rows="16" data-handoff-text="${esc(draft.item.id)}">${esc(edits[draft.item.id] ?? draft.item.text)}</textarea>`
    + `<div class="brief-actions"><button type="button" class="primary" data-handoff-accept="${esc(draft.item.id)}" data-proposal="${esc(draft.proposal.id)}">Accept</button><button type="button" class="text-button" data-handoff-dismiss="${esc(draft.item.id)}" data-proposal="${esc(draft.proposal.id)}">Dismiss</button>`
    + '<button type="button" class="secondary" disabled>Copy</button><button type="button" class="secondary" disabled>Download Markdown</button></div>' : '';
  const accepted = items.filter(entry => entry.item.review === 'accepted').map(({ proposal, item }) => `<li class="adr-item" id="handoff-item-${esc(item.id)}"><p class="adr-title"><strong>${esc(item.title)}</strong> <span class="form-note">${esc(handoffFormats[item.format] ?? 'Handoff')}${item.editedByUser ? ', edited by you' : ''}</span></p>${changedNote(proposal)}`
    + `<div class="brief-actions"><button type="button" class="secondary" data-handoff-copy="${esc(item.id)}" data-proposal="${esc(proposal.id)}">Copy</button><button type="button" class="secondary" data-handoff-download="${esc(item.id)}" data-proposal="${esc(proposal.id)}">Download Markdown</button></div></li>`).join('');
  const list = answerChooserHtml(map, { esc, prefix: 'handoff', chosen, findings: true });
  const formats = Object.entries(handoffFormats).map(([key, label]) => `<option value="${key}"${key === format ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const reads = preview ? `<p class="form-note" id="handoff-preview">Your agent will read the original idea, ${plural(preview.records.filter(record => record.questionId).length, 'answer')} and the findings of ${plural(preview.records.filter(record => !record.questionId).length, 'idea')}, and write a ${esc((handoffFormats[preview.format] ?? 'handoff').toLowerCase())} from those alone. It runs and sends nothing.</p>` : '';
  const ask = !live || pending || draft ? '' : `<h3 class="section-label">Write a new handoff</h3>${list ? `<label for="handoff-format">What to write</label><select id="handoff-format">${formats}</select><p class="form-note">Choose up to ${maxHandoffRecords} answers or findings it rests on.</p><div class="answer-choices">${list}</div>${reads}`
    + `<div class="brief-actions">${preview ? '<button type="button" class="primary" data-handoff-send="">Send to your agent</button><button type="button" class="text-button" data-handoff-cancel="">Change the choice</button>' : `<button type="button" class="secondary" data-handoff-preview=""${chosen.length ? '' : ' disabled'}>Preview what it reads</button>`}</div>`
    : '<p class="form-note">Answer some questions or explore an idea first: a handoff is written from saved answers and findings.</p>'}`;
  return status + review + (accepted ? `<h3 class="section-label">Accepted handoffs</h3><ul class="adr-items">${accepted}</ul>` : '') + ask;
}
