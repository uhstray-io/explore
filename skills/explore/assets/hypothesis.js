// Hypothesis ideas (K13): "I think X is true". The idea's premise is the claim; it records how to test the claim and
// then the outcome, which only the user records. The agent may design the test and propose an outcome, kept apart
// as unreviewed. Dependency-free: the Store, the validator, the brief and the app all read it.
export const hypothesisOutcomes = ['supported', 'refuted', 'inconclusive'];
export const outcomeWords = { supported: 'Supported', refuted: 'Refuted', inconclusive: 'Inconclusive' };
export const testMax = 2000, rationaleMax = 1500, outcomeNoteMax = 1000;
export const newHypothesis = (test = '') => ({ test, outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] });
// A hypothesis idea's record, or null for any other idea or a record that is not one (a hand edit the validator reports).
export const hypothesisOf = node => (node?.kind === 'hypothesis' && node.hypothesis && typeof node.hypothesis === 'object' && !Array.isArray(node.hypothesis) ? node.hypothesis : null);
const known = outcome => (Object.hasOwn(outcomeWords, outcome ?? '') ? outcome : null);
const day = at => String(at ?? '').slice(0, 10);

// The canvas: a small mark for the outcome the user recorded, and the words for the idea's label.
const marks = { supported: '✓', refuted: '✕', inconclusive: '~' };
export function outcomeMarkHtml(node) {
  const outcome = known(hypothesisOf(node)?.outcome);
  return outcome ? `<span class="node-outcome ${outcome}" aria-hidden="true">${marks[outcome]}</span>` : '';
}
export function outcomeLabel(node) {
  const outcome = known(hypothesisOf(node)?.outcome);
  return outcome ? `, outcome: ${outcomeWords[outcome]}` : '';
}

// Add a direction: a direction or a hypothesis, and for a hypothesis how to test it (shown only when it is chosen).
export function directionKindHtml(nodeId, { esc, drafts }) {
  const id = esc(nodeId), kind = drafts[`${nodeId}-kind`] === 'hypothesis' ? 'hypothesis' : 'research';
  const choice = (value, label, hint) => `<label class="mode-choice"><input type="radio" name="kind" value="${value}" data-draft="${id}-kind"${kind === value ? ' checked' : ''}> <span><strong>${label}</strong> ${hint}</span></label>`;
  return `<fieldset class="mode-choices direction-kind"><legend>Add it as</legend>${choice('research', 'A direction', 'to explore')}${choice('hypothesis', 'A hypothesis', 'a claim to test: the context is the claim')}</fieldset>`
    + `<div class="hypothesis-test-field"><label for="branch-test">How to test it (optional)</label><textarea id="branch-test" name="test" rows="2" maxlength="${testMax}" data-draft="${id}-test">${esc(drafts[`${nodeId}-test`] ?? '')}</textarea></div>`;
}

// The inspector's Hypothesis section: how to test it, the outcome the user recorded, the agent's proposal apart, earlier
// outcomes, and Record outcome while live. A draft choice wins, then the agent's proposal, then the recorded outcome.
export function hypothesisHtml(node, { esc, live, drafts }) {
  const record = hypothesisOf(node); if (!record) return '';
  const field = (label, text, extra = '') => `<p class="hypothesis-field${extra}"><small>${label}</small>${text}</p>`;
  const recordText = item => `${outcomeWords[item.outcome]} · ${esc(day(item.at ?? item.outcomeAt))}.${item.note ? ` ${esc(item.note)}` : ''}`;
  const outcome = known(record.outcome), proposed = known(record.proposed?.outcome);
  const history = Array.isArray(record.history) ? record.history.filter(item => known(item?.outcome)) : [];
  const earlier = history.slice(0, -1).reverse();
  const id = esc(node.id), chosen = known(drafts[`${node.id}-outcome`]) ?? proposed ?? outcome;
  return `<h3 class="section-label">Hypothesis</h3>${field('How to test it', record.test ? esc(record.test) : 'Not designed yet. Your agent proposes a test when it explores this.')}`
    + field('Outcome you recorded', outcome ? recordText({ outcome, at: record.outcomeAt, note: record.outcomeNote }) : 'Not recorded yet.', ` hypothesis-outcome${outcome ? ` ${outcome}` : ''}`)
    + (proposed ? field('Proposed by your agent, not recorded', `${outcomeWords[proposed]}.${record.proposed.rationale ? ` ${esc(record.proposed.rationale)}` : ''}`, ' hypothesis-proposed') : '')
    + (earlier.length ? `<details class="hypothesis-history"><summary>Earlier outcomes (${earlier.length})</summary><ul>${earlier.map(item => `<li>${recordText(item)}</li>`).join('')}</ul></details>` : '')
    + (live ? `<details data-editor="outcome-${id}"><summary>Record outcome</summary><form class="outcome-form" data-outcome-form="" data-node-id="${id}"><fieldset class="mode-choices"><legend>Did the claim hold up?</legend>`
      + hypothesisOutcomes.map(value => `<label class="mode-choice"><input type="radio" name="outcome" value="${value}" data-draft="${id}-outcome" required${chosen === value ? ' checked' : ''}> <strong>${outcomeWords[value]}</strong></label>`).join('')
      + `</fieldset><label for="outcome-note-${id}">Note (optional)</label><textarea id="outcome-note-${id}" name="note" rows="2" maxlength="${outcomeNoteMax}" data-draft="${id}-outcome-note">${esc(drafts[`${node.id}-outcome-note`] ?? '')}</textarea>`
      + '<button type="submit" class="secondary">Record outcome</button></form></details>' : '');
}
