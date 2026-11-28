// Hypothesis ideas (K13) in the Store: the result field, the user's record-outcome action, the packet's instruction
// and the generated views. The agent designs a test and may propose an outcome; only the user records one.
import { textField } from './fields.mjs';
import { hypothesisOutcomes, outcomeWords, outcomeOf, day, historyOf, hypothesisOf, testMax, rationaleMax, outcomeNoteMax } from '../assets/hypothesis.js';
import { markdownText } from '../assets/workspace-view.js';

class HypothesisProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new HypothesisProblem(message, status); };
// Optional text that is only spaces is empty.
const optionalText = (value, label, max, fail) => textField(typeof value === 'string' ? value.trim() : value, label, max, fail, { optional: true }) ?? '';

// How to test a claim, from the user or the agent: optional text.
export const hypothesisTest = (value, fail) => optionalText(value, 'How to test it', testMax, fail);

// Returns { hypothesis: { test?, outcome, rationale? } } to keep on the result, or {} without one. Only a hypothesis
// takes it; `outcome` null means the test needs something only the user can do.
export function normalizeHypothesisResult(result, node, fail) {
  if (result.hypothesis === undefined) return {};
  if (node?.kind !== 'hypothesis') fail('Only a hypothesis takes a hypothesis field: the selected idea is not one.');
  const value = result.hypothesis;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('hypothesis must be an object.');
  const outcome = value.outcome ?? null;
  if (outcome !== null && !hypothesisOutcomes.includes(outcome)) fail('hypothesis.outcome must be supported, refuted, inconclusive or null.');
  const test = optionalText(value.test, 'hypothesis.test', testMax, fail);
  const rationale = textField(value.rationale, 'hypothesis.rationale', rationaleMax, fail, { optional: outcome === null });
  return { hypothesis: { ...(test ? { test } : {}), outcome, ...(rationale ? { rationale } : {}) } };
}
// A current result on a hypothesis: its test replaces the idea's (the earlier one stays on its job), and its outcome
// becomes the agent's proposal, never the outcome. Like the rest of the findings, a result without one clears the
// proposal; a stale result never reaches here, and a reset of the findings clears it too.
export function applyHypothesisResult(node, result, jobId, at) {
  const record = hypothesisOf(node);
  if (!record) return;
  if (result.hypothesis?.test) record.test = result.hypothesis.test;
  record.proposed = result.hypothesis?.outcome ? { outcome: result.hypothesis.outcome, rationale: result.hypothesis.rationale, jobId, at } : null;
}

// What the packet adds for a hypothesis, the test shortened like the premise.
export const hypothesisPacket = (node, clip) => { const record = hypothesisOf(node); return record ? { test: clip(typeof record.test === 'string' ? record.test : '', 600), outcome: outcomeOf(record.outcome), proposed: outcomeOf(record.proposed?.outcome) } : null; };
export const hypothesisInstruction = 'This idea is a hypothesis: its premise is the claim. Design the smallest test that could refute it, then gather evidence for and against, and return hypothesis: { test, outcome, rationale }, with outcome supported, refuted, inconclusive, or null when the test needs something only the user can do (ask them in questions instead). A result without hypothesis clears your earlier proposal, so resend it if it still holds. You propose an outcome; never record an outcome: only the user records one.';

export const hypothesisActions = {
  // The user records whether the claim held up. It changes no findings, so it works on a finished hypothesis. Like a
  // changed answer, it is a user statement: work running on the hypothesis or below it becomes stale, and a first
  // refuted or inconclusive outcome, or any change of outcome, flags the findings of the ideas resting on it
  // (descendants and ideas that depend on it) for review. Their questions stay answerable.
  'record-outcome': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const record = hypothesisOf(node);
    need(record, 'Only a hypothesis has an outcome to record.', 409);
    need(hypothesisOutcomes.includes(input.outcome), 'Choose supported, refuted or inconclusive.');
    const note = optionalText(input.note, 'A note', outcomeNoteMax, message => need(false, message));
    const previous = outcomeOf(record.outcome), at = new Date().toISOString();
    Object.assign(record, { outcome: input.outcome, outcomeNote: note, outcomeAt: at });
    record.history = [...historyOf(record), { outcome: input.outcome, note, at, ...(actor?.name ? { by: actor.name } : {}) }];
    node.contentRevision++;
    if (previous ? previous !== input.outcome : input.outcome !== 'supported') store.flagAffected(map, node.id, 'hypothesis-outcome');
    store.event(map, 'outcome-recorded', node.id, input.outcome);
  } },
};

// Node Markdown: the test, the recorded outcome and earlier ones, and the agent's proposal apart.
const recordedLine = item => `${outcomeWords[item.outcome]} (${day(item.at)})${item.by ? ` by ${markdownText(item.by)}` : ''}${item.note ? `. ${markdownText(item.note)}` : '.'}`;
export function hypothesisLines(node) {
  const record = hypothesisOf(node); if (!record) return [];
  const outcome = outcomeOf(record.outcome), proposed = outcomeOf(record.proposed?.outcome), history = historyOf(record);
  return ['## Hypothesis test', '', record.test ? markdownText(record.test) : '_Not designed yet._', '', '## Outcome', '',
    outcome ? `Recorded: ${recordedLine({ ...(history.at(-1) ?? {}), outcome, at: record.outcomeAt, note: record.outcomeNote })}` : '_Not recorded yet._',
    ...(proposed ? ['', `_Proposed by the agent, not recorded: ${outcomeWords[proposed]}.${record.proposed.rationale ? ` ${markdownText(record.proposed.rationale)}` : ''}_`] : []),
    ...(history.length > 1 ? ['', 'Earlier outcomes:', ...history.slice(0, -1).map(item => `- ${recordedLine(item)}`)] : [])];
}
// The brief: one line per hypothesis, the recorded outcome first and the agent's proposal apart, then the claim and
// the test, each shortened on its own so a long claim never hides the outcome.
export function hypothesisBriefText(node, clip) {
  const record = hypothesisOf(node) ?? {}, outcome = outcomeOf(record.outcome), proposed = outcomeOf(record.proposed?.outcome);
  return `Recorded: ${outcome ? `${outcomeWords[outcome]} (${day(record.outcomeAt)})` : 'none'}${proposed ? ` — Proposed by the agent, not recorded: ${outcomeWords[proposed]}` : ''} — Claim: ${clip(node.prompt || node.summary, 160)} — Test: ${record.test ? clip(record.test, 100) : 'not designed yet'}`;
}
