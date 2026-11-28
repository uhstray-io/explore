import { textField } from './fields.mjs';

// A separate research model (Z5): the user may name a model they would like branch research to use. Explore only
// passes it on as a hint; a host that can run a delegated subagent on that model may follow it, and any other host
// does the work itself. Built into every registry as researchModelHint in ideas/settings.json, the same for
// everyone who opens the repo.
export const researchModelMax = 100;
export const modelHintNote = 'User preference for research jobs. Follow it only if your host can run a delegated subagent on this model; otherwise do the work yourself.';
class ResearchModelProblem extends Error { constructor(message) { super(message); this.status = 400; } }
export const researchModelSetting = { default: '', validate: value => {
  if (typeof value !== 'string') throw new ResearchModelProblem('Name the research model as text, or leave it empty.');
  const model = value.trim();
  if (/[\r\n]/.test(model)) throw new ResearchModelProblem('Name the research model on one line.');
  if (model.length > researchModelMax) throw new ResearchModelProblem(`Name the research model in at most ${researchModelMax} characters.`);
  return model;
} };
// The packet field for a saved hint, or null when none is set.
export const modelHintFor = model => (model ? { model, note: modelHintNote } : null);

// How the agent says it ran an investigation: its own report, which Explore cannot verify. Kept on the job beside
// the worker, never with the findings. Returns the record or null; `fail(message)` throws the caller's error.
export function normalizeExecution(value, fail) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('execution must be an object.');
  if (typeof value.delegated !== 'boolean') fail('execution.delegated must be true or false.');
  const note = textField(value.note, 'execution.note', 200, fail, { optional: true });
  return { delegated: value.delegated, model: textField(value.model, 'execution.model', 200, fail), ...(note ? { note } : {}) };
}
