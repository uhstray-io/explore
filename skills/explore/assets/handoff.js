// Implementation handoff (F4): from answers and findings the user chose, the agent writes a brief, specification, plan,
// prompt or task list for whoever implements the work. The user edits and accepts it, then copies or downloads it with
// a footer Explore adds. Nothing is executed, sent or created anywhere. Shared by the Store and the app.
import { downloadName } from './workspace-view.js';
import { certaintyText } from './questions.js';
import { draftsOf, draftStatusHtml, draftReviewHtml, draftAskHtml, readsWords, localDay, oneLineText, recordIds } from './record-drafts.js';

export const HANDOFF = 'handoff';
export const maxHandoffRecords = 40, handoffTitleMax = 120, handoffTextMax = 24000;
export const handoffFormats = { brief: 'Brief', spec: 'Specification', plan: 'Plan', prompt: 'Prompt for a coding agent', tasks: 'Task list' };
const formatName = format => (Object.hasOwn(handoffFormats, format) ? handoffFormats[format] : 'Handoff');
export const handoffFilename = title => downloadName(title, '-handoff.md');
export const handoffsOf = map => draftsOf(map, HANDOFF);

// A record as the user knows it, on one line: the question it answers, or the idea whose findings it is.
function recordLabel(map, record) {
  const node = map.nodes.find(n => n.id === record.nodeId), question = record.questionId ? node?.questions.find(q => q.id === record.questionId) : null;
  return record.questionId ? `${oneLineText(node?.title ?? 'A removed idea', 120)} · ${oneLineText(question?.text ?? 'A removed question', 200)}` : `${oneLineText(node?.title ?? 'A removed idea', 120)} (findings)`;
}
// How settled a record is: an answer's certainty, or a finding's review state, flagged when it needs review.
function recordState(map, record) {
  const node = map.nodes.find(n => n.id === record.nodeId), question = record.questionId ? node?.questions.find(q => q.id === record.questionId) : null;
  if (!node || (record.questionId && !question)) return 'removed';
  if (question) return question.answer && !question.supersededAt ? `answer, ${certaintyText(question) ?? 'not recorded'}` : 'no longer a current answer';
  return `findings, ${node.reviewState === 'accepted' ? 'accepted' : 'unreviewed'}${node.stale ? ', needs review' : ''}`;
}
// The sources that changed since the handoff was written (the server names them), or null while none did.
const changedSources = (map, proposal) => (proposal.stale ? ((proposal.changed ?? []).map(record => recordLabel(map, record)).join('; ') || 'some of its sources') : null);
const checkWords = (changed, proposal) => ((proposal.changed ?? []).length === 1 ? `${changed}. Check it` : `${changed}. Check them`);

// The footer Explore adds to a copied or downloaded handoff, never the agent: the map and the revision it was copied
// at, each record it was written from (how settled it is, and * where the agent cited it), who wrote and accepted it,
// and which sources changed since. Every line from the map is flattened to one line, so no text can forge another.
export function handoffFooter(map, proposal, item) {
  const changed = changedSources(map, proposal), cited = new Set((item.refs ?? []).map(ref => `${ref.nodeId}/${ref.questionId ?? ''}`));
  return ['---', '', `Explore map ${map.id}, copied at revision ${map.revision}.`, '', 'Written from (* cited by the agent):',
    ...(proposal.included ?? []).map(record => `- ${cited.has(`${record.nodeId}/${record.questionId ?? ''}`) ? '* ' : ''}${recordLabel(map, record)} [${recordState(map, record)}] (${recordIds(map, record)})`), '',
    `Drafted by an agent; ${item.editedByUser ? 'edited and ' : ''}accepted on ${localDay(item.reviewedAt)}.`,
    ...(changed ? ['', `Changed since it was written: ${checkWords(changed, proposal)} before relying on this.`] : [])].join('\n');
}
// The file a copy or download gives: the accepted text, then the footer.
export const handoffFileText = (map, proposal, item) => `${item.text}\n\n${handoffFooter(map, proposal, item)}\n`;

// The dialog: progress, the newest handoff waiting for review (Copy and Download only once accepted), accepted ones,
// and a new handoff's format and records. `chosen` the records ticked; `format` the one picked; `preview` F1's job
// preview of them; `edits` the user's unsaved edits, by item; `live` false (history) is read-only, with nothing to copy.
export function handoffDialogHtml({ map, esc, listening, live = true, chosen = [], format = 'brief', preview = null, edits = {} }) {
  const drafts = handoffsOf(map), { pending, items } = drafts;
  const status = draftStatusHtml(drafts, { esc, listening, live, prefix: 'handoff', doing: 'writing the handoff', failure: 'Your agent could not write this handoff.', earlier: 'An earlier view of the map: return to the live map to write, accept or copy a handoff.' });
  const changedNote = proposal => { const changed = changedSources(map, proposal); return changed ? `<p class="state-note warning">Changed since it was written: ${esc(checkWords(changed, proposal))} before relying on it.</p>` : ''; };
  const draft = live ? items.find(entry => entry.item.review === 'unreviewed') : null;
  const review = draft ? draftReviewHtml({ esc, prefix: 'handoff', draft, edits, heading: `Draft for review: ${esc(draft.item.title)} <span class="form-note">${esc(formatName(draft.item.format))}</span>`, label: 'The handoff, as Markdown',
    warning: changedNote(draft.proposal), note: 'Edit it as you like. Copy and Download become available once you accept it.',
    after: '<button type="button" class="secondary" disabled>Copy</button><button type="button" class="secondary" disabled>Download Markdown</button>' }) : '';
  const accepted = items.filter(entry => entry.item.review === 'accepted').map(({ proposal, item }) => `<li class="adr-item" id="handoff-item-${esc(item.id)}"><p class="adr-title"><strong>${esc(item.title)}</strong> <span class="form-note">${esc(formatName(item.format))}${item.editedByUser ? ', edited by you' : ''}</span></p>${changedNote(proposal)}`
    + (live ? `<div class="brief-actions"><button type="button" class="secondary" data-handoff-copy="${esc(item.id)}" data-proposal="${esc(proposal.id)}">Copy</button><button type="button" class="secondary" data-handoff-download="${esc(item.id)}" data-proposal="${esc(proposal.id)}">Download Markdown</button></div>` : '') + '</li>').join('');
  const formats = Object.entries(handoffFormats).map(([key, label]) => `<option value="${key}"${key === format ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const ask = !live || pending || draft ? '' : draftAskHtml({ map, esc, prefix: 'handoff', chosen, preview, heading: 'Write a new handoff', intro: `Choose up to ${maxHandoffRecords} answers or findings it rests on.`,
    before: `<label for="handoff-format">What to write</label><select id="handoff-format">${formats}</select>`,
    reads: shown => `<p class="form-note" id="handoff-preview">Your agent will read the original idea, ${readsWords(shown)}, with the map's title, and its goal and agreed terms when it has them, and write a ${esc(formatName(shown.format).toLowerCase())} from those alone. Nothing is executed or sent anywhere.</p>`,
    empty: 'Answer some questions or explore an idea first: a handoff is written from saved answers and findings.' });
  return status + review + (accepted ? `<h3 class="section-label">Accepted handoffs</h3><ul class="adr-items">${accepted}</ul>` : '') + ask;
}
