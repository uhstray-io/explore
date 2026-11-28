import { plural } from './workspace-view.js';

// Import (I2): a map with this ID is already here and the file differs. Nothing has been changed yet.
export function importConflictHtml({ existing, incoming }, { esc }) {
  const when = at => Number.isNaN(Date.parse(at)) ? '' : ` · updated ${esc(new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}`;
  const side = (label, map) => `<div class="import-side"><h3 class="section-label">${label}</h3>${map.unreadable ? '<p class="form-note">A map folder with this ID is here but cannot be opened.</p>' : `<p><strong>${esc(map.title)}</strong></p><p class="form-note">${plural(map.ideas, 'idea')} · revision ${esc(map.revision)}${when(map.updatedAt)}</p>`}</div>`;
  return `<p>A map with the same ID is already in this workspace, and the file is different. Nothing has been changed.</p><div class="import-sides">${side('Already here', existing)}${side('In the file', incoming)}</div>`;
}

// Import a map (I2): an identical map opens the existing one; a different one with the same ID asks first, offering
// to keep the one here or import a copy.
export function importDialog({ api, esc, toast, refresh, openMap }) {
  const $ = selector => document.querySelector(selector);
  let pending = null;
  async function importFile(data, asCopy = false) {
    try {
      const result = await api('/import', { data, asCopy });
      if (result.conflict) { pending = { data, mapId: result.conflict.mapId }; $('#import-body').innerHTML = importConflictHtml(result.conflict, { esc }); $('#import-dialog').showModal(); return; }
      await refresh(); await openMap(result.imported ?? result.existing);
      toast(result.existing ? 'This map is already here, so it is open now.' : 'Map imported. Nothing in it runs until you choose to explore.');
    } catch (error) { toast(error.message); }
  }
  $('#import-map').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async () => {
    const file = $('#import-file').files[0]; $('#import-file').value = ''; if (!file) return;
    let data; try { data = JSON.parse(await file.text()); } catch { toast('This file is not valid JSON, so it cannot be imported.'); return; }
    await importFile(data);
  });
  $('#import-dialog').addEventListener('click', async event => {
    const button = event.target.closest('[data-import-keep], [data-import-copy]'), choice = pending; if (!button || !choice) return;
    $('#import-dialog').close(); pending = null;
    if ('importCopy' in button.dataset) await importFile(choice.data, true); else await openMap(choice.mapId);
  });
}
