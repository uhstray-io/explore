import { answerFileMarkdown, answerFilename, parseAnswerFile, answerPreview, answerPreviewHtml } from './answer-file.js';

// Answer in a file (K11), from Map tools. Export open questions downloads the file; Import answers reads one, shows
// what each answer would do, and Save these answers sends each ready one as its own answer action, in order, so each
// branch continues exactly as if answered here. A failure never undoes earlier saves; the list says what happened.
// `act(nodeId, type, input, { onError })` is the app's action call; `map()` is the live map; `live()` false (growth
// history or a saved version) refuses an import, which always changes the live map.
export function answersDialog({ map, live = () => true, act, esc, toast, download }) {
  const $ = selector => document.querySelector(selector), dialog = $('#answers-dialog'), body = $('#answers-body'), summary = $('#answers-summary'), save = $('#answers-save'), picker = $('#answers-file');
  const count = n => `${n} ${n === 1 ? 'answer' : 'answers'}`;
  let preview = [];
  $('#answers-export').addEventListener('click', () => {
    const current = map(); if (!current) return;
    download(answerFileMarkdown(current), 'text/markdown', answerFilename(current));
  });
  $('#answers-import').addEventListener('click', () => {
    if (!live()) { toast('Return to the live map to import answers.'); return; }
    picker.value = ''; picker.click();
  });
  picker.addEventListener('change', async () => {
    const file = picker.files[0], current = map(); if (!file || !current) return;
    try { preview = answerPreview(current, parseAnswerFile(await file.text(), { mapId: current.id }).answers); }
    catch (error) { toast(error.message); return; }
    const ready = preview.filter(item => item.status === 'ready').length;
    summary.textContent = preview.length ? `${count(ready)} ready to save.${ready < preview.length ? ` ${preview.length - ready} will not be saved.` : ''} Nothing is saved until you choose Save these answers.` : 'The file has no answers to import.';
    body.innerHTML = preview.length ? answerPreviewHtml(preview, { esc }) : '';
    save.hidden = !ready; save.disabled = false;
    $('#tools-dialog').close(); if (!dialog.open) dialog.showModal();
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    const saved = [], failed = {};
    for (const item of preview.filter(entry => entry.status === 'ready')) {
      let reason = 'Not saved.';
      const input = { questionId: item.questionId, answer: item.answer, ...(item.answerState ? { answerState: item.answerState } : {}) };
      if (await act(item.nodeId, 'answer', input, { onError: message => { reason = message; } })) saved.push(item.questionId); else failed[item.questionId] = reason;
    }
    const missed = preview.length - saved.length;
    summary.textContent = `Saved ${count(saved.length)}.${missed ? ` ${missed} ${missed === 1 ? 'was' : 'were'} not saved.` : ''}`;
    body.innerHTML = answerPreviewHtml(preview, { esc, saved, failed });
    save.hidden = true;
  });
}
