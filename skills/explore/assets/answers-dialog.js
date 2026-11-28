import { answerFileMarkdown, parseAnswerFile, answerPreview, applyAnswers } from './answer-file.js';
import { answerStateLabels, answerMax } from './questions.js';
import { downloadName } from './workspace-view.js';

// Answer in a file (K11), from Map tools. Export open questions downloads the file; Import answers reads one, shows
// what each answer would do, and Save these answers saves the ready ones one at a time (applyAnswers), so each branch
// continues exactly as if answered here. A failure never undoes earlier saves; the list says what happened.
export const answerFilename = map => downloadName(map.title, '-questions.md');
export const previewWords = { ready: 'Ready to save', answered: 'Already answered: the saved answer is kept', superseded: 'From an earlier premise: not saved', completed: 'The branch is finished: not saved',
  unknown: 'Unknown question', 'too-long': `Too long: at most ${answerMax.toLocaleString('en')} characters`, dismissed: 'Dismissed: not saved' };
const shown = 2000; // A preview shows the start of a long answer; the whole answer is saved.

// The preview, or after saving, the outcome: `failed` maps a question ID to why it was not saved.
export function answerPreviewHtml(items, { esc, saved = null, failed = new Map() }) {
  const outcome = item => (saved ? (saved.includes(item.questionId) ? 'Saved' : failed.get(item.questionId) ?? previewWords[item.status]) : previewWords[item.status]);
  const state = item => (item.status === 'ready' ? ` · ${item.answerState ? answerStateLabels[item.answerState] : 'Tentative (no state given)'}` : '');
  return `<ul class="answer-preview">${items.map(item => `<li class="${item.status === 'ready' && !failed.has(item.questionId) ? 'ready' : 'skipped'}">`
    + `<p class="answer-preview-question">Line ${item.line} · ${item.question ? `${esc(item.title)} · ${esc(item.question)}` : `Unknown question ${esc(item.questionId)}`}</p>`
    + `<p class="answer-preview-text">${esc(item.answer.length > shown ? `${item.answer.slice(0, shown)}…` : item.answer)}</p><p class="answer-preview-status">${esc(outcome(item))}${state(item)}</p></li>`).join('')}</ul>`;
}

// `act(nodeId, type, input, { onError })` is the app's action call; `map()` is the live map; `live()` false (growth
// history or a saved version) refuses an import, which always changes the live map.
export function answersDialog({ map, live, act, esc, download }) {
  const $ = selector => document.querySelector(selector), dialog = $('#answers-dialog'), body = $('#answers-body'), summary = $('#answers-summary'), save = $('#answers-save'), picker = $('#answers-file'), status = $('#answers-status');
  const count = n => `${n} ${n === 1 ? 'answer' : 'answers'}`;
  let preview = [];
  $('#tools-dialog').addEventListener('close', () => { status.textContent = ''; });
  $('#answers-export').addEventListener('click', () => {
    const current = map(); if (!current) return;
    download(answerFileMarkdown(current), 'text/markdown', answerFilename(current)); status.textContent = '';
  });
  $('#answers-import').addEventListener('click', () => {
    if (!live()) { status.textContent = 'Return to the live map to import answers.'; return; }
    status.textContent = ''; picker.value = ''; picker.click(); // A cleared picker reads the same file again.
  });
  picker.addEventListener('change', async () => {
    const file = picker.files[0], current = map(); if (!file || !current) return;
    try { preview = answerPreview(current, parseAnswerFile(await file.text(), { mapId: current.id }).answers); }
    catch (error) { status.textContent = `${error.message} Nothing was saved.`; return; }
    const ready = preview.filter(item => item.status === 'ready').length;
    summary.textContent = !preview.length ? 'The file has no answers to import.'
      : `${count(ready)} ready to save.${ready < preview.length ? ` ${preview.length - ready} will not be saved.` : ''}${ready ? ' Nothing is saved until you choose Save these answers.' : ''}`;
    body.innerHTML = preview.length ? answerPreviewHtml(preview, { esc }) : '';
    save.hidden = !ready; save.disabled = false;
    $('#tools-dialog').close(); if (!dialog.open) dialog.showModal();
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    const send = (item, fail) => act(item.nodeId, 'answer', { questionId: item.questionId, answer: item.answer, ...(item.answerState ? { answerState: item.answerState } : {}) }, { onError: fail });
    const { saved, failed } = await applyAnswers(preview, { send, refresh: () => map(), onProgress: (done, total) => { if (done < total) summary.textContent = `Saving ${done + 1} of ${total}…`; } });
    const missed = preview.length - saved.length;
    summary.textContent = `Saved ${count(saved.length)}.${missed ? ` ${missed} ${missed === 1 ? 'was' : 'were'} not saved.` : ''}`;
    body.innerHTML = answerPreviewHtml(preview, { esc, saved, failed: new Map(failed.map(item => [item.questionId, item.error])) });
    save.hidden = true; summary.focus(); // Save hides itself; focus stays in the dialog.
  });
}
