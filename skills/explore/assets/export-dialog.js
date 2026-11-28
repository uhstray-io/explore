import { exportAs } from './export-formats.js';
import { downloadName } from './workspace-view.js';
import { viewerPicker } from './viewer-picker.js';

// Export in Map tools (I2, I3, I4): the complete map as JSON to import again, a diagram or printable page of the whole
// map or the selected idea's branch, or a read-only viewer of chosen ideas. Diagrams are made here from the live map,
// never from a growth-history step; the viewer is made by the server from the saved map, after a preview.
// `positions()` is the live map's layout when the page has it, or null to lay the map out here.
export function exportPanel({ api, map, selected, positions, download }) {
  const $ = selector => document.querySelector(selector), format = $('#export-format'), branch = $('#export-branch'), status = $('#export-status'), save = $('#export-download');
  const chosenIdea = () => map()?.nodes.find(node => node.id === selected()) ?? null;
  const picker = viewerPicker({ api, map, onChange: () => { save.disabled = !mode().ready(); } });
  // Each format: whether it can hold one branch, whether it chooses its own ideas, when Download is ready, and how
  // it saves. JSON is always the complete map; the viewer has its own picker and needs a current preview.
  const modes = {
    json: { branch: false, picker: false, ready: () => true, async save(open) {
      download(JSON.stringify(await api(`/maps/${open.id}/export`), null, 2) + '\n', 'application/json', downloadName(open.title, '-map.json'));
      status.textContent = 'Map exported as JSON.';
    } },
    viewer: { branch: false, picker: true, ready: () => picker.ready(), save: () => picker.download(download) },
    diagram: { branch: true, picker: false, ready: () => true, save(open) {
      if (branch.checked && !chosenIdea()) throw new Error('That idea is no longer in this map. Choose the whole map, or select another idea.');
      const file = exportAs(open, format.value, { nodeId: branch.checked ? selected() : null, positions: positions() });
      download(file.text, file.type, file.filename);
      status.textContent = format.value === 'print' ? `Downloaded ${file.filename}. Open it, then choose Print and Save as PDF.` : `Downloaded ${file.filename}.`;
    } },
  };
  const mode = () => modes[format.value] ?? modes.diagram;
  function render() {
    const current = mode(), idea = chosenIdea(), possible = !!idea && current.branch;
    $('.export-scope').hidden = current.picker; picker.show(current.picker);
    branch.disabled = !possible; if (!possible) $('#export-whole').checked = true;
    $('#export-branch-label').textContent = idea ? `“${idea.title}” and everything below it` : 'One branch: select an idea first';
    save.disabled = !current.ready(); status.textContent = '';
  }
  format.addEventListener('change', render);
  save.addEventListener('click', async () => {
    const open = map(); if (!open) return;
    try { await mode().save(open); } catch (error) { status.textContent = error.message; }
  });
  return { render, mapChanged() { picker.mapChanged(); save.disabled = !mode().ready(); } };
}
