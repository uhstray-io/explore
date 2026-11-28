// "Changes since…" (E4): what changed in the open map since a Git commit, as Markdown the user can edit, copy or
// download. Edits stay in this browser; if the map changes while the dialog is open, the text is marked out of date.

// What opening the dialog again does with the text in it, made from `made` ({ mapId, revision } from the server):
// make it afresh for another map, or keep the user's edits and say whether the map has moved on since. Revisions
// only grow, so a view a poll behind the server is not a change.
export function textState(made, mapId, revision) {
  if (!made || made.mapId !== mapId) return 'make';
  return revision > made.revision ? 'out-of-date' : 'current';
}
const outOfDate = 'The map has changed since this was made. Generate again for the latest, which replaces your edits.';

export function changesDialog({ api, map, download }) {
  const $ = selector => document.querySelector(selector), dialog = $('#changes-dialog'), text = $('#changes-text'), status = $('#changes-status');
  let made = null, request = 0;
  async function generate() {
    const open = map(); if (!open) return;
    const mine = ++request; status.textContent = 'Comparing…';
    try {
      const result = await api(`/maps/${open.id}/changes?${new URLSearchParams({ since: $('#changes-since').value.trim() || 'HEAD' })}`);
      if (mine !== request) return; // A newer Generate replaced this one.
      text.value = result.markdown; made = { mapId: open.id, revision: result.after.revision };
      status.textContent = 'Edit it here, then copy or download it. Nothing is saved to the map.';
    } catch (error) { if (mine === request) status.textContent = error.message; }
  }
  $('#changes-generate').addEventListener('click', generate);
  $('#changes-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(text.value); status.textContent = 'Copied.'; } catch { text.select(); status.textContent = 'Copy the selected text.'; } });
  $('#changes-download').addEventListener('click', () => download(text.value, 'text/markdown;charset=utf-8', `${made?.mapId ?? 'map'}-changes.md`));
  return {
    show() {
      dialog.showModal();
      const open = map(), next = textState(made, open?.id, open?.revision);
      if (next === 'make') { text.value = ''; made = null; generate(); } else status.textContent = next === 'out-of-date' ? outOfDate : '';
    },
    // The map moved on: say so, and leave the user's edits alone.
    mapChanged(mapId, revision) { if (dialog.open && textState(made, mapId, revision) === 'out-of-date') status.textContent = outOfDate; },
  };
}
