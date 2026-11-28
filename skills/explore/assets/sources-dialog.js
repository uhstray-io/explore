import { sourceLibrary, sourcesHtml, matchingSources } from './sources.js';

// The source library dialog (K10), opened from Map tools. Choosing a citing idea closes it and focuses that idea.
// `map()` is the map shown, and `note()` the inspector's read-only note for growth history or a saved version ('' on
// the live map). `mapChanged()` redraws it when the map changes while it is open.
export function sourcesDialog({ esc, map, note, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#sources-dialog'), body = $('#sources-body'), filter = $('#sources-filter'), flagged = $('#sources-flagged');
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let entries = [], written = null;
  const draw = () => {
    const options = { esc, query: filter.value, flaggedOnly: flagged.checked, note: note() };
    const html = sourcesHtml(entries, options);
    if (html !== written) body.innerHTML = written = html; // Never compare with innerHTML read back.
    $('#sources-count').textContent = entries.length ? `${count(matchingSources(entries, options).length, 'source', 'sources')} shown` : '';
  };
  const load = () => {
    const shown = map(); if (!shown) return false;
    entries = sourceLibrary(shown);
    const flaggedCount = entries.filter(entry => entry.flags.length).length;
    $('#sources-summary').textContent = `${count(entries.length, 'source', 'sources')} cited ${note() ? 'on the ideas shown' : 'across the map'}${flaggedCount ? ` · ${flaggedCount} flagged` : ''}. Your agent's reading of its sources, not a verification.`;
    draw();
    return true;
  };
  $('#sources-open').addEventListener('click', () => {
    filter.value = ''; flagged.checked = false;
    if (!load()) return;
    $('#tools-dialog').close(); dialog.showModal(); filter.focus();
  });
  filter.addEventListener('input', draw);
  flagged.addEventListener('change', draw);
  body.addEventListener('click', event => {
    const idea = event.target.closest('[data-focus-node]'); if (!idea) return;
    dialog.close(); focusNode(idea.dataset.focusNode);
  });
  return { mapChanged() { if (dialog.open) load(); } };
}
