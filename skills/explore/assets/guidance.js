// The map's goal (A1): a mode, an objective and what done looks like. All three are optional, and a map without
// them works as before. The agent receives them with every job as `goal` and applies a change to new work only.
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
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

// The map's goal with only the parts that are set, or null. A mode from a newer Explore is left out, and text from a
// pulled or imported map is clipped to `max`, so views stay bounded.
export function goalOf(map, max = guidanceMax) {
  const out = { ...(Object.hasOwn(modes, map?.mode ?? '') ? { mode: map.mode } : {}),
    ...(typeof map?.objective === 'string' && map.objective ? { objective: clip(map.objective, max) } : {}),
    ...(typeof map?.successCriteria === 'string' && map.successCriteria ? { successCriteria: clip(map.successCriteria, max) } : {}) };
  return Object.keys(out).length ? out : null;
}
export const modeLabel = map => modes[goalOf(map)?.mode]?.label ?? '';

// From the create dialog's form: only what the user filled in, so an unopened disclosure sends nothing.
export function guidanceInput(data) {
  const out = {};
  for (const field of guidanceFields) { const value = data.get(field); if (typeof value === 'string' && value.trim()) out[field] = value; }
  return out;
}
// Whether the editor's form would change nothing, so Save just closes it.
export const guidanceUnchanged = (map, data) => guidanceFields.every(field => String(data[field] ?? '').trim() === String(map[field] ?? '').trim());

// The fields, in the create dialog and in the inspector's editor alike: the modes with their focus (and No mode), the
// objective and what done looks like. `chosen` is the checked mode ('' for No mode); null checks none. `drafts` and
// `draftKey` keep what the user is typing across a redraw.
export function goalFieldsHtml({ esc, prefix, chosen = null, values = {}, drafts = {}, draftKey = null }) {
  const draft = field => (draftKey ? ` data-draft="${esc(`${prefix}-${field}:${draftKey}`)}"` : '');
  const value = field => esc((draftKey ? drafts[`${prefix}-${field}:${draftKey}`] : undefined) ?? values[field] ?? '');
  const mode = (draftKey ? drafts[`${prefix}-mode:${draftKey}`] : undefined) ?? chosen;
  const choice = (key, label, focus) => `<label class="mode-choice"><input type="radio" name="mode" value="${key}"${mode === key ? ' checked' : ''}${draft('mode')}><span><strong>${esc(label)}</strong>${focus ? ` ${esc(focus)}` : ''}</span></label>`;
  return `<fieldset class="mode-choices"><legend>What kind of exploration is this?</legend>${choice('', 'No mode', '')}${Object.entries(modes).map(([key, entry]) => choice(key, entry.label, entry.focus)).join('')}</fieldset>`
    + `<label for="${prefix}-objective">Objective <span>(optional)</span></label><textarea id="${prefix}-objective" name="objective" rows="2" maxlength="${guidanceMax}" placeholder="What you want from this exploration"${draft('objective')}>${value('objective')}</textarea>`
    + `<label for="${prefix}-success">What done looks like <span>(optional)</span></label><textarea id="${prefix}-success" name="successCriteria" rows="2" maxlength="${guidanceMax}" placeholder="A recommendation you can act on"${draft('successCriteria')}>${value('successCriteria')}</textarea>`;
}

// The starting idea's inspector: the goal, when any is set.
export function guidanceSectionHtml(map, { esc }) {
  const goal = goalOf(map);
  if (!goal) return '';
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : '');
  return `<div class="guidance-summary"><h3 class="section-label">Goal and mode</h3><dl>${row('Mode', goal.mode && modeLine(goal.mode))}${row('Objective', goal.objective)}${row('Done looks like', goal.successCriteria)}</dl></div>`;
}

// Its editor, with the other editors at the foot of the inspector.
export function guidanceEditorHtml(map, { esc, drafts }) {
  const root = esc(map.rootId), set = goalOf(map);
  return `<details data-editor="guidance"><summary data-command="edit-guidance" data-command-editor="guidance" data-node-id="${root}">${set ? 'Edit goal and mode' : 'Set a goal and mode'}</summary><form id="guidance-form" data-node-id="${root}">`
    + goalFieldsHtml({ esc, prefix: 'guidance', chosen: set?.mode ?? '', values: map, drafts, draftKey: map.id })
    + `<p class="form-note">Steers new work only. Findings you already have stay as they are.</p><button class="secondary" type="submit">Save</button></form></details>`;
}
