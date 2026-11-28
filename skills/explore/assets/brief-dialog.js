import { briefPreview, briefFilename } from './workspace-view.js';

// The map or branch brief: an extract of the saved map, never new research, to read, copy or download.
// Returns show(nodeId): null for the whole map, or an idea for its branch.
export function briefDialog({ api, map, download }) {
  const $ = selector => document.querySelector(selector);
  let brief = null, scope = null, version = 0;
  async function show(nodeId = null) {
    const open = map(); if (!open) return;
    const mine = ++version;
    brief = null; scope = nodeId;
    $('#brief-title').textContent = nodeId ? 'Branch brief' : 'Map brief';
    $('#brief-description').textContent = 'Extracted from your latest saved map. Includes recorded findings, decisions, open questions and next directions.';
    $('#brief-content').textContent = ''; $('#brief-status').textContent = 'Preparing your brief…';
    $('#copy-brief').disabled = true; $('#download-brief').disabled = true; $('#retry-brief').hidden = true; $('#brief-copy-fallback').hidden = true;
    if (!$('#brief-dialog').open) $('#brief-dialog').showModal();
    try {
      const result = await api(`/maps/${open.id}/brief${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`);
      if (mine !== version) return; // A newer request replaced this one.
      brief = result;
      $('#brief-description').textContent = `${brief.title}. Extracted from your latest saved ${nodeId ? 'branch and its descendants' : 'map'}.`;
      $('#brief-content').innerHTML = briefPreview(brief);
      $('#brief-status').textContent = `Saved revision ${brief.revision}. This brief summarizes recorded material; it does not run new research.`;
      $('#copy-brief').disabled = false; $('#download-brief').disabled = false;
    } catch (error) {
      if (mine !== version) return;
      $('#brief-status').textContent = `Could not prepare the brief. ${error.message}`; $('#retry-brief').hidden = false;
    }
  }
  $('#show-brief').addEventListener('click', () => show());
  $('#retry-brief').addEventListener('click', () => show(scope));
  $('#copy-brief').addEventListener('click', async () => {
    if (!brief) return;
    try { await navigator.clipboard.writeText(brief.markdown); $('#brief-status').textContent = 'Brief copied. Paste it into a document or your agent.'; }
    catch { const field = $('#brief-copy-fallback'); field.value = brief.markdown; field.hidden = false; field.focus(); field.select(); $('#brief-status').textContent = 'Copy the selected brief text below.'; }
  });
  $('#download-brief').addEventListener('click', () => {
    if (!brief) return;
    download(brief.markdown, 'text/markdown;charset=utf-8', briefFilename(brief.title)); $('#brief-status').textContent = 'Brief downloaded as Markdown.';
  });
  return show;
}
