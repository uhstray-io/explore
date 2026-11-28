import { effectiveAnswerState, hasCurrentAnswer } from './questions.js';
import { impactOf } from './impact.js';
import { treeOrder } from './graph.js';

// The assumptions register (K6): everything the exploration rests on without proof, in one list. The user's own
// answers marked Assumption, and the agent's stated interpretations, each with what would change it and the ideas a
// change to its idea would reach (impact, D4). Pure and read-only; the dialog is assumptions-dialog.js.
export const maxAssumptions = 8, assumptionMax = 600, disproveIfMax = 1000;
const isText = value => typeof value === 'string' && value.trim() !== '';

// [{ kind: 'answer' | 'interpretation', nodeId, title, questionId?, question?, text, disproveIf, stale, dependents }]:
// most dependents first, then in reading order. `disproveIf` is the user's note on an answer, or the agent's "would
// change if", or null when not stated. An interpretation on a cleared finding is not relied on, so it is left out;
// one that is not text (a hand edit the validator reports) is skipped.
export function assumptionRegister(map) {
  const order = new Map(treeOrder(map).map(({ node }, at) => [node.id, at])), entries = [];
  for (const node of map.nodes) {
    const base = { nodeId: node.id, title: node.title, stale: !!node.stale };
    const answers = (node.questions ?? []).filter(q => hasCurrentAnswer(q) && effectiveAnswerState(q).state === 'assumption');
    const readings = node.reviewState === 'cleared' ? [] : (node.assumptions ?? []).filter(item => isText(item?.statement));
    if (!answers.length && !readings.length) continue;
    const dependents = impactOf(map, node.id).affected;
    for (const q of answers) entries.push({ kind: 'answer', ...base, questionId: q.id, question: q.text, text: q.answer, disproveIf: isText(q.disproveIf) ? q.disproveIf : null, dependents });
    for (const item of readings) entries.push({ kind: 'interpretation', ...base, text: item.statement, disproveIf: isText(item.wouldChangeIf) ? item.wouldChangeIf : null, dependents });
  }
  return entries.sort((a, b) => b.dependents.length - a.dependents.length || order.get(a.nodeId) - order.get(b.nodeId));
}

// The dialog body: "Your assumptions", then "Agent interpretations". `editing` is the "nodeId questionId" key of the
// note being edited; `live` false (growth history or a saved version) offers no edits. `map` names the dependents.
export function assumptionsHtml(entries, { esc, live, editing, map }) {
  const keyOf = entry => `${entry.nodeId} ${entry.questionId}`;
  const change = entry => {
    if (entry.kind === 'answer' && live && editing === keyOf(entry)) {
      return `<div class="assumption-editor"><label for="assumption-disprove">What would show this is wrong?</label><textarea id="assumption-disprove" maxlength="1000" rows="3">${esc(entry.disproveIf ?? '')}</textarea>`
        + `<div class="glossary-actions"><button type="button" class="primary" data-assumption-save="${esc(keyOf(entry))}">Save</button><button type="button" class="text-button" data-assumption-cancel="">Cancel</button>`
        + `${entry.disproveIf ? `<button type="button" class="text-button" data-assumption-remove="${esc(keyOf(entry))}">Remove</button>` : ''}</div></div>`;
    }
    const edit = entry.kind === 'answer' && live ? ` <button type="button" class="text-button" data-assumption-edit="${esc(keyOf(entry))}">${entry.disproveIf ? 'Edit' : 'Add'}</button>` : '';
    return `<p class="assumption-change">Would change if: ${entry.disproveIf ? esc(entry.disproveIf) : 'Not stated'}${edit}</p>`;
  };
  const titles = new Map(map.nodes.map(node => [node.id, node.title]));
  const dependents = entry => (entry.dependents.length
    ? `<details class="assumption-dependents"><summary>${entry.dependents.length === 1 ? '1 idea rests' : `${entry.dependents.length} ideas rest`} on this</summary>${entry.dependents.map(id => `<button type="button" class="relationship" data-focus-node="${esc(id)}"><strong>${esc(titles.get(id))}</strong></button>`).join('')}</details>`
    : '<p class="form-note">No other ideas rest on this.</p>');
  const item = entry => `<article class="assumption-entry">${entry.kind === 'answer' ? `<p class="assumption-question">${esc(entry.question)}</p>` : ''}<p class="assumption-text">${esc(entry.text)}</p>${change(entry)}`
    + `${entry.stale ? '<p class="state-note warning">An earlier premise changed. Review this finding before relying on it.</p>' : ''}${dependents(entry)}`
    + `<button type="button" class="text-button" data-focus-node="${esc(entry.nodeId)}">Show “${esc(entry.title)}”</button></article>`;
  const yours = entries.filter(entry => entry.kind === 'answer'), agents = entries.filter(entry => entry.kind === 'interpretation');
  return `<h3 class="section-label">Your assumptions</h3>${yours.length ? yours.map(item).join('') : '<p class="form-note">No answers are marked Assumption. Mark one from the small label on a saved answer.</p>'}`
    + `<h3 class="section-label">Agent interpretations</h3>${agents.length ? agents.map(item).join('') : '<p class="form-note">None recorded. Your agent records its interpretations in results saved from now on.</p>'}`;
}
