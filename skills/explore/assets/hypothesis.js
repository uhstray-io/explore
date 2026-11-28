// Hypothesis ideas (K13): "I think X is true". The idea's premise is the claim; it records how to test the claim and
// then the outcome, which only the user records. The agent may design the test and propose an outcome, kept apart
// as unreviewed. Dependency-free: the Store, the validator, the brief and the app all read it.
export const hypothesisOutcomes = ['supported', 'refuted', 'inconclusive'];
export const outcomeWords = { supported: 'Supported', refuted: 'Refuted', inconclusive: 'Inconclusive' };
export const testMax = 2000, rationaleMax = 1500, outcomeNoteMax = 1000;
export const newHypothesis = (test = '') => ({ test, outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] });
// A hypothesis idea's record, or null for any other idea or a record that is not one (a hand edit the validator reports).
export const hypothesisOf = node => (node?.kind === 'hypothesis' && node.hypothesis && typeof node.hypothesis === 'object' && !Array.isArray(node.hypothesis) ? node.hypothesis : null);
// A recorded or proposed outcome, or null for anything else.
export const outcomeOf = value => (Object.hasOwn(outcomeWords, value ?? '') ? value : null);
export const day = at => String(at ?? '').slice(0, 10);
// Every outcome the user recorded, oldest first, readable records only.
export const historyOf = record => (Array.isArray(record?.history) ? record.history.filter(item => outcomeOf(item?.outcome)) : []);

// The canvas: a small mark for the outcome the user recorded, in the top-left corner, clear of the status badge and the
// hidden-directions count, and the words for the idea's label.
const marks = { supported: '+', refuted: '×', inconclusive: '~' };
export function outcomeMarkHtml(node) {
  const outcome = outcomeOf(hypothesisOf(node)?.outcome);
  return outcome ? `<span class="node-outcome ${outcome}" aria-hidden="true">${marks[outcome]}</span>` : '';
}
export function outcomeLabel(node) {
  const outcome = outcomeOf(hypothesisOf(node)?.outcome);
  return outcome ? `, outcome: ${outcomeWords[outcome]}` : '';
}

// What the forms send: Add a direction (a direction, or a hypothesis with how to test it) and Record outcome. Optional
// text that is only spaces is empty.
export const suggestPayload = data => ({ title: data.title, body: (data.body ?? '').trim() || data.title, ...(data.kind === 'hypothesis' ? { kind: 'hypothesis', test: (data.test ?? '').trim() } : {}) });
export const outcomePayload = data => ({ outcome: data.outcome, note: (data.note ?? '').trim() });

// Add a direction: a direction or a hypothesis, and for a hypothesis how to test it (shown only when it is chosen).
export function directionKindHtml(nodeId, { esc, drafts }) {
  const id = esc(nodeId), kind = drafts[`${nodeId}-kind`] === 'hypothesis' ? 'hypothesis' : 'research';
  const choice = (value, label, hint) => `<label class="mode-choice"><input type="radio" name="kind" value="${value}" data-draft="${id}-kind"${kind === value ? ' checked' : ''}> <span><strong>${label}</strong> ${hint}</span></label>`;
  return `<fieldset class="mode-choices direction-kind"><legend>Add it as</legend>${choice('research', 'A direction', 'to explore')}${choice('hypothesis', 'A hypothesis', 'a claim to test: the context is the claim')}</fieldset>`
    + `<div class="hypothesis-test-field"><label for="branch-test">How to test it (optional)</label><textarea id="branch-test" name="test" rows="2" maxlength="${testMax}" data-draft="${id}-test">${esc(drafts[`${nodeId}-test`] ?? '')}</textarea></div>`;
}

// The inspector's Hypothesis section: how to test it, the outcome the user recorded, the agent's proposal apart, earlier
// outcomes, and Record outcome while live. Record outcome starts from a draft choice, else the agent's proposal when
// nothing is recorded or the proposal came after it, else the recorded outcome.
export function hypothesisHtml(node, { esc, live, drafts }) {
  const record = hypothesisOf(node); if (!record) return '';
  const field = (label, text, extra = '') => `<p class="hypothesis-field${extra}"><small>${label}</small>${text}</p>`;
  const recordText = item => `${outcomeWords[item.outcome]} · ${esc(day(item.at))}.${item.note ? ` ${esc(item.note)}` : ''}`;
  const outcome = outcomeOf(record.outcome), proposed = outcomeOf(record.proposed?.outcome), earlier = historyOf(record).slice(0, -1).reverse();
  const proposalCurrent = proposed && (!outcome || String(record.proposed.at ?? '') > String(record.outcomeAt ?? ''));
  const id = esc(node.id), chosen = outcomeOf(drafts[`${node.id}-outcome`]) ?? (proposalCurrent ? proposed : outcome);
  return `<h3 class="section-label">Hypothesis</h3>${field('How to test it', record.test ? esc(record.test) : 'Not designed yet. Your agent proposes a test when it explores this.')}`
    + field('Outcome you recorded', outcome ? recordText({ outcome, at: record.outcomeAt, note: record.outcomeNote }) : 'Not recorded yet.', ` hypothesis-outcome${outcome ? ` ${outcome}` : ''}`)
    + (proposed ? field('Proposed by your agent, not recorded', `${outcomeWords[proposed]}.${record.proposed.rationale ? ` ${esc(record.proposed.rationale)}` : ''}`, ' hypothesis-proposed') : '')
    + (earlier.length ? `<details class="hypothesis-history" data-editor="outcome-history-${id}"><summary>Earlier outcomes (${earlier.length})</summary><ul>${earlier.map(item => `<li>${recordText(item)}</li>`).join('')}</ul></details>` : '')
    + (live ? `<details data-editor="outcome-${id}"><summary>Record outcome</summary><form class="outcome-form" data-outcome-form="" data-node-id="${id}"><fieldset class="mode-choices"><legend>Did the claim hold up?</legend>`
      + hypothesisOutcomes.map(value => `<label class="mode-choice"><input type="radio" name="outcome" value="${value}" data-draft="${id}-outcome" required${chosen === value ? ' checked' : ''}> <strong>${outcomeWords[value]}</strong></label>`).join('')
      + `</fieldset><label for="outcome-note-${id}">Note (optional)</label><textarea id="outcome-note-${id}" name="note" rows="2" maxlength="${outcomeNoteMax}" data-draft="${id}-outcome-note">${esc(drafts[`${node.id}-outcome-note`] ?? '')}</textarea>`
      + '<button type="submit" class="secondary">Record outcome</button></form></details>' : '');
}
