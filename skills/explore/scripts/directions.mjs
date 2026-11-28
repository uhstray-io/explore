// A new direction under an idea, made one way for Add a direction (`suggest`) and for a thought placed from the inbox
// (K8): a suggested child, never activated, in one growth batch. A hypothesis (K13) carries how to test it. `unique`
// refuses a title the idea already has a direction for, as agent suggestions are refused.
import { hypothesisTest } from './hypotheses.mjs';
import { existingChild } from './result-checks.mjs';

class DirectionProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new DirectionProblem(message, status); };

export function addDirection(store, map, parent, { title, body, kind = 'research', test }, { detail, unique = false } = {}) {
  need(kind === 'research' || kind === 'hypothesis', 'Choose a direction or a hypothesis.');
  need(!unique || !existingChild(map, parent, title), `“${title}” is already a direction under this idea.`, 409);
  const child = store.node(title, body, kind, parent.id, kind === 'hypothesis' ? { test: hypothesisTest(test, message => need(false, message)) } : {});
  const edge = { from: parent.id, to: child.id, type: 'contains' };
  map.nodes.push(child); map.edges.push(edge);
  store.recordGrowth(map, [child], [edge]);
  store.event(map, 'suggested', child.id, detail);
  return child;
}
