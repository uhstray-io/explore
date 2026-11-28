import { importConflictHtml } from './workspace-view.js';

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
