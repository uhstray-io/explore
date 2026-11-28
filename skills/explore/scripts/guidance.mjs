// Mode, objective and success criteria (A1) for the Store: checking them, the set-guidance action, the packet field
// and the Markdown lines. Changing them steers new work only: no idea, flag, review or queued job changes.
import { modes, guidanceFields, guidanceMax, guidanceOf, modeLine } from '../assets/guidance.js';
import { markdownText } from '../assets/workspace-view.js';

class GuidanceProblem extends Error { constructor(message) { super(message); this.status = 400; } }
const fail = message => { throw new GuidanceProblem(message); };
const labels = { objective: 'The objective', successCriteria: 'What done looks like' };

// The guidance in `input`, checked. A field left out, null or empty is not set. Returns only the set fields.
export function normalizeGuidance(input) {
  const out = {};
  if (input.mode !== undefined && input.mode !== null && input.mode !== '') {
    if (!Object.hasOwn(modes, input.mode)) fail('Choose Understand, Decide, Design, Diagnose or Challenge as the mode, or no mode.');
    out.mode = input.mode;
  }
  for (const field of ['objective', 'successCriteria']) {
    const value = input[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') fail(`${labels[field]} must be text.`);
    if (value.length > guidanceMax) fail(`${labels[field]} must be at most ${guidanceMax} characters.`);
    if (value.trim()) out[field] = value.trim();
  }
  return out;
}

export const guidanceActions = {
  // `mode`, `objective`, `successCriteria`: the new guidance as a whole; a field left out is cleared. The old values
  // go to the history.
  'set-guidance': { target: 'map', apply: ({ map, input, store }) => {
    const next = normalizeGuidance(input);
    const previous = Object.fromEntries(guidanceFields.filter(field => map[field] !== undefined).map(field => [field, map[field]]));
    for (const field of guidanceFields) { if (next[field] === undefined) delete map[field]; else map[field] = next[field]; }
    map.guidanceUpdatedAt = new Date().toISOString();
    store.event(map, 'guidance-changed', null);
    map.history.at(-1).previous = previous;
  } },
};

// The packet's `guidance`: the mode with its focus, and the objective and success criteria, shortened past 1,200
// characters. Counted before any trimming, so it is never dropped; {} when nothing is set.
const clip = text => (text.length > 1200 ? `${text.slice(0, 1200)} [Shortened; read the map for the full text.]` : text);
export function guidanceForPacket(map) {
  const guidance = guidanceOf(map);
  if (!guidance) return {};
  return { guidance: { ...(guidance.mode ? { mode: guidance.mode, modeFocus: modes[guidance.mode].focus } : {}),
    ...(guidance.objective ? { objective: clip(guidance.objective) } : {}), ...(guidance.successCriteria ? { successCriteria: clip(guidance.successCriteria) } : {}) } };
}
export const guidanceUse = 'Shape the work by guidance: the mode\'s focus, the objective and what done looks like. A change applies to new work only.';

// Markdown for the README and the brief, after the original idea. [] when nothing is set.
export function guidanceLines(map) {
  const guidance = guidanceOf(map);
  if (!guidance) return [];
  return ['## Goal and mode', '', ...(guidance.mode ? [`- Mode: ${modeLine(guidance.mode)}`] : []), ...(guidance.objective ? [`- Objective: ${markdownText(guidance.objective)}`] : []),
    ...(guidance.successCriteria ? [`- Done looks like: ${markdownText(guidance.successCriteria)}`] : [])];
}
