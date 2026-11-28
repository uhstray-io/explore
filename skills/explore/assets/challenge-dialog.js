import { challengeDialogHtml, challengesOf, directionFrom, CHALLENGE } from './challenge.js';

// The Challenge decisions dialog (F2), opened from Map tools: choose saved answers, preview exactly what the agent reads
// (F1's job preview), queue the challenge, and keep or dismiss each hypothesis. A kept one can be explored as a
// direction: that opens Add a direction prefilled on the idea it cites, and only submitting that form adds anything.
// `act`, `api` and `select(nodeId)` come from the app; `exploreAsDirection({ nodeId, title, body })` prefills the form.
export function challengeDialog({ map, act, api, esc, toast, live, listening, select, exploreAsDirection }) {
  const $ = selector => document.querySelector(selector), dialog = $('#challenge-dialog'), body = $('#challenge-body');
  let chosen = [], preview = null, written = null;
  const render = () => {
    const shown = map(); if (!shown) return;
    if (preview && preview.mapRevision !== shown.revision) preview = null; // A preview describes the map it was made for.
    const html = challengeDialogHtml({ map: shown, esc, listening: listening(), live: live(), chosen, preview });
    if (html !== written) {
      const active = document.activeElement, kept = active && body.contains?.(active) ? keyOf(active) : null;
      body.innerHTML = written = html; // Never compare with innerHTML read back.
      if (kept) focus(kept, '[data-challenge-stop]', '[data-challenge-preview]');
    }
  };
  // A control as a selector, to find it again after a redraw: its id, or its first data attribute.
  const keyOf = element => (element.id ? `#${element.id}` : Object.entries(element.dataset ?? {}).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${value}"]`)[0] ?? null);
  // Focus stays in the dialog: on the first of `selectors` found and enabled, else its heading.
  const focus = (...selectors) => { (selectors.map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? $('#challenge-title'))?.focus(); };
  const run = async (type, input, done, ...focusOn) => { const ok = await act(null, type, input); if (ok && done) toast(done); render(); focus(...focusOn); return ok; };
  $('#challenge-open').addEventListener('click', () => { chosen = []; preview = null; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); focus('[data-challenge-review]', '[data-challenge-node]'); });
  body.addEventListener('change', event => {
    const box = event.target.closest?.('[data-challenge-node]'); if (!box) return;
    const record = { nodeId: box.dataset.challengeNode, questionId: box.dataset.challengeQuestion };
    chosen = chosen.filter(entry => entry.nodeId !== record.nodeId || entry.questionId !== record.questionId);
    if (box.checked) chosen.push(record);
    if (preview) { preview = null; render(); focus(`[data-challenge-question="${record.questionId}"]`); return; } // A changed choice needs a new preview.
    const ask = body.querySelector('[data-challenge-preview]'); if (ask) ask.disabled = !chosen.length;
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.select) { dialog.close(); select(data.select); return; }
    if (data.challengePreview !== undefined) {
      target.disabled = true;
      try { preview = await api(`/maps/${map().id}/job-preview?type=${CHALLENGE}&selection=${encodeURIComponent(JSON.stringify(chosen))}`); } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus('[data-challenge-send]', '[data-challenge-preview]'); return;
    }
    if (data.challengeCancel !== undefined) { preview = null; render(); focus('[data-challenge-node]'); return; }
    if (data.challengeSend !== undefined) {
      if (await act(null, 'request-map-job', { jobType: CHALLENGE, selection: chosen })) { chosen = []; preview = null; toast(listening() ? 'Your agent will challenge these answers next.' : 'Queued. Connect your agent to challenge these answers.'); }
      render(); focus('#challenge-status', '[data-challenge-preview]'); return;
    }
    if (data.challengeStop) { await run('cancel-job', { jobId: data.challengeStop }, 'Stopped.', '[data-challenge-node]'); return; }
    if (data.challengeReview) { await run('review-proposal', { proposalId: data.proposal, itemId: data.challengeReview, decision: data.decision }, data.decision === 'accepted' ? 'Kept.' : 'Dismissed.', '[data-challenge-review]', `[data-challenge-direction="${data.challengeReview}"]`, '[data-challenge-node]'); return; }
    if (data.challengeDirection) {
      const item = challengesOf(map()).latest?.items.find(entry => entry.id === data.challengeDirection); if (!item) return;
      dialog.close(); exploreAsDirection(directionFrom(item));
    }
  });
  return { mapChanged() { if (dialog.open) render(); } };
}
