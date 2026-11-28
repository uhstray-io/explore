// The assumptions register (K6) in the Store: the agent's interpretations on a result, what a finding rests on without
// proof, each with what would change it; and the user's note on what would disprove one of their own assumptions.
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { isAssumption, disproveIfMax } from '../assets/questions.js';
import { interpretationsOf } from '../assets/assumptions.js';

export const maxAssumptions = 8, assumptionMax = 600;
class AssumptionProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new AssumptionProblem(message, status); };

// Returns { assumptions } to keep on the result, or {} when it has none. `fail(message)` throws the caller's error.
export function normalizeAssumptions(result, fail) {
  const { assumptions } = result;
  if (assumptions === undefined) return {};
  if (!Array.isArray(assumptions) || assumptions.length > maxAssumptions) fail(`assumptions must be a list of at most ${maxAssumptions} items.`);
  if (!assumptions.length) return {};
  return { assumptions: assumptions.map((item, index) => {
    const label = `Assumption ${index + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${label} must be an object.`);
    if (item.wouldChangeIf === undefined) fail(`${label} needs wouldChangeIf: what would change this interpretation.`);
    return { statement: textField(item.statement, `${label} statement`, assumptionMax, fail), wouldChangeIf: textField(item.wouldChangeIf, `${label} wouldChangeIf`, assumptionMax, fail) };
  }) };
}

export const assumptionActions = {
  // What would disprove an assumption: the user's note on their own current answer marked Assumption. An annotation,
  // so it is allowed on a finished branch and never changes content. Empty text removes it; a change that changes
  // nothing is refused, so it records no version.
  'set-disprove-if': { target: 'node', apply: ({ map, node, input, store }) => {
    const question = node.questions.find(q => q.id === input.questionId);
    need(question, 'Question not found.', 404);
    const text = textField(typeof input.text === 'string' ? input.text.trim() : input.text, 'What would disprove it', disproveIfMax, message => need(false, message), { optional: true }) ?? '';
    if (text) need(isAssumption(question), 'Only a current answer marked Assumption takes a note on what would disprove it.', 409);
    need(text !== (question.disproveIf ?? ''), 'Nothing changed.', 409);
    if (text) question.disproveIf = text; else delete question.disproveIf;
    store.event(map, 'disprove-if-set', node.id, question.id);
  } },
};

// Packets carry the interpretations shortened, so a continuing branch can resend the ones that still hold.
export const assumptionsForPacket = (node, clip) => interpretationsOf(node).map(item => ({ statement: clip(item.statement, 200), wouldChangeIf: clip(item.wouldChangeIf ?? '', 200) }));
// One interpretation as lines: section reads keep the text as saved; node Markdown passes `format: markdownText`.
export const assumptionRecord = (item, format = text => text) => [`- ${format(item.statement)}`, `  - Would change if: ${item.wouldChangeIf ? format(item.wouldChangeIf) : 'not stated'}`];
export function assumptionLines(node) {
  const items = interpretationsOf(node);
  if (!items.length) return [];
  return ['## Interpretations', '', '_The agent\'s interpretations: unverified._', '', ...items.flatMap(item => assumptionRecord(item, markdownText))];
}
