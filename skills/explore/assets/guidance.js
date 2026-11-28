// Mode, objective and success criteria (A1): what the user is exploring for. All three are optional, and a map
// without them works as before. The agent receives them with every job and applies a change to new work only.
// Shared by the Store, the brief, the CLI and the app.
export const modes = {
  understand: { label: 'Understand', focus: 'concepts, stakeholders and unknowns' },
  decide: { label: 'Decide', focus: 'choices, criteria and trade-offs' },
  design: { label: 'Design', focus: 'intended outcomes, constraints, interfaces and feasibility' },
  diagnose: { label: 'Diagnose', focus: 'symptoms, reproduction, evidence and alternative causes' },
  challenge: { label: 'Challenge', focus: 'assumptions, counterexamples and failure conditions' },
};
export const guidanceFields = ['mode', 'objective', 'successCriteria'];
export const guidanceMax = 2000;
export const modeLine = mode => `${modes[mode].label} — ${modes[mode].focus}`;

// The map's guidance as saved, with only the parts that are set, or null. A mode from a newer Explore is left out.
export function guidanceOf(map) {
  const out = { ...(Object.hasOwn(modes, map?.mode ?? '') ? { mode: map.mode } : {}), ...(map?.objective ? { objective: map.objective } : {}),
    ...(map?.successCriteria ? { successCriteria: map.successCriteria } : {}) };
  return Object.keys(out).length ? out : null;
}
export const modeLabel = map => modes[guidanceOf(map)?.mode]?.label ?? '';

// From the create dialog's form: only what the user filled in, so an unopened disclosure sends nothing.
export function guidanceInput(data) {
  const out = {};
  for (const field of guidanceFields) { const value = data.get(field); if (typeof value === 'string' && value.trim()) out[field] = value; }
  return out;
}

// The create dialog's choices: each mode with its focus, none chosen.
export const modeChoicesHtml = esc => Object.entries(modes).map(([key, mode]) =>
  `<label class="mode-choice"><input type="radio" name="mode" value="${key}"><span><strong>${esc(mode.label)}</strong> ${esc(mode.focus)}</span></label>`).join('');

// The starting idea's inspector: the guidance, when any is set.
export function guidanceSectionHtml(map, { esc }) {
  const guidance = guidanceOf(map);
  if (!guidance) return '';
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : '');
  return `<section class="guidance-summary" aria-label="Goal and mode"><h3 class="section-label">Goal and mode</h3><dl>${row('Mode', guidance.mode && modeLine(guidance.mode))}${row('Objective', guidance.objective)}${row('Done looks like', guidance.successCriteria)}</dl></section>`;
}

// Its editor, with the other editors at the foot of the inspector. Drafts keep what the user is typing across a poll.
export function guidanceEditorHtml(map, { esc, drafts }) {
  const key = field => `guidance-${field}:${map.id}`, value = field => drafts[key(field)] ?? map[field] ?? '';
  const mode = value('mode'), set = guidanceOf(map);
  const options = Object.entries(modes).map(([id, entry]) => `<option value="${id}"${id === mode ? ' selected' : ''}>${esc(modeLine(id))}</option>`).join('');
  return `<details data-editor="guidance"><summary data-command="edit-guidance" data-command-editor="guidance" data-node-id="${esc(map.rootId)}">${set ? 'Edit goal and mode' : 'Set a goal and mode'}</summary><form id="guidance-form" data-node-id="${esc(map.rootId)}">`
    + `<label for="guidance-mode">Mode</label><select id="guidance-mode" name="mode" data-draft="${esc(key('mode'))}"><option value="">No mode</option>${options}</select>`
    + `<label for="guidance-objective">Objective <span>(optional)</span></label><textarea id="guidance-objective" name="objective" maxlength="${guidanceMax}" data-draft="${esc(key('objective'))}" rows="3">${esc(value('objective'))}</textarea>`
    + `<label for="guidance-success">What done looks like <span>(optional)</span></label><textarea id="guidance-success" name="successCriteria" maxlength="${guidanceMax}" data-draft="${esc(key('successCriteria'))}" rows="3">${esc(value('successCriteria'))}</textarea>`
    + `<p class="form-note">Steers new work only. Findings you already have stay as they are.</p><button class="primary" type="submit">Save</button></form></details>`;
}
