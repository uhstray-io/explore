// A separate research model (Z5): the user may name a model they would like branch research to use. Explore only
// passes it on as a hint; a host that can run a delegated subagent on that model may follow it, and any other host
// does the work itself. Shared by the server and the browser; built into every registry as researchModelHint in
// ideas/settings.json, the same for everyone who opens the repo.
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
// What the agent says happened, in plain text for the run note. Explore cannot verify it.
export const executionText = execution => `Your agent reported: ${execution.model}, ${execution.delegated ? 'delegated' : 'not delegated'}.`;
