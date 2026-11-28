import { isAssumption, disproveIfMax } from './questions.js';
import { changeLinks, changeWalk, treeOrder } from './graph.js';
import { impactOf } from './impact.js';

// The assumptions register (K6): everything the exploration rests on without proof, in one list. The user's own
// answers marked Assumption, and the agent's stated interpretations, each with what would change it and how many ideas
// a change to its idea would reach (the walk impact and the Store's review flags share). Pure and read-only; the dialog
// is assumptions-dialog.js.
const isText = value => typeof value === 'string' && value.trim() !== '';

// An idea's interpretations as readable records: anything else in a pulled or hand-edited map is skipped here (the
// validator reports it), so the register, node Markdown and packets never break on it.
export function interpretationsOf(node) {
  return Array.isArray(node?.assumptions) ? node.assumptions.filter(item => item && typeof item === 'object' && isText(item.statement)).map(item => ({ statement: item.statement, wouldChangeIf: isText(item.wouldChangeIf) ? item.wouldChangeIf : null })) : [];
}

// [{ kind: 'answer' | 'interpretation', nodeId, title, questionId?, question?, text, wouldChangeIf, stale, dependents }]:
// most dependents first, then in reading order. `wouldChangeIf` is the user's note on an answer, or the agent's own,
// or null when not stated; `dependents` counts the ideas a change to its idea would reach (impactOf lists them, when
// asked). An interpretation on a cleared finding is not relied on, so it is left out.
export function assumptionRegister(map) {
  const links = changeLinks(map), known = new Set(map.nodes.map(node => node.id)), order = new Map(treeOrder(map).map(({ node }, at) => [node.id, at])), entries = [];
  const reach = nodeId => { let count = 0; for (const [id] of changeWalk(map, [nodeId], { links })) if (known.has(id)) count++; return count; };
  for (const node of map.nodes) {
    const base = { nodeId: node.id, title: node.title, stale: !!node.stale };
    const answers = (node.questions ?? []).filter(isAssumption), readings = node.reviewState === 'cleared' ? [] : interpretationsOf(node);
    if (!answers.length && !readings.length) continue;
    const dependents = reach(node.id);
    for (const q of answers) entries.push({ kind: 'answer', ...base, questionId: q.id, question: q.text, text: q.answer, wouldChangeIf: isText(q.disproveIf) ? q.disproveIf : null, dependents });
    for (const item of readings) entries.push({ kind: 'interpretation', ...base, text: item.statement, wouldChangeIf: item.wouldChangeIf, dependents });
  }
  return entries.sort((a, b) => b.dependents - a.dependents || order.get(a.nodeId) - order.get(b.nodeId));
}

// The ideas resting on one entry's idea, nearest first: listed only when the user opens the list.
export const dependentsHtml = (map, nodeId, { esc }) => {
  const titles = new Map(map.nodes.map(node => [node.id, node.title]));
  return impactOf(map, nodeId).affected.map(id => `<button type="button" class="relationship" data-focus-node="${esc(id)}"><strong>${esc(titles.get(id))}</strong></button>`).join('');
};

// The dialog body: "Your assumptions", then "Agent interpretations". `editing` is the "nodeId questionId" key of the
// note being edited; `live` false (growth history or a saved version) offers no edits and, as impact is live-only
// (D4), no counts of what rests on an entry.
export function assumptionsHtml(entries, { esc, live, editing }) {
  const keyOf = entry => `${entry.nodeId} ${entry.questionId}`;
  const change = entry => {
    if (entry.kind === 'answer' && live && editing === keyOf(entry)) {
      return `<div class="assumption-editor"><label for="assumption-disprove">What would show this is wrong?</label><textarea id="assumption-disprove" maxlength="${disproveIfMax}" rows="3">${esc(entry.wouldChangeIf ?? '')}</textarea>`
        + `<div class="glossary-actions"><button type="button" class="primary" data-assumption-save="${esc(keyOf(entry))}">Save</button><button type="button" class="text-button" data-assumption-cancel="${esc(keyOf(entry))}">Cancel</button>`
        + `${entry.wouldChangeIf ? `<button type="button" class="text-button" data-assumption-remove="${esc(keyOf(entry))}">Remove</button>` : ''}</div></div>`;
    }
    const verb = entry.wouldChangeIf ? 'Edit' : 'Add';
    const edit = entry.kind === 'answer' && live ? ` <button type="button" class="text-button" data-assumption-edit="${esc(keyOf(entry))}" aria-label="${verb} what would change your answer to: ${esc(entry.question)}">${verb}</button>` : '';
    return `<p class="assumption-change">Would change if: ${entry.wouldChangeIf ? esc(entry.wouldChangeIf) : 'Not stated'}${edit}</p>`;
  };
  const dependents = entry => (!live ? '' : entry.dependents
    ? `<details class="assumption-dependents" data-dependents="${esc(entry.nodeId)}"><summary>${entry.dependents === 1 ? '1 idea rests' : `${entry.dependents} ideas rest`} on this</summary><div class="assumption-dependent-list"></div></details>`
    : '<p class="form-note">No other ideas rest on this.</p>');
  const item = entry => `<article class="assumption-entry">${entry.kind === 'answer' ? `<p class="assumption-question">${esc(entry.question)}</p>` : ''}<p class="assumption-text">${esc(entry.text)}</p>${change(entry)}`
    + `${entry.stale ? '<p class="state-note warning">Needs review: an earlier premise changed.</p>' : ''}${dependents(entry)}`
    + `<button type="button" class="text-button" data-focus-node="${esc(entry.nodeId)}">Show “${esc(entry.title)}”</button></article>`;
  const yours = entries.filter(entry => entry.kind === 'answer'), agents = entries.filter(entry => entry.kind === 'interpretation');
  return `<h3 class="section-label">Your assumptions</h3>${yours.length ? yours.map(item).join('') : '<p class="form-note">No answers are marked Assumption. Mark one from the small label on a saved answer.</p>'}`
    + `<h3 class="section-label">Agent interpretations</h3>${agents.length ? agents.map(item).join('') : '<p class="form-note">None recorded. Your agent records its interpretations in results saved from now on.</p>'}`;
}
