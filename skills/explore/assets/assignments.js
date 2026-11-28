// Assign a branch to someone (H7): a user asks a named person to look into a branch, with a note. That person takes it,
// passes it on to someone else, or marks it done. Saved in the map, so a teammate who pulls it sees what waits for them.
// Assignments coordinate people only: they never start research, answer a question or accept a finding. Shared by the
// Store and the app.
import { menuHtml } from './workspace-view.js';
import { cssQuote } from './dialog-focus.js';

export const assignmentLimits = { label: 80, note: 2000 };
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
// The map's requests. Validation refuses a map whose requests the views cannot read; anything else is skipped here.
export const assignmentsOf = map => (Array.isArray(map?.assignments?.items) ? map.assignments.items.filter(item => isRecord(item) && Array.isArray(item.events)) : []);
export const isOpenAssignment = item => item.status === 'requested' || item.status === 'taken';
// The requests on ideas `ids`: what a restart or a branch restore takes with them.
export const requestsOn = (map, ids) => assignmentsOf(map).filter(item => ids.has(item.nodeId));
// The one open (requested or taken) assignment on an idea, if any.
export const openAssignment = (map, nodeId) => assignmentsOf(map).find(item => item.nodeId === nodeId && isOpenAssignment(item)) ?? null;
// A date in the card, as the reader's own short date; in a Markdown view (committed with the map), as YYYY-MM-DD.
const day = (at, iso = false) => { const date = new Date(at); return Number.isNaN(date.getTime()) ? '' : ` · ${iso ? date.toISOString().slice(0, 10) : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`; };
const byLine = event => (event.by?.name ? ` by ${event.by.name}` : '');
// Each event in words, as the card's history lists it.
export function eventLine(event) {
  const words = { requested: `Requested for ${event.to}${byLine(event)}`, taken: `Taken${byLine(event)}`, passed: `Passed on to ${event.to}${byLine(event)}`, done: `Marked done${byLine(event)}` };
  return `${words[event.type] ?? event.type}${day(event.at)}`;
}
// The request as it stands: "Requested for Ana by Ben · 4 Nov", from the latest request or pass.
export const requestLine = (item, { iso = false } = {}) => { const last = [...item.events].reverse().find(event => event.type === 'requested' || event.type === 'passed'); return last ? `Requested for ${item.requestedFor}${byLine(last)}${day(last.at, iso)}` : `Requested for ${item.requestedFor}`; };
const passKey = itemId => `assignment-pass:${itemId}`; // Drafts belong to the request, so the next one starts empty.

// The card above an idea's questions while someone is asked to look at it: the request, its note, who has taken it,
// Take it (while nobody has), Pass on and Mark done in its ⋯ menu, and its history, collapsed. `passing` is the request
// whose Pass on form is open (state.assignmentPassing). Read-only when not `live`.
export function assignmentCardHtml(map, node, { esc, live, drafts = {}, passing = null }) {
  const item = openAssignment(map, node.id); if (!item) return '';
  const id = esc(item.id), nodeId = esc(node.id), key = passKey(item.id);
  const menu = live ? menuHtml(id, 'More for this request', [`<button type="button" role="menuitem" tabindex="-1" data-assignment-pass="${id}" data-node-id="${nodeId}">Pass on</button>`,
    `<button type="button" role="menuitem" tabindex="-1" data-assignment-done="${id}" data-node-id="${nodeId}">Mark done</button>`]) : '';
  const pass = live && passing === item.id ? `<form class="assignment-pass-form" data-pass-form="${id}" data-node-id="${nodeId}">`
    + `<label for="pass-to-${id}">Pass on to</label><input id="pass-to-${id}" name="to" maxlength="${assignmentLimits.label}" required data-draft="${esc(key)}-to" value="${esc(drafts[`${key}-to`] ?? '')}">`
    + `<label for="pass-note-${id}">Note for them (optional)</label><textarea id="pass-note-${id}" name="note" rows="2" maxlength="${assignmentLimits.note}" data-draft="${esc(key)}-note">${esc(drafts[`${key}-note`] ?? '')}</textarea>`
    + `<div class="detail-actions"><button type="submit" class="secondary">Pass on</button><button type="button" class="text-button" data-assignment-pass-cancel="${id}" data-node-id="${nodeId}">Cancel</button></div></form>` : '';
  const history = `<details class="assignment-history"><summary>History (${item.events.length})</summary><ol>${item.events.map(event => `<li>${esc(eventLine(event))}${event.note ? `<span class="form-note"> ${esc(event.note)}</span>` : ''}</li>`).join('')}</ol></details>`;
  return `<section class="assignment-card" aria-label="Who is looking at this branch"><div class="assignment-head"><p><strong>${esc(requestLine(item))}</strong></p>${menu}</div>${item.note ? `<p class="assignment-note">${esc(item.note)}</p>` : ''}`
    + `${item.takenBy?.name ? `<p class="form-note">Taken by ${esc(item.takenBy.name)}.</p>` : ''}${live && item.status === 'requested' ? `<div class="detail-actions"><button type="button" class="secondary" data-assignment-take="${id}" data-node-id="${nodeId}">Take it</button></div>` : ''}${pass}${history}</section>`;
}
// "Ask someone to look at this branch", while nobody is: a name and an optional note, kept as drafts through a redraw.
export function assignFormHtml(map, node, { esc, live, drafts = {} }) {
  if (!live || openAssignment(map, node.id)) return '';
  const id = esc(node.id), key = `assign:${node.id}`;
  return `<details data-editor="assign"><summary>Ask someone to look at this branch</summary><form id="assign-form" data-node-id="${id}"><p class="form-note">For people only: it starts no research and changes nothing in the branch.</p>`
    + `<label for="assign-to">Who</label><input id="assign-to" name="to" maxlength="${assignmentLimits.label}" required data-draft="${esc(key)}-to" value="${esc(drafts[`${key}-to`] ?? '')}">`
    + `<label for="assign-note">Note (optional)</label><textarea id="assign-note" name="note" rows="3" maxlength="${assignmentLimits.note}" data-draft="${esc(key)}-note">${esc(drafts[`${key}-note`] ?? '')}</textarea><button type="submit" class="secondary">Ask</button></form></details>`;
}
// The action a submitted assignment form asks for, or null for any other form.
export function assignmentRequest(form, data) {
  const note = String(data.note ?? '').trim() ? { note: data.note } : {};
  if (form.id === 'assign-form') return { type: 'assign', input: { to: data.to, ...note } };
  if (form.dataset?.passForm) return { type: 'pass-assignment', input: { assignmentId: form.dataset.passForm, to: data.to, ...note } };
  return null;
}
// Take it, and the ⋯ menu's Pass on (which opens its form, with Cancel) and Mark done. True when the click was one of
// these. Focus stays on the card: its menu after taking or cancelling, the new request's form once it is done.
export async function assignmentClick(event, { state, act, toast, renderDetail }) {
  const focus = selector => document.querySelector(`#detail ${selector}`)?.focus();
  const take = event.target.closest('[data-assignment-take]');
  if (take) {
    take.disabled = true;
    if (await act(take.dataset.nodeId, 'take-assignment', { assignmentId: take.dataset.assignmentTake })) { toast('It is yours now.'); renderDetail(true); focus(`[data-menu="${cssQuote(take.dataset.assignmentTake)}"]`); }
    take.disabled = false; return true;
  }
  const pass = event.target.closest('[data-assignment-pass]');
  if (pass) { state.assignmentPassing = pass.dataset.assignmentPass; renderDetail(true); focus('[data-pass-form] input'); return true; }
  const cancel = event.target.closest('[data-assignment-pass-cancel]');
  if (cancel) {
    for (const part of ['to', 'note']) delete state.drafts[`${passKey(cancel.dataset.assignmentPassCancel)}-${part}`];
    state.assignmentPassing = null; renderDetail(true); focus(`[data-menu="${cssQuote(cancel.dataset.assignmentPassCancel)}"]`); return true;
  }
  const done = event.target.closest('[data-assignment-done]');
  if (done) { if (await act(done.dataset.nodeId, 'complete-assignment', { assignmentId: done.dataset.assignmentDone })) { toast('Marked done.'); renderDetail(true); focus('[data-editor="assign"] summary'); } return true; }
  return false;
}
// The "Assigned" progress filter: every idea with an open assignment, and who it waits for. Built per map, as High
// impact is, since it reads the map's assignments.
export function assignedFilter(map) {
  return { id: 'assigned', kind: 'progress', label: 'Assigned', empty: 'Nobody has been asked to look at a branch.', matches: node => !!openAssignment(map, node.id),
    lines: node => { const item = openAssignment(map, node.id); return item ? [{ text: `${requestLine(item)}${item.takenBy?.name ? `; taken by ${item.takenBy.name}` : ''}` }] : []; } };
}
