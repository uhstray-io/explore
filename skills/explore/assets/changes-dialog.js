// "Changes since…" (E4): what changed in the open map since a Git commit, as Markdown the user can edit, copy or
// download. Edits stay in this browser; if the map changes while the dialog is open, the text is marked out of date.
export function changesDialog({ api, map }) {
  const $ = selector => document.querySelector(selector), dialog = $('#changes-dialog'), text = $('#changes-text'), status = $('#changes-status');
  let generatedAt = null;
  async function generate() {
    const open = map(); if (!open) return;
    status.textContent = 'Comparing…';
    try {
      const result = await api(`/maps/${open.id}/changes?${new URLSearchParams({ since: $('#changes-since').value.trim() || 'HEAD' })}`);
      text.value = result.markdown; generatedAt = open.revision; status.textContent = 'Edit it here, then copy or download it. Nothing is saved to the map.';
    } catch (error) { status.textContent = error.message; }
  }
  $('#changes-generate').addEventListener('click', generate);
  $('#changes-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(text.value); status.textContent = 'Copied.'; } catch { text.select(); status.textContent = 'Copy the selected text.'; } });
  $('#changes-download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text.value], { type: 'text/markdown' })); link.download = `${map()?.id ?? 'map'}-changes.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  return {
    show() { status.textContent = ''; dialog.showModal(); if (!text.value) generate(); },
    // The map moved on: say so, and leave the user's edits alone.
    mapChanged(revision) { if (dialog.open && generatedAt !== null && revision !== generatedAt) status.textContent = 'The map has changed since this was made. Generate again for the latest, which replaces your edits.'; },
  };
}
