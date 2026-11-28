import { canSetDoneWhen } from '../assets/done-when.js';

// A branch's stopping point (K4): what the user says would be enough. Only the user's actions set it; it never
// flags findings or queues work, and an agent's result cannot carry it.
class DoneWhenProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new DoneWhenProblem(message, status); };

// The one place it changes, from `activate` or `set-done-when`. A complete or running branch is refused before the
// text is looked at; the text becomes one line of at most 400 characters, and empty clears it. Returns whether it
// changed; a change records done-when-set.
export function applyDoneWhen(store, map, node, value) {
  const completed = store.isComplete(map, node);
  if (!canSetDoneWhen(node, completed)) need(false, completed ? 'This branch is complete, so its stopping point stays as it was.' : 'This branch is running and already has its instructions. Stop it first to change when it is done.', 409);
  need(typeof value === 'string', 'Say when the branch is done as text, or leave it empty.');
  const next = value.replace(/\s+/g, ' ').trim();
  need(next.length <= 400, 'When the branch is done must be at most 400 characters.');
  if ((node.doneWhen ?? '') === next) return false;
  if (next) node.doneWhen = next; else delete node.doneWhen;
  store.event(map, 'done-when-set', node.id, next ? 'Stopping point set.' : 'Stopping point cleared.');
  return true;
}

export const doneWhenActions = {
  // User-only. `doneWhen`.
  'set-done-when': { target: 'node', apply: ({ map, node, input, store }) => { need(applyDoneWhen(store, map, node, input.doneWhen), 'Nothing changed.', 409); } },
};
