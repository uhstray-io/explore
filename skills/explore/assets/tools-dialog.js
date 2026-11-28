import { answerChooserHtml, checkAnswersHtml } from './workspace-view.js';

// Map tools' Check answers (F1): which answers to check, what will be read, progress, and the latest points to keep or
// dismiss. Nothing runs until the user clicks. `map()` is the live map; `onOpen()` draws the dialog's other sections.
export function toolsDialog({ map, act, api, esc, toast, listening, onOpen }) {
  const $ = selector => document.querySelector(selector), dialog = $('#tools-dialog');
  let open = false, preview = null, previewRevision = null;
  async function render() {
    const shown = map(); if (!open || !shown) return;
    const mapId = shown.id;
    if (previewRevision !== shown.revision) {
      previewRevision = shown.revision;
      try { const answer = await api(`/maps/${mapId}/job-preview?type=check-answers`); if (map()?.id === mapId) preview = answer; } catch { preview = null; }
    }
    if (map()?.id === mapId && open) $('#tools-body').innerHTML = checkAnswersHtml({ map: map(), preview, listening: listening(), esc });
  }
  $('#show-tools').addEventListener('click', () => {
    const shown = map(); if (!shown) return;
    $('#tools-choices').innerHTML = answerChooserHtml(shown, { esc, prefix: 'choice' }) || '<p class="form-note">No saved answers yet.</p>';
    $('#tools-choose').open = false;
    open = true; preview = null; previewRevision = null;
    dialog.showModal();
    onOpen(); render();
  });
  dialog.addEventListener('close', () => { open = false; });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if ('checkAnswers' in button.dataset) {
      const selection = [...document.querySelectorAll('#tools-choices input:checked')].map(box => ({ nodeId: box.dataset.choiceNode, questionId: box.dataset.choiceQuestion }));
      button.disabled = true;
      if (await act(null, 'request-map-job', { jobType: 'check-answers', ...(selection.length ? { selection } : {}) })) toast(listening() ? 'Check queued. Your agent will pick it up next.' : 'Check queued. Connect your agent to run it.');
      button.disabled = false; render();
    } else if (button.dataset.cancelJob) { if (await act(null, 'cancel-job', { jobId: button.dataset.cancelJob })) toast('Check stopped.'); render(); }
    else if (button.dataset.reviewItem) { if (await act(null, 'review-proposal', { proposalId: button.dataset.proposal, itemId: button.dataset.reviewItem, decision: button.dataset.decision })) render(); }
    else if (button.dataset.select) dialog.close(); // The page's own handler then focuses that idea.
  });
  return { mapChanged: render };
}
