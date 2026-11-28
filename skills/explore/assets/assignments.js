// Assign a branch to someone (H7): a user asks a named person to look into a branch, with a note. That person takes it,
// passes it on to someone else, or marks it done. Saved in the map, so a teammate who pulls it sees what waits for them.
// Assignments coordinate people only: they never start research, answer a question or accept a finding. Shared by the
// Store and the app.
import { menuHtml, markdownText } from './workspace-view.js';

export const assignmentLimits = { label: 80, note: 2000 };
export const assignmentsOf = map => (Array.isArray(map?.assignments?.items) ? map.assignments.items : []);
export const isOpenAssignment = item => item.status === 'requested' || item.status === 'taken';
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
export const requestLine = (item, { iso = false } = {}) => { const last = [...(item.events ?? [])].reverse().find(event => event.type === 'requested' || event.type === 'passed'); return last ? `Requested for ${item.requestedFor}${byLine(last)}${day(last.at, iso)}` : `Requested for ${item.requestedFor}`; };

// The card above an idea's questions while someone is asked to look at it: the request, its note, who has taken it,
// Take it (while nobody has), Pass on and Mark done in its ⋯ menu, and its history, collapsed. Read-only when not `live`.
export function assignmentCardHtml(map, node, { esc, live, drafts = {} }) {
  const item = openAssignment(map, node.id); if (!item) return '';
  const id = esc(item.id), nodeId = esc(node.id), key = `assignment-pass:${node.id}`;
  const menu = live ? menuHtml(`assignment-${id}`, 'More for this request', [`<button type="button" role="menuitem" tabindex="-1" data-assignment-pass="${id}" data-node-id="${nodeId}">Pass on</button>`,
    `<button type="button" role="menuitem" tabindex="-1" data-assignment-done="${id}" data-node-id="${nodeId}">Mark done</button>`]) : '';
  const pass = live ? `<details data-editor="assignment-pass" class="assignment-pass"><summary class="visually-hidden">Pass on</summary><form class="assignment-pass-form" data-pass-form="${id}" data-node-id="${nodeId}">`
    + `<label for="pass-to-${id}">Pass on to</label><input id="pass-to-${id}" name="to" maxlength="${assignmentLimits.label}" required data-draft="${esc(key)}-to" value="${esc(drafts[`${key}-to`] ?? '')}">`
    + `<label for="pass-note-${id}">Note (optional)</label><textarea id="pass-note-${id}" name="note" rows="2" maxlength="${assignmentLimits.note}" data-draft="${esc(key)}-note">${esc(drafts[`${key}-note`] ?? '')}</textarea><button type="submit" class="secondary">Pass on</button></form></details>` : '';
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
// Take it, and the ⋯ menu's Pass on (which opens its form) and Mark done. True when the click was one of these.
export async function assignmentClick(event, { state, act, toast, renderDetail }) {
  const take = event.target.closest('[data-assignment-take]');
  if (take) { take.disabled = true; if (await act(take.dataset.nodeId, 'take-assignment', { assignmentId: take.dataset.assignmentTake })) toast('It is yours now.'); take.disabled = false; return true; }
  const pass = event.target.closest('[data-assignment-pass]');
  if (pass) { state.editors[`${pass.dataset.nodeId}:assignment-pass`] = true; renderDetail(true); document.querySelector?.('#detail .assignment-pass-form input')?.focus(); return true; }
  const done = event.target.closest('[data-assignment-done]');
  if (done) { if (await act(done.dataset.nodeId, 'complete-assignment', { assignmentId: done.dataset.assignmentDone })) toast('Marked done.'); return true; }
  return false;
}
// The "Assigned" progress filter: every idea with an open assignment, and who it waits for. Built per map, as High
// impact is, since it reads the map's assignments.
export function assignedFilter(map) {
  return { id: 'assigned', kind: 'progress', label: 'Assigned', empty: 'Nobody has been asked to look at a branch.', matches: node => !!openAssignment(map, node.id),
    lines: node => { const item = openAssignment(map, node.id); return item ? [{ text: `${requestLine(item)}${item.takenBy?.name ? `; taken by ${item.takenBy.name}` : ''}` }] : []; } };
}
// The open assignment in an idea's Markdown view, as literal text.
export function assignmentLines(map, node) {
  const item = openAssignment(map, node.id);
  return item ? ['', `_${markdownText(requestLine(item, { iso: true }))}${item.takenBy?.name ? `; taken by ${markdownText(item.takenBy.name)}` : ''}._`, ...(item.note ? ['', `> ${markdownText(item.note).replace(/\n/g, '\n> ')}`] : [])] : [];
}
