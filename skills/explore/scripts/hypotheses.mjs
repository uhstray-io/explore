// Hypothesis ideas (K13) in the Store: the result field, the user's record-outcome action, the packet's instruction
// and the generated views. The agent designs a test and may propose an outcome; only the user records one.
import { textField } from './fields.mjs';
import { hypothesisOutcomes, outcomeWords, newHypothesis, hypothesisOf, testMax, rationaleMax, outcomeNoteMax } from '../assets/hypothesis.js';
import { markdownText } from '../assets/workspace-view.js';

class HypothesisProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new HypothesisProblem(message, status); };
const day = at => String(at ?? '').slice(0, 10);

// How to test a claim, from the user or the agent: optional text.
export const hypothesisTest = (value, fail) => textField(value, 'How to test it', testMax, fail, { optional: true }) ?? '';
// A new hypothesis idea's record, with its test.
export { newHypothesis };

// Returns { hypothesis: { test?, outcome, rationale? } } to keep on the result, or {} without one. Only a hypothesis
// takes it; `outcome` null means the test needs something only the user can do.
export function normalizeHypothesisResult(result, node, fail) {
  if (result.hypothesis === undefined) return {};
  if (node?.kind !== 'hypothesis') fail('Only a hypothesis takes a hypothesis field: the selected idea is not one.');
  const value = result.hypothesis;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('hypothesis must be an object.');
  const outcome = value.outcome ?? null;
  if (outcome !== null && !hypothesisOutcomes.includes(outcome)) fail('hypothesis.outcome must be supported, refuted, inconclusive or null.');
  const test = textField(value.test, 'hypothesis.test', testMax, fail, { optional: true });
  const rationale = textField(value.rationale, 'hypothesis.rationale', rationaleMax, fail, { optional: outcome === null });
  return { hypothesis: { ...(test ? { test } : {}), outcome, ...(rationale ? { rationale } : {}) } };
}
// A current result's test replaces the idea's, and its outcome becomes the agent's proposal, never the outcome.
export function applyHypothesisResult(node, result, jobId) {
  const record = hypothesisOf(node);
  if (!record || !result.hypothesis) return;
  if (result.hypothesis.test) record.test = result.hypothesis.test;
  record.proposed = result.hypothesis.outcome ? { outcome: result.hypothesis.outcome, rationale: result.hypothesis.rationale, jobId } : null;
}

// What the packet adds for a hypothesis.
export const hypothesisPacket = node => { const record = hypothesisOf(node); return record ? { test: record.test, outcome: record.outcome, proposed: record.proposed?.outcome ?? null } : null; };
export const hypothesisInstruction = 'This idea is a hypothesis: its premise is the claim. Design the smallest test that could refute it, then gather evidence for and against, and return hypothesis: { test, outcome, rationale }, with outcome supported, refuted, inconclusive, or null when the test needs something only the user can do (ask them in questions instead). You propose an outcome; never record an outcome: only the user records one.';

export const hypothesisActions = {
  // The user records whether the claim held up. It changes no findings, so it works on a finished hypothesis. A first
  // refuted or inconclusive outcome, or any change of outcome, flags what rests on it: its descendants and the ideas
  // that depend on it, as a changed premise would. The hypothesis itself is left as it is.
  'record-outcome': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const record = hypothesisOf(node);
    need(record, 'Only a hypothesis has an outcome to record.', 409);
    need(hypothesisOutcomes.includes(input.outcome), 'Choose supported, refuted or inconclusive.');
    const note = textField(input.note, 'A note', outcomeNoteMax, message => need(false, message), { optional: true }) ?? '';
    const previous = record.outcome, at = new Date().toISOString();
    Object.assign(record, { outcome: input.outcome, outcomeNote: note, outcomeAt: at });
    record.history = [...(Array.isArray(record.history) ? record.history : []), { outcome: input.outcome, note, at, ...(actor?.name ? { by: actor.name } : {}) }];
    if (previous ? previous !== input.outcome : input.outcome !== 'supported') {
      const resting = new Set([...store.affectedBy(map, node.id)].filter(id => id !== node.id));
      if (resting.size) store.invalidate(map, resting, { sourceId: node.id, kind: 'hypothesis-outcome' });
    }
    store.event(map, 'outcome-recorded', node.id, input.outcome);
  } },
};

// Node Markdown: the test, the recorded outcome and earlier ones, and the agent's proposal apart.
export function hypothesisLines(node) {
  const record = hypothesisOf(node); if (!record) return [];
  const recorded = item => `${outcomeWords[item.outcome]} (${day(item.at)})${item.note ? `. ${markdownText(item.note)}` : '.'}`;
  const history = (Array.isArray(record.history) ? record.history : []).filter(item => Object.hasOwn(outcomeWords, item?.outcome ?? ''));
  return ['## Hypothesis test', '', record.test ? markdownText(record.test) : '_Not designed yet._', '', '## Outcome', '',
    Object.hasOwn(outcomeWords, record.outcome ?? '') ? `Recorded: ${recorded({ outcome: record.outcome, at: record.outcomeAt, note: record.outcomeNote })}` : '_Not recorded yet._',
    ...(record.proposed && Object.hasOwn(outcomeWords, record.proposed.outcome ?? '') ? ['', `_Proposed by the agent, not recorded: ${outcomeWords[record.proposed.outcome]}.${record.proposed.rationale ? ` ${markdownText(record.proposed.rationale)}` : ''}_`] : []),
    ...(history.length > 1 ? ['', 'Earlier outcomes:', ...history.slice(0, -1).map(item => `- ${recorded(item)}`)] : [])];
}
// The brief: one line per hypothesis, with the recorded outcome and the agent's proposal kept apart.
export function hypothesisBriefText(node) {
  const record = hypothesisOf(node) ?? {};
  const outcome = Object.hasOwn(outcomeWords, record.outcome ?? '') ? `${outcomeWords[record.outcome]} (${day(record.outcomeAt)})` : 'none';
  const proposed = Object.hasOwn(outcomeWords, record.proposed?.outcome ?? '') ? ` — Proposed by the agent, not recorded: ${outcomeWords[record.proposed.outcome]}` : '';
  return `Claim: ${node.prompt || node.summary} — Test: ${record.test || 'not designed yet'} — Recorded: ${outcome}${proposed}`;
}
