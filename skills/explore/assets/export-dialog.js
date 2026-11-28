import { exportAs } from './export-formats.js';
import { downloadName } from './workspace-view.js';

// Export in Map tools (I2, I3): the complete map as JSON to import again, or a diagram or printable page of the whole
// map or the selected idea's branch. Diagrams are made here from the live map, never from a growth-history step.
// `positions()` is the live map's layout when the page has it, or null to lay the map out here.
export function exportPanel({ api, map, selected, positions, download }) {
  const $ = selector => document.querySelector(selector), format = $('#export-format'), branch = $('#export-branch'), status = $('#export-status');
  const chosenIdea = () => map()?.nodes.find(node => node.id === selected()) ?? null;
  // A branch needs a selected idea and a diagram format: the JSON export is always the complete map.
  function render() {
    const idea = chosenIdea(), possible = !!idea && format.value !== 'json';
    branch.disabled = !possible; if (!possible) $('#export-whole').checked = true;
    $('#export-branch-label').textContent = idea ? `“${idea.title}” and everything below it` : 'One branch: select an idea first';
    status.textContent = '';
  }
  format.addEventListener('change', render);
  $('#export-download').addEventListener('click', async () => {
    const open = map(); if (!open) return;
    try {
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
  return { render };
}
