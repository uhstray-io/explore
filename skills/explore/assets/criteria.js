// Compare options with your own criteria (C9): the user's criteria on an idea with options, and the agent's
// reconsideration against them, kept on its job beside the original recommendation. Shared by the Store and the app;
// it imports nothing. The dialog is criteria-dialog.js.
export const RECONSIDER = 'reconsider';
export const priorities = ['high', 'normal', 'low'];
export const priorityWords = { high: 'High', normal: 'Normal', low: 'Low' };
export const maxCriteria = 8, criterionMax = 120;
export const assessmentBases = ['evidence', 'reasoning', 'unknown'];
const basisWords = { evidence: 'Evidence', reasoning: 'Reasoning', unknown: 'Unknown' };
// Criteria in priority order, keeping the user's order within a priority.
export const sortCriteria = list => [...list].sort((a, b) => priorities.indexOf(a.priority) - priorities.indexOf(b.priority));
const criteriaKey = list => JSON.stringify((list ?? []).map(({ id, label, priority }) => [id, label, priority]));

// An idea's reconsiderations: { pending: one waiting or running, latest: the newest finished with a result, adopted }.
export function reconsiderationsOf(map, nodeId) {
  const mine = (map.jobs ?? []).filter(job => job.type === RECONSIDER && job.nodeId === nodeId), done = mine.filter(job => job.status === 'completed' && job.result);
  return { pending: mine.find(job => job.status === 'queued' || job.status === 'running') ?? null, latest: done.at(-1) ?? null, adopted: done.filter(job => job.outcome === 'adopted').at(-1) ?? null };
}
// Outdated once the idea changed or needs review after the request; based on earlier criteria once they were edited.
export const reconsiderationOutdated = (job, node) => !!job.stale || !node || !!node.stale || node.contentRevision !== job.input?.contentRevision || !node.options?.length;
export function proposalState(node, job) {
  if (reconsiderationOutdated(job, node)) return 'outdated';
  return criteriaKey(job.input?.criteria) === criteriaKey(node.criteria) ? 'current' : 'earlier-criteria';
}

// The inspector: Compare with my criteria under the options, while live.
export function criteriaEntryHtml(node, { esc, live }) {
  return node.options?.length && live ? `<div class="criteria-entry"><button type="button" class="secondary" data-criteria-open="${esc(node.id)}">Compare with my criteria</button></div>` : '';
}
// The adopted reconsideration, shown first in the options section; the original stays below it.
export function reconsideredHtml(map, node, { esc }) {
  const adopted = reconsiderationsOf(map, node.id).adopted; if (!adopted) return '';
  const r = adopted.result.recommendation, chosen = node.options?.find(option => option.id === r.optionId);
  return `<div class="reconsidered"><p class="reconsidered-label">Reconsidered with your criteria</p>`
    + `<p>${chosen ? `<strong>Recommended: ${esc(chosen.title)}.</strong> ${esc(r.rationale)}` : `<strong>No recommendation yet.</strong> ${esc(r.missing ?? '')}`}</p>`
    + `<p class="form-note">What changed: ${esc(adopted.result.changed)}</p></div>`;
}

// The dialog: the criteria being edited (`draft`), the request's state, and the newest proposal as a grid.
export function criteriaDialogHtml({ map, node, esc, draft, live, listening = false }) {
  const { pending, latest } = reconsiderationsOf(map, node.id);
  const rows = draft.map((item, i) => `<li><label for="criterion-${i}" class="visually-hidden">Criterion ${i + 1}</label><input id="criterion-${i}" data-criterion-label="${i}" maxlength="${criterionMax}" value="${esc(item.label)}"${live ? '' : ' disabled'}>`
    + `<label for="criterion-priority-${i}" class="visually-hidden">Priority of criterion ${i + 1}</label><select id="criterion-priority-${i}" data-criterion-priority="${i}"${live ? '' : ' disabled'}>${priorities.map(value => `<option value="${value}"${item.priority === value ? ' selected' : ''}>${priorityWords[value]}</option>`).join('')}</select>`
    + `${live ? `<button type="button" class="text-button" data-criterion-remove="${i}" aria-label="Remove criterion ${i + 1}">Remove</button>` : ''}</li>`).join('');
  const editor = `<h3 class="section-label">Your criteria</h3><p class="form-note">What matters to you, each with a priority. They sort by priority; nothing is sent until you ask.</p>`
    + (draft.length ? `<ol class="criteria-rows">${rows}</ol>` : '<p class="form-note">No criteria yet.</p>')
    + (live ? `${draft.length < maxCriteria ? '<button type="button" class="text-button" data-criterion-add="">Add a criterion</button>' : ''}<div class="brief-actions"><button type="button" class="secondary" data-criteria-save="">Save criteria</button>`
      + `<button type="button" class="primary" data-reconsider-ask=""${!draft.length || pending ? ' disabled' : ''}>Ask the agent to reconsider</button></div>` : '');
  const waiting = pending ? `<p class="question-help-status" role="status">${pending.status === 'running' ? 'Your agent is reconsidering.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'}${live ? ` <button type="button" class="text-button" data-reconsider-stop="${esc(pending.id)}">Stop</button>` : ''}</p>` : '';
  return editor + waiting + (latest && latest.outcome !== 'dismissed' ? proposalHtml(node, latest, { esc, live }) : '');
}
function proposalHtml(node, job, { esc, live }) {
  const criteria = sortCriteria(job.input?.criteria ?? []), state = proposalState(node, job), { assessments, recommendation: r, changed } = job.result;
  const cell = (option, criterion) => { const item = assessments.find(a => a.optionId === option.id && a.criterionId === criterion.id); return `<td>${esc(item?.text ?? '')} <small>${basisWords[item?.basis] ?? ''}</small></td>`; };
  const grid = `<table class="criteria-grid"><thead><tr><th scope="col">Option</th>${criteria.map(item => `<th scope="col">${esc(item.label)} <small>${priorityWords[item.priority]}</small></th>`).join('')}</tr></thead>`
    + `<tbody>${(node.options ?? []).map(option => `<tr><th scope="row">${esc(option.title)}</th>${criteria.map(item => cell(option, item)).join('')}</tr>`).join('')}</tbody></table>`;
  const chosen = node.options?.find(option => option.id === r.optionId);
  const note = state === 'earlier-criteria' ? '<p class="state-note warning">Based on earlier criteria: ask again with your current ones to use it.</p>'
    : state === 'outdated' ? '<p class="state-note warning">Outdated: the idea changed since you asked.</p>' : job.outcome === 'adopted' ? '<p class="state-note">In use: the inspector shows it first.</p>' : '';
  const actions = live ? `<div class="brief-actions">${state === 'current' && job.outcome !== 'adopted' ? `<button type="button" class="primary" data-reconsider-adopt="${esc(job.id)}">Use revised comparison</button>` : ''}<button type="button" class="secondary" data-reconsider-dismiss="${esc(job.id)}">Keep original</button></div>` : '';
  return `<h3 class="section-label">Your agent's reconsideration</h3>${note}<div class="criteria-grid-wrap">${grid}</div>`
    + `<p>${chosen ? `<strong>Revised recommendation: ${esc(chosen.title)}.</strong> ${esc(r.rationale)}` : `<strong>No recommendation yet.</strong> ${esc(r.missing ?? '')}`}</p><p class="form-note">What changed: ${esc(changed)}</p>${actions}`;
}
