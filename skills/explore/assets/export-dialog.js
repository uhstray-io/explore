import { exportAs } from './export-formats.js';
import { downloadName } from './workspace-view.js';
import { viewerPicker } from './viewer-picker.js';

// Export in Map tools (I2, I3, I4): the complete map as JSON to import again, a diagram or printable page of the whole
// map or the selected idea's branch, or a read-only viewer of chosen ideas. Diagrams are made here from the live map,
// never from a growth-history step; the viewer is made by the server from the saved map, after a preview.
// `positions()` is the live map's layout when the page has it, or null to lay the map out here.
export function exportPanel({ api, map, selected, positions, download }) {
  const $ = selector => document.querySelector(selector), format = $('#export-format'), branch = $('#export-branch'), status = $('#export-status');
  const chosenIdea = () => map()?.nodes.find(node => node.id === selected()) ?? null;
  const viewer = () => format.value === 'viewer', save = $('#export-download');
  const picker = viewerPicker({ api, map, onChange: () => { save.disabled = viewer() && !picker.ready(); } });
  // A branch needs a selected idea and a diagram format: the JSON export is always the complete map.
  function render() {
    $('.export-scope').hidden = viewer(); picker.show(viewer()); save.disabled = viewer() && !picker.ready();
    const idea = chosenIdea(), possible = !!idea && !['json', 'viewer'].includes(format.value);
    branch.disabled = !possible; if (!possible) $('#export-whole').checked = true;
    $('#export-branch-label').textContent = idea ? `“${idea.title}” and everything below it` : 'One branch: select an idea first';
    status.textContent = '';
  }
  format.addEventListener('change', render);
  $('#export-download').addEventListener('click', async () => {
    const open = map(); if (!open) return;
    try {
      if (viewer()) { picker.download(download); return; }
      if (format.value === 'json') {
        download(JSON.stringify(await api(`/maps/${open.id}/export`), null, 2) + '\n', 'application/json', downloadName(open.title, '-map.json'));
        status.textContent = 'Map exported as JSON.'; return;
      }
      if (branch.checked && !chosenIdea()) throw new Error('That idea is no longer in this map. Choose the whole map, or select another idea.');
      const file = exportAs(open, format.value, { nodeId: branch.checked ? selected() : null, positions: positions() });
      download(file.text, file.type, file.filename);
      status.textContent = format.value === 'print' ? `Downloaded ${file.filename}. Open it, then choose Print and Save as PDF.` : `Downloaded ${file.filename}.`;
    } catch (error) { status.textContent = error.message; }
  });
  return { render, mapChanged() { picker.mapChanged(); } };
}
