// The agent's interpretations (K6): what a finding rests on without proof, each with what would change it. A result
// records them in `assumptions`; they belong to the findings, kept apart from the findings text.
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { maxAssumptions, assumptionMax } from '../assets/assumptions.js';

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

// Node Markdown: the interpretations, each on one line and escaped.
export function assumptionLines(node) {
  if (!node.assumptions?.length) return [];
  return ['## Interpretations', '', '_The agent\'s interpretations: unverified._', '', ...node.assumptions.flatMap(item => [`- ${markdownText(item.statement)}`, `  - Would change if: ${markdownText(item.wouldChangeIf)}`])];
}
