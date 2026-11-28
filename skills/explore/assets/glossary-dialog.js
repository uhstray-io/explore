// The glossary dialog (K9), opened from Map tools: agreed terms with Edit and Remove, an Add form, and the agent's
// proposed terms with Accept, Edit and accept, and Dismiss. A proposal that would replace a term shows both.
import { agreedTerms, proposedTerms, replacedTerm } from './glossary.js';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// The line in Map tools.
export function glossarySummary(map) {
  const agreed = agreedTerms(map).length, proposed = proposedTerms(map).length;
  const parts = [agreed ? `${plural(agreed, 'agreed term')}` : 'No agreed terms yet', ...(proposed ? [`${plural(proposed, 'term')} proposed by your agent`] : [])];
  return `${parts.join(' · ')}. Every research job gets the agreed terms, so your agent keeps your words.`;
}

// The dialog body. `editing` is the id being edited: an agreed term, or a proposal being edited before accepting.
export function glossaryHtml(map, { esc, editing = null }) {
  const agreed = agreedTerms(map), proposed = proposedTerms(map);
  const field = (id, label, value, max, rows = 0) => `<label for="${id}">${label}</label>${rows ? `<textarea id="${id}" maxlength="${max}" rows="${rows}">${esc(value)}</textarea>` : `<input id="${id}" maxlength="${max}" value="${esc(value)}">`}`;
  const term = entry => editing === entry.id
    ? `<div class="glossary-entry editing">${field('glossary-edit-term', 'Term', entry.term, 80)}${field('glossary-edit-definition', 'Definition', entry.definition, 600, 3)}<div class="glossary-actions"><button type="button" class="primary" data-glossary-save="${esc(entry.id)}">Save</button><button type="button" class="text-button" data-glossary-cancel>Cancel</button></div></div>`
    : `<div class="glossary-entry"><dt>${esc(entry.term)}</dt><dd>${esc(entry.definition)}</dd><div class="glossary-actions"><button type="button" class="text-button" data-glossary-edit="${esc(entry.id)}">Edit</button><button type="button" class="text-button" data-glossary-remove="${esc(entry.id)}">Remove</button></div></div>`;
  const proposal = entry => {
    const current = replacedTerm(map, entry); // The term Accept would change.
    const meaning = editing === entry.id
      ? `${field('glossary-accept-definition', 'Definition to accept', entry.definition, 600, 3)}<div class="glossary-actions"><button type="button" class="primary" data-glossary-accept-edited="${esc(entry.id)}">Accept</button><button type="button" class="text-button" data-glossary-cancel>Cancel</button></div>`
      : `${current ? `<div class="glossary-compare"><p><small>Agreed now</small>${esc(current.definition)}</p><p><small>Proposed</small>${esc(entry.definition)}</p></div>` : `<dd>${esc(entry.definition)}</dd>`}`
        + `<div class="glossary-actions"><button type="button" class="secondary" data-glossary-accept="${esc(entry.id)}">Accept</button><button type="button" class="text-button" data-glossary-edit-accept="${esc(entry.id)}">Edit and accept</button><button type="button" class="text-button" data-glossary-dismiss="${esc(entry.id)}">Dismiss</button></div>`;
    return `<div class="glossary-entry proposed"><dt>${esc(entry.term)}${current ? ' <small>would replace the agreed definition</small>' : ''}</dt>${meaning}</div>`;
  };
  return `<h3 class="section-label">Agreed terms</h3>${agreed.length ? `<dl class="glossary-list">${agreed.map(term).join('')}</dl>` : '<p class="form-note">No terms yet. Add one below, or accept one your agent proposes.</p>'}`
    + (proposed.length ? `<h3 class="section-label">Proposed by your agent — not agreed</h3><dl class="glossary-list">${proposed.map(proposal).join('')}</dl>` : '');
}

// The dialog's behaviour. `act(nodeId, type, input)` is the app's action call (null for map-level actions).
export function glossaryDialog({ act, map, esc, toast }) {
  const $ = selector => document.querySelector(selector), dialog = $('#glossary-dialog'), body = $('#glossary-body'), form = $('#glossary-add-form');
  let editing = null;
  const render = () => { const open = map(); if (!open) return; body.innerHTML = glossaryHtml(open, { esc, editing }); $('#glossary-summary').textContent = glossarySummary(open); };
  const run = async (type, input, done) => { if (await act(null, type, input)) { editing = null; render(); toast(done); return true; } return false; };
  $('#glossary-open').addEventListener('click', () => { $('#tools-dialog').close(); editing = null; render(); dialog.showModal(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (await run('glossary-add', { term: $('#glossary-term').value, definition: $('#glossary-definition').value }, 'Term added.')) { form.reset(); $('#glossary-term').focus(); }
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.glossaryEdit || data.glossaryEditAccept) { editing = data.glossaryEdit || data.glossaryEditAccept; render(); body.querySelector('input, textarea')?.focus(); return; }
    if ('glossaryCancel' in data) { editing = null; render(); return; }
    if (data.glossarySave) return run('glossary-edit', { termId: data.glossarySave, term: $('#glossary-edit-term').value, definition: $('#glossary-edit-definition').value }, 'Term saved.');
    if (data.glossaryRemove) return run('glossary-remove', { termId: data.glossaryRemove }, 'Term removed.');
    if (data.glossaryAccept) return run('glossary-accept', { termId: data.glossaryAccept }, 'Term accepted.');
    if (data.glossaryAcceptEdited) return run('glossary-accept', { termId: data.glossaryAcceptEdited, definition: $('#glossary-accept-definition').value }, 'Term accepted.');
    if (data.glossaryDismiss) return run('glossary-dismiss', { termId: data.glossaryDismiss }, 'Proposal dismissed.');
  });
  return {
    // The map moved on: refresh the summary, and the open dialog unless the user is editing in it.
    mapChanged() { const open = map(); if (!open) return; if (dialog.open && !editing) render(); else $('#glossary-summary').textContent = glossarySummary(open); },
  };
}
