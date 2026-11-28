// Compare options with your own criteria (C9): the user's criteria on an idea with options, and the agent's
// reconsideration against them, kept on its job beside the original recommendation. Shared by the Store and the app;
// it imports only C1's advice renderer. The dialog is criteria-dialog.js.
import { adviceHtml } from './workspace-view.js';

export const RECONSIDER = 'reconsider';
export const priorities = ['high', 'normal', 'low'];
export const priorityWords = { high: 'High', normal: 'Normal', low: 'Low' };
export const maxCriteria = 8, criterionMax = 120;
export const assessmentBases = ['evidence', 'reasoning', 'unknown'];
const basisWords = { evidence: 'Evidence', reasoning: 'Reasoning', unknown: 'Unknown' };
// Criteria in priority order, keeping the user's order within a priority.
export const sortCriteria = list => [...list].sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority));
// Two lists of criteria are the same when every id, label and priority is, in order.
export const criteriaKey = list => JSON.stringify((list ?? []).map(({ id, label, priority }) => [id, label, priority]));

// An idea's reconsiderations: `pending` (waiting or running), `latest` (the newest finished with a result), `adopted`
// (the one marked in use) and `failed` (the newest attempt, when it failed or was interrupted).
export function reconsiderationsOf(map, nodeId) {
  const mine = (map.jobs ?? []).filter(job => job.type === RECONSIDER && job.nodeId === nodeId), done = mine.filter(job => job.status === 'completed' && job.result);
  const last = mine.at(-1);
  return { pending: mine.find(job => job.status === 'queued' || job.status === 'running') ?? null, latest: done.at(-1) ?? null,
    adopted: done.findLast(job => job.outcome === 'adopted') ?? null, failed: last?.status === 'failed' || last?.status === 'interrupted' ? last : null };
}
// Outdated once the idea changed or needs review after the request; based on earlier criteria once they were edited.
export const reconsiderationOutdated = (job, node) => !!job.stale || !node || !!node.stale || node.contentRevision !== job.input?.contentRevision || !node.options?.length;
export function proposalState(node, job) {
  if (reconsiderationOutdated(job, node)) return 'outdated';
  return criteriaKey(job.input?.criteria) === criteriaKey(node.criteria) ? 'current' : 'earlier-criteria';
}
// The reconsideration in use: the adopted one, only while the idea and its criteria are as they were when asked. Every
// reader (inspector, dialog, Markdown, read, brief) goes through this, so an adoption that no longer holds never leads.
export function adoptedReconsideration(map, node) {
  const { adopted } = reconsiderationsOf(map, node.id);
  return adopted && proposalState(node, adopted) === 'current' ? adopted : null;
}
// The options a proposal was asked about, `{ id, title }`: kept on its job, so an outdated one still reads right.
export const proposalOptions = (job, node) => job.input?.options ?? node.options ?? [];

// The inspector: Compare with my criteria under the options, while live.
export function criteriaEntryHtml(node, { esc, live }) {
  return node.options?.length && live ? `<div class="criteria-entry"><button type="button" class="secondary" data-criteria-open="${esc(node.id)}">Compare with my criteria</button></div>` : '';
}
// The reconsideration in use, shown first in the options section with C1's own advice; the original stays below it.
export function reconsideredHtml(map, node, { esc }) {
  const adopted = adoptedReconsideration(map, node); if (!adopted) return '';
  return `<div class="reconsidered"><p class="reconsidered-label">Reconsidered with your criteria</p>${adviceHtml(node.options, adopted.result.recommendation, esc)}`
    + `<p class="form-note">What changed: ${esc(adopted.result.changed)}</p></div>`;
}

// The dialog: the criteria being edited (`draft`, `edited` when it differs from what is saved), the request's state,
// and the newest proposal not set aside, as a grid. It is opened only on the live map.
export function criteriaDialogHtml({ map, node, esc, draft, edited = false, listening = false }) {
  const { pending, latest, adopted, failed } = reconsiderationsOf(map, node.id);
  const rows = draft.map((item, i) => `<li><label for="criterion-${i}" class="visually-hidden">Criterion ${i + 1}</label><input id="criterion-${i}" data-criterion-label="${i}" maxlength="${criterionMax}" value="${esc(item.label)}">`
    + `<label for="criterion-priority-${i}" class="visually-hidden">Priority of criterion ${i + 1}</label><select id="criterion-priority-${i}" data-criterion-priority="${i}">${priorities.map(value => `<option value="${value}"${item.priority === value ? ' selected' : ''}>${priorityWords[value]}</option>`).join('')}</select>`
    + `<button type="button" class="text-button" data-criterion-remove="${i}" aria-label="Remove criterion ${i + 1}">Remove</button></li>`).join('');
  const editor = `<h3 class="section-label">Your criteria</h3><p class="form-note">What matters to you, each with a priority. They sort by priority; nothing is sent until you ask.</p>`
    + (draft.length ? `<ol class="criteria-rows">${rows}</ol>` : '<p class="form-note">No criteria yet.</p>')
    + `${draft.length < maxCriteria ? '<button type="button" class="text-button" data-criterion-add="">Add a criterion</button>' : ''}<div class="brief-actions"><button type="button" class="secondary" data-criteria-save="">Save criteria</button>`
    + `<button type="button" class="primary" data-reconsider-ask=""${!draft.length || pending ? ' disabled' : ''}>Ask the agent to reconsider</button></div>`;
  const status = pending ? `<p class="question-help-status" id="criteria-status" tabindex="-1" role="status">${pending.status === 'running' ? 'Your agent is reconsidering.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'} <button type="button" class="text-button" data-reconsider-stop="${esc(pending.id)}">Stop</button></p>`
    : failed ? `<p class="state-note warning" id="criteria-status" tabindex="-1">Your agent could not reconsider this time. ${esc(failed.error ?? 'It stopped before it finished.')}</p>` : '';
  const shown = latest && latest.outcome !== 'dismissed' ? latest : null;
  const inUse = adopted && adopted !== shown && proposalState(node, adopted) === 'current' ? '<p class="state-note">Your earlier reconsideration stays in use until you choose.</p>' : '';
  return editor + status + inUse + (shown ? proposalHtml(node, shown, { esc, edited }) : '');
}
function proposalHtml(node, job, { esc, edited }) {
  const criteria = sortCriteria(job.input?.criteria ?? []), options = proposalOptions(job, node), state = proposalState(node, job), { assessments, recommendation, changed } = job.result;
  // Each cell also names its criterion, shown only when the grid stacks on a narrow screen and its headers are hidden.
  const cell = (option, criterion) => { const item = assessments.find(a => a.optionId === option.id && a.criterionId === criterion.id); return `<td><span class="criteria-cell-label">${esc(criterion.label)} · ${priorityWords[criterion.priority]}</span>${esc(item?.text ?? '')} <small>${basisWords[item?.basis] ?? ''}</small></td>`; };
  const grid = `<table class="criteria-grid"><thead><tr><th scope="col">Option</th>${criteria.map(item => `<th scope="col">${esc(item.label)} <small>${priorityWords[item.priority]}</small></th>`).join('')}</tr></thead>`
    + `<tbody>${options.map(option => `<tr><th scope="row">${esc(option.title)}</th>${criteria.map(item => cell(option, item)).join('')}</tr>`).join('')}</tbody></table>`;
  const note = state === 'earlier-criteria' ? '<p class="state-note warning">Based on earlier criteria: ask again with your current ones to use it.</p>'
    : state === 'outdated' ? '<p class="state-note warning">Outdated: the idea changed since you asked.</p>' : job.outcome === 'adopted' ? '<p class="state-note">In use: the inspector shows it first.</p>' : '';
  const adopt = state === 'current' && job.outcome !== 'adopted' ? `<button type="button" class="primary" data-reconsider-adopt="${esc(job.id)}"${edited ? ' disabled' : ''} aria-describedby="criteria-adopt-note">Use revised comparison</button>` : '';
  const adoptNote = adopt ? `<p class="form-note" id="criteria-adopt-note"${edited ? '' : ' hidden'}>Save or undo your criteria edits first to use it.</p>` : '';
  return `<h3 class="section-label" id="criteria-proposal" tabindex="-1">Your agent's reconsideration</h3>${note}<div class="criteria-grid-wrap">${grid}</div>`
    + `<div class="option-advice"><p class="reconsidered-label">Revised recommendation</p>${adviceHtml(options, recommendation, esc)}</div><p class="form-note">What changed: ${esc(changed)}</p>`
    + `<div class="brief-actions">${adopt}<button type="button" class="secondary" data-reconsider-dismiss="${esc(job.id)}">Keep original</button></div>${adoptNote}`;
}
