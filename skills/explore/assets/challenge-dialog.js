import { challengeDialogHtml, directionFrom, offeredAnswers, CHALLENGE } from './challenge.js';
import { controlKey, cssQuote as quote } from './dialog-focus.js';

// The Challenge decisions dialog (F2), opened from Map tools: choose saved answers, preview exactly what the agent reads
// (F1's job preview), queue the challenge, and keep or dismiss each hypothesis. A kept one can be explored as a
// direction: that opens Add a direction prefilled on an idea it cites, and only submitting that form adds anything.
// `act`, `api` and `select(nodeId)` come from the app; `exploreAsDirection({ nodeId, title, body })` opens the form.
export function challengeDialog({ map, act, api, esc, toast, live, listening, select, exploreAsDirection }) {
  const $ = selector => document.querySelector(selector), dialog = $('#challenge-dialog'), body = $('#challenge-body');
  let chosen = [], preview = null, written = null;
  const same = (a, b) => a.nodeId === b.nodeId && a.questionId === b.questionId;
  const render = () => {
    const shown = map(); if (!shown) return;
    // A choice keeps only answers still offered, and a preview describes the map it was made for.
    const offered = offeredAnswers(shown), kept = chosen.filter(record => offered.some(answer => same(answer, record)));
    if (kept.length !== chosen.length) { chosen = kept; preview = null; }
    if (preview && preview.mapRevision !== shown.revision) preview = null;
    const html = challengeDialogHtml({ map: shown, esc, listening: listening(), live: live(), chosen, preview });
    if (html === written) return; // Never compare with innerHTML read back.
    const active = document.activeElement, key = active && body.contains?.(active) ? controlKey(active) : null;
    body.innerHTML = written = html;
    if (key) focus(key, '[data-challenge-stop]', '[data-challenge-preview]');
  };
  // Focus stays in the dialog: on the first of `selectors` found and enabled, else its heading.
  const focus = (...selectors) => { (selectors.map(selector => body.querySelector(selector)).find(target => target && !target.disabled) ?? $('#challenge-title'))?.focus(); };
  const run = async (type, input, done, ...focusOn) => { const ok = await act(null, type, input); if (ok && done) toast(done); render(); focus(...focusOn); return ok; };
  $('#challenge-open').addEventListener('click', () => { chosen = []; preview = null; written = null; render(); $('#tools-dialog').close(); dialog.showModal(); focus('[data-review-item]', '[data-challenge-node]'); });
  body.addEventListener('change', event => {
    const box = event.target.closest?.('[data-challenge-node]'); if (!box) return;
    const record = { nodeId: box.dataset.challengeNode, questionId: box.dataset.challengeQuestion };
    chosen = chosen.filter(entry => !same(entry, record));
    if (box.checked) chosen.push(record);
    if (preview) { preview = null; render(); return; } // A changed choice needs a new preview; focus stays on the box.
    const ask = body.querySelector('[data-challenge-preview]'); if (ask) ask.disabled = !chosen.length;
  });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target) return;
    const data = target.dataset;
    if (data.select) { dialog.close(); select(data.select); return; }
    if (data.challengePreview !== undefined) {
      const asked = JSON.stringify(chosen);
      target.disabled = true;
      try {
        const answer = await api(`/maps/${map().id}/job-preview?type=${CHALLENGE}&selection=${encodeURIComponent(asked)}`);
        if (JSON.stringify(chosen) === asked) preview = answer; // Never a preview of a choice the user has since changed.
      } catch (error) { toast(error.message); }
      target.disabled = false; render(); focus('[data-challenge-send]', '[data-challenge-preview]'); return;
    }
    if (data.challengeCancel !== undefined) { preview = null; render(); focus('[data-challenge-node]'); return; }
    if (data.challengeSend !== undefined) {
      if (await act(null, 'request-map-job', { jobType: CHALLENGE, selection: chosen })) { chosen = []; preview = null; toast(listening() ? 'Your agent will challenge these answers next.' : 'Queued. Connect your agent to challenge these answers.'); }
      render(); focus('#challenge-status', '[data-challenge-preview]'); return;
    }
    if (data.challengeStop) { await run('cancel-job', { jobId: data.challengeStop }, 'Stopped.', '[data-challenge-node]'); return; }
    if (data.reviewItem) {
      await run('review-proposal', { proposalId: data.proposal, itemId: data.reviewItem, decision: data.decision }, data.decision === 'accepted' ? 'Kept.' : 'Dismissed.',
        `[data-challenge-direction="${quote(data.reviewItem)}"]`, '[data-review-item]', '[data-challenge-node]');
      return;
    }
    if (data.challengeDirection) {
      const shown = map(), item = (shown.proposals ?? []).find(proposal => proposal.id === data.proposal)?.items.find(entry => entry.id === data.challengeDirection);
      const direction = item && directionFrom(shown, item); if (!direction) return;
      dialog.close(); exploreAsDirection(direction);
    }
  });
  return { mapChanged() { if (dialog.open) render(); } };
}
