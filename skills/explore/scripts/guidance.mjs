// The map's goal (A1) for the Store: checking it, the set-guidance action, the packet's `goal` and its budget, and the
// Markdown lines. Changing it steers new work only: no idea, flag, review or queued job changes.
import { modes, goalFields, goalMax, goalOf, modeLine } from '../assets/guidance.js';
import { markdownText } from '../assets/workspace-view.js';
import { textField } from './fields.mjs';

class GuidanceProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = message => { throw new GuidanceProblem(message); };
const need = (condition, message, status) => { if (!condition) throw new GuidanceProblem(message, status); };
const now = () => new Date().toISOString();
const labels = { objective: 'The objective', successCriteria: 'What done looks like' };

// The fields `input` gives, checked: a value to set, or null to clear (null, '' or only spaces). Fields it leaves out
// are not in the result.
export function goalChanges(input) {
  const out = {};
  if (input.mode !== undefined) {
    if (input.mode === null || input.mode === '') out.mode = null;
    else { need(Object.hasOwn(modes, input.mode), 'Choose Understand, Decide, Design, Diagnose or Challenge as the mode, or no mode.'); out.mode = input.mode; }
  }
  for (const field of ['objective', 'successCriteria']) {
    const value = input[field];
    if (value === undefined) continue;
    need(value === null || typeof value === 'string', `${labels[field]} must be text.`);
    out[field] = value === null || !value.trim() ? null : textField(value, labels[field], goalMax, fail);
  }
  return out;
}
// The goal a new map is created with: only the fields that are set.
export const normalizeGoal = input => Object.fromEntries(Object.entries(goalChanges(input)).filter(([, value]) => value !== null));

export const goalActions = {
  // `mode`, `objective`, `successCriteria`: each one given is set, or cleared when null or empty; one left out is
  // kept. A save that changes nothing is refused. The old values go to the history.
  'set-guidance': { target: 'map', apply: ({ map, input, store }) => {
    const changes = goalChanges(input);
    need(Object.keys(changes).length, 'Give a mode, an objective or what done looks like.');
    need(Object.entries(changes).some(([field, value]) => (value ?? undefined) !== map[field]), 'Nothing changed.', 409);
    const previous = Object.fromEntries(goalFields.filter(field => map[field] !== undefined).map(field => [field, map[field]]));
    for (const [field, value] of Object.entries(changes)) { if (value === null) delete map[field]; else map[field] = value; }
    map.guidanceUpdatedAt = now();
    store.event(map, 'guidance-changed', null, '', { previous });
  } },
};

// The packet's `goal`: the mode with its focus, and the objective and success criteria, shortened past 1,200
// characters. It is never trimmed for the budget; {} when nothing is set.
const shorten = text => (text.length > 1200 ? `${text.slice(0, 1200)} [Shortened; read the map for the full text.]` : text);
export function goalForPacket(map) {
  const goal = goalOf(map, Infinity);
  if (!goal) return {};
  return { goal: { ...(goal.mode ? { mode: goal.mode, modeFocus: modes[goal.mode].focus } : {}),
    ...(goal.objective ? { objective: shorten(goal.objective) } : {}), ...(goal.successCriteria ? { successCriteria: shorten(goal.successCriteria) } : {}) } };
}
export const goalUse = 'Shape the work by the goal: the mode\'s focus, the objective and what done looks like. A change applies to new work only.';
// The room a typed job's own content may use: the budget less the goal and its sentence. Requests that check a
// packet before it is queued (Check answers) use the same number, so a job accepted is a job that fits.
export function packetBudget(map, { goal = true, budget = 15500 } = {}) {
  const shared = goal ? goalForPacket(map) : {};
  return budget - (shared.goal ? JSON.stringify(shared).length + goalUse.length + 1 : 0);
}

// Markdown for the README and the brief, after the original idea. [] when nothing is set.
export function goalLines(map) {
  const goal = goalOf(map);
  if (!goal) return [];
  return ['## Goal and mode', '', ...(goal.mode ? [`- Mode: ${modeLine(goal.mode)}`] : []), ...(goal.objective ? [`- Objective: ${markdownText(goal.objective)}`] : []),
    ...(goal.successCriteria ? [`- Done looks like: ${markdownText(goal.successCriteria)}`] : [])];
}
