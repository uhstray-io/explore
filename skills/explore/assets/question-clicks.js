import { appendSuggestion, researchSuggestion } from './workspace-view.js';

// Clicks on a question's controls: starting a draft from a suggestion or research, stopping the agent's work on it,
// one question at a time or all, changing or restarting from an answer, and the question's ⋯ menu. Resolves true
// when the click was one of these. `app` passes what the handlers need from app.js.
export async function questionClick(event, app) {
  const { state, act, toast, renderDetail, closeMenus, agentListening, loadRestartPreview } = app;
  const suggested = event.target.closest('[data-suggest-answer]');
  if (suggested) {
    const option = state.map?.nodes.find(node => node.id === state.selected)?.options?.find(item => item.id === suggested.dataset.suggestAnswer);
    const field = document.querySelector(`[data-draft="${suggested.dataset.questionId}"]`);
    if (option?.suggestedAnswer && field) { field.value = appendSuggestion(field.value, option.suggestedAnswer); state.drafts[suggested.dataset.questionId] = field.value; field.focus(); }
    return true;
  }
  const copied = event.target.closest('[data-copy-answer]');
  if (copied) {
    const { questionId, researchJob, copyAnswer } = copied.dataset, suggestion = researchSuggestion(state.visibleMap?.jobs, researchJob, copyAnswer);
    const editor = document.querySelector(`[data-change-for="${questionId}"]`), field = document.querySelector(`[data-draft="${questionId}"]`) || editor?.querySelector('textarea');
    if (!suggestion || !field) return true;
    if (editor) editor.hidden = false;
    field.value = appendSuggestion(field.value, suggestion); state.drafts[field.dataset.draft] = field.value; field.focus();
    return true;
  }
  const stopJob = event.target.closest('[data-stop-job]');
  if (stopJob) { if (await act(null, 'cancel-job', { jobId: stopJob.dataset.stopJob })) toast('Stopped.'); return true; }
  if (event.target.closest('[data-show-all-questions]')) { state.showAllQuestions = true; renderDetail(true); return true; }
  if (event.target.closest('[data-show-one-question]')) { state.showAllQuestions = false; renderDetail(true); document.querySelector('#detail form.question-box textarea')?.focus(); return true; }
  const changeOpen = event.target.closest('[data-q-change]');
  if (changeOpen) { closeMenus(); const editor = document.querySelector(`[data-change-for="${changeOpen.dataset.questionId}"]`); if (editor) { editor.hidden = false; editor.querySelector('textarea').focus(); } return true; }
  const changeSave = event.target.closest('[data-save-change], [data-save-wording]');
  if (changeSave) {
    const questionId = changeSave.dataset.questionId, field = document.querySelector(`#change-${questionId}`), answer = field?.value.trim();
    if (!answer) { field?.focus(); return true; }
    changeSave.disabled = true;
    const fork = changeSave.dataset.saveChange === 'fork';
    const done = fork ? await act(changeSave.dataset.nodeId, 'fork-revision', { questionId, answer, start: true })
      : await act(changeSave.dataset.nodeId, 'change-answer', { questionId, answer, ...('saveWording' in changeSave.dataset ? { rerun: false } : {}) });
    if (done) { delete state.drafts[`change-${questionId}`]; toast(fork ? (agentListening() ? 'A new branch is exploring your changed answer.' : 'A new branch is queued for your changed answer. Connect your agent to explore it.') : 'saveWording' in changeSave.dataset ? 'Wording saved.' : 'Answer changed. Findings that relied on it are flagged for review.'); }
    changeSave.disabled = false; return true;
  }
  // Restart from this answer: preview first; nothing is deleted until the user confirms.
  const restartOpen = event.target.closest('[data-restart-preview]');
  if (restartOpen) {
    const { questionId, nodeId } = restartOpen.dataset, field = document.querySelector(`#change-${questionId}`), answer = field?.value.trim();
    const saved = state.map?.nodes.find(node => node.id === nodeId)?.questions.find(q => q.id === questionId)?.answer;
    if (!answer || answer === saved) { toast('Change the answer first, then restart from it.'); field?.focus(); return true; }
    restartOpen.disabled = true; await loadRestartPreview({ nodeId, questionId }); restartOpen.disabled = false; return true;
  }
  const restartMore = event.target.closest('[data-restart-more]');
  if (restartMore && state.restartPreview) { await loadRestartPreview(state.restartPreview, Number(restartMore.dataset.restartMore)); return true; }
  if (event.target.closest('[data-restart-cancel]')) {
    const questionId = state.restartPreview?.questionId; state.restartPreview = null; renderDetail(true);
    const editor = document.querySelector(`[data-change-for="${questionId}"]`); if (editor) { editor.hidden = false; editor.querySelector('textarea').focus(); }
    return true;
  }
  const restartConfirm = event.target.closest('[data-restart-confirm]');
  if (restartConfirm && state.restartPreview) {
    const { nodeId, questionId, preview } = state.restartPreview, answer = document.querySelector(`#change-${questionId}`)?.value.trim();
    if (!answer) { document.querySelector(`#change-${questionId}`)?.focus(); return true; }
    restartConfirm.disabled = true;
    if (await act(nodeId, 'restart-branch', { questionId, answer, previewHash: preview.hash })) {
      state.restartPreview = null; delete state.drafts[`change-${questionId}`]; renderDetail(true);
      toast(`Branch restarted. Its checkpoint is saved in Versions. ${agentListening() ? 'Your agent will explore it next.' : 'Connect your agent to explore it.'}`);
    } else if (state.restartPreview) await loadRestartPreview(state.restartPreview); // Show what would happen now.
    return true;
  }
  const rate = event.target.closest('[data-q-rate]');
  if (rate) { closeMenus(); if (await act(rate.dataset.nodeId, 'rate-question', { questionId: rate.dataset.questionId, rating: rate.dataset.qRate || null })) toast(rate.dataset.qRate ? 'Thanks. Your agent will ask more like this.' : 'Rating removed.'); return true; }
  const reason = event.target.closest('[data-q-reason]');
  if (reason) { closeMenus(); const row = document.querySelector(`[data-reason-for="${reason.dataset.questionId}"]`); if (row) { row.hidden = false; row.dataset.action = reason.dataset.qReason; row.querySelector('button').textContent = reason.dataset.qReason === 'regenerate' ? 'Get a new question' : 'Send'; row.querySelector('input').focus(); } return true; }
  const send = event.target.closest('[data-send-reason]');
  if (send) {
    const row = send.closest('[data-reason-for]'), text = row.querySelector('input').value.trim(), questionId = send.dataset.sendReason;
    send.disabled = true;
    const done = row.dataset.action === 'regenerate'
      ? await act(send.dataset.nodeId, 'regenerate-question', { questionId, ...(text ? { reason: text } : {}) })
      : await act(send.dataset.nodeId, 'rate-question', { questionId, rating: 'bad', ...(text ? { reason: text } : {}) });
    if (done) toast(row.dataset.action === 'regenerate' ? (agentListening() ? 'Your agent will write a better question.' : 'Queued. Connect your agent for a new question.') : 'Thanks. Your agent will ask fewer questions like this.');
    send.disabled = false; return true;
  }
  const help = event.target.closest('[data-q-help]');
  if (help) { closeMenus(); if (await act(help.dataset.nodeId, 'request-help', { questionId: help.dataset.questionId })) toast(agentListening() ? 'Your agent will explain this question next.' : 'Queued. Connect your agent to get the explanation.'); return true; }
  const research = event.target.closest('[data-q-research]');
  if (research) { closeMenus(); if (await act(research.dataset.nodeId, 'request-research', { questionId: research.dataset.questionId })) toast(agentListening() ? 'Your agent will research this question next.' : 'Queued. Connect your agent to get the research.'); return true; }
  const dismiss = event.target.closest('[data-q-dismiss]');
  if (dismiss) { closeMenus(); if (await act(dismiss.dataset.nodeId, 'dismiss-question', { questionId: dismiss.dataset.questionId })) toast(state.map?.nodes.find(node => node.id === dismiss.dataset.nodeId)?.questions.some(isBlocking) ? 'Dismissed.' : 'Dismissed. The branch continues without it.'); return true; }
  const restore = event.target.closest('[data-q-restore]');
  if (restore) { if (await act(restore.dataset.nodeId, 'restore-question', { questionId: restore.dataset.questionId })) toast('The question is back.'); return true; }
  const later = event.target.closest('[data-answer-later]');
  if (later) { closeMenus(); later.disabled = true; if (await act(later.dataset.nodeId, 'answer-later', { questionId: later.dataset.answerLater })) toast(state.map?.nodes.find(node => node.id === later.dataset.nodeId)?.questions.some(isBlocking) ? 'Saved for later.' : 'Saved for later. The branch continues without it.'); later.disabled = false; return true; }
  const tidy = event.target.closest('[data-q-tidy]');
  if (tidy) {
    closeMenus(); const text = state.drafts[tidy.dataset.questionId]?.trim();
    if (!text) { toast('Write your answer first, then tidy its wording.'); return true; }
    if (await act(tidy.dataset.nodeId, 'clean-answer', { questionId: tidy.dataset.questionId, text })) toast(agentListening() ? 'Your agent will tidy your wording next.' : 'Queued. Connect your agent to tidy your wording.');
    return true;
  }
  // Use this wording replaces only the draft and keeps the user's own to restore; nothing is saved as an answer.
  const use = event.target.closest('[data-tidy-use]'), keep = event.target.closest('[data-tidy-keep]');
  if (use || keep) {
    const button = use || keep, questionId = button.dataset.questionId, job = state.visibleMap?.jobs.find(j => j.id === (use ? use.dataset.tidyUse : keep.dataset.tidyKeep));
    if (use && job?.result?.text) { state.tidyRestore = { ...state.tidyRestore, [questionId]: state.drafts[questionId] ?? '' }; state.drafts[questionId] = job.result.text; }
    button.disabled = true;
    await act(null, 'resolve-clean', { jobId: job?.id, outcome: use ? 'applied' : 'rejected' });
    document.querySelector(`[data-draft="${questionId}"]`)?.focus();
    return true;
  }
  const restoreWording = event.target.closest('[data-tidy-restore]');
  if (restoreWording) {
    const questionId = restoreWording.dataset.tidyRestore;
    state.drafts[questionId] = state.tidyRestore[questionId]; delete state.tidyRestore[questionId];
    renderDetail(true); document.querySelector(`[data-draft="${questionId}"]`)?.focus();
    return true;
  }
  return false;
}
