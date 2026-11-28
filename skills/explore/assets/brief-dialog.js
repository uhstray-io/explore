import { escapeHtml, downloadName } from './workspace-view.js';
import { presentation } from './graph.js';

export const briefFilename = title => downloadName(title, '-brief.md');

// The brief as the dialog shows it.
export function briefPreview(brief) {
  const counts = brief.counts;
  // Show questions and answers separately so long prompts cannot hide the answer.
  const itemsWithAnswers = brief.sections.map(section => ({ ...section, items: section.items.map(item => item.question ? { ...item, text: `Question: ${item.question}\nAnswer: ${item.text}` } : item) }));
  brief = { ...brief, sections: itemsWithAnswers };
  return `${brief.originalIdea ? `<h3>Original idea</h3><blockquote>${escapeHtml(brief.originalIdea)}</blockquote>` : ''}<h3>Progress</h3><p>${counts.nodes} ideas; ${counts.explored} explored; ${counts.accepted} accepted and current; ${counts.stale} need review; ${counts.awaitingAnswer} awaiting answers.</p><p class="brief-scope-note">A bounded summary of saved material. Sections may overlap; explored findings have not necessarily been verified.</p>${brief.sections.map(section => `<section class="brief-section"><h3>${escapeHtml(section.label)}</h3>${section.items.length ? section.items.map(item => `<article class="brief-item"><strong>${escapeHtml(item.title)}</strong><small class="brief-item-state">${escapeHtml(presentation(item).label)}</small><p>${escapeHtml(item.text)}</p><small class="brief-reference">${escapeHtml(item.nodeId)}${item.questionId ? ` · ${escapeHtml(item.questionId)}` : ''}</small></article>`).join('') : '<p class="brief-empty">None recorded in this scope.</p>'}${section.omitted ? `<p class="brief-omitted">${section.omitted} more ${section.omitted === 1 ? 'record' : 'records'} in this section. Open the map to inspect the rest.</p>` : ''}</section>`).join('')}`;
}

// The map or branch brief: an extract of the saved map, never new research, to read, copy or download.
// Returns show(nodeId): null for the whole map, or an idea for its branch. app.js wires the buttons that open it.
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
