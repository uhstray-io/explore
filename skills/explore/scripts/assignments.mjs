// Assign a branch to someone (H7) in the Store: assign, take, pass on and mark done. Each appends an event and changes
// nothing else: never the idea's work or review state, its questions, its jobs or whether it is complete. "Done" means
// the person finished looking, not that the branch is explored or accepted.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { assignmentLimits, assignmentsOf, openAssignment } from '../assets/assignments.js';

class AssignmentProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new AssignmentProblem(message, status); };
const fail = message => need(false, message);
// Who it is for: a free-text label, one line, not checked against anything.
const label = value => { const text = textField(value, 'Who', assignmentLimits.label, fail); need(!/[\r\n]/.test(text), 'Who is one line.'); return text; };
const noteOf = value => textField(value, 'Note', assignmentLimits.note, fail, { optional: true });
const by = actor => (actor?.name ? { by: { name: actor.name } } : {});
const itemOf = (map, node, input) => {
  const item = assignmentsOf(map).find(entry => entry.id === input.assignmentId && entry.nodeId === node.id);
  need(item, 'That request no longer exists.', 404);
  return item;
};
const record = (store, map, item, type, actor, extra = {}) => {
  item.events.push({ at: new Date().toISOString(), type, ...by(actor), ...extra });
  store.event(map, `assignment-${type}`, item.nodeId, item.id);
};

export const assignmentActions = {
  // Ask someone to look at this branch. At most one open request per idea.
  assign: { target: 'node', apply: ({ map, node, input, store, actor }) => {
    need(!openAssignment(map, node.id), 'Someone is already asked to look at this branch. Pass it on or mark it done first.', 409);
    const to = label(input.to), note = noteOf(input.note);
    map.assignments = { version: 1, items: [...assignmentsOf(map)] };
    const item = { id: `assignment-${randomUUID().slice(0, 8)}`, nodeId: node.id, requestedFor: to, ...(note ? { note } : {}), status: 'requested', events: [] };
    map.assignments.items.push(item);
    record(store, map, item, 'requested', actor, { to, ...(note ? { note } : {}) });
  } },
  // Take it: the person running Explore, by their Git name, so others see who has it.
  'take-assignment': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const item = itemOf(map, node, input), note = noteOf(input.note);
    need(actor?.name, 'Explore takes your name from Git. Set it (git config user.name) so others see who has this, then take it.', 409);
    need(item.status !== 'done', 'This request is done. Pass it on to reopen it.', 409);
    Object.assign(item, { status: 'taken', takenBy: { name: actor.name } });
    record(store, map, item, 'taken', actor, note ? { note } : {});
  } },
  // Pass it on: a new label, nobody has taken it yet. It reopens a done request too.
  'pass-assignment': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const item = itemOf(map, node, input), to = label(input.to), note = noteOf(input.note);
    need(item.status !== 'done' || !openAssignment(map, node.id), 'Someone is already asked to look at this branch.', 409);
    Object.assign(item, { requestedFor: to, status: 'requested', ...(note ? { note } : {}) }); delete item.takenBy;
    record(store, map, item, 'passed', actor, { to, ...(note ? { note } : {}) });
  } },
  // Mark it done: the person finished looking. The branch is left exactly as it is.
  'complete-assignment': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const item = itemOf(map, node, input), note = noteOf(input.note);
    need(item.status !== 'done', 'This request is already done.', 409);
    item.status = 'done';
    record(store, map, item, 'done', actor, note ? { note } : {});
  } },
};
