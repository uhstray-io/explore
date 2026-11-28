import { certaintyText } from './questions.js';

// Pinned reference answers (Z11): up to three saved answers kept in view while working elsewhere on the map.
// Pins are shared map view state, like positions: never a version, an outside change, a brief or agent context.
export const maxPins = 3;
const same = (a, b) => a.nodeId === b.nodeId && a.questionId === b.questionId;
const isPin = pin => !!pin && typeof pin === 'object' && typeof pin.nodeId === 'string' && typeof pin.questionId === 'string';
// The saved pins that are well formed, in pin order.
export const pinsOf = map => (Array.isArray(map?.view?.pinnedAnswers) ? map.view.pinnedAnswers.filter(isPin) : []);

// The pins after toggling `ref`: removed when pinned, otherwise added last; null when it would be one too many.
export function togglePin(pins, ref, max = maxPins) {
  const list = pins.filter(isPin);
  if (list.some(pin => same(pin, ref))) return list.filter(pin => !same(pin, ref));
  if (list.length >= max) return null;
  return [...list, { nodeId: ref.nodeId, questionId: ref.questionId }];
}

// Each pin as a row: its idea's title, question and answer in `map`, or unavailable when that idea or answer is not
// there (a growth step from before it, or an idea removed since).
export function resolvePins(map, pins) {
  return pins.map(pin => {
    const node = map.nodes.find(entry => entry.id === pin.nodeId), question = node?.questions.find(entry => entry.id === pin.questionId);
    return question?.answer ? { ...pin, available: true, title: node.title, question: question.text, answer: question.answer, certainty: certaintyText(question), superseded: !!question.supersededAt } : { ...pin, available: false };
  });
}

const excerptLength = 300;
// The section above the open questions. The selected idea's own answers are already on screen, so they are left out.
export function pinnedAnswersHtml(rows, { esc, selectedId, open, historic = false }) {
  const shown = rows.filter(row => row.nodeId !== selectedId);
  if (!shown.length) return '';
  const unpin = row => `<button type="button" class="text-button" data-pin-unpin="${esc(row.nodeId)}" data-question-id="${esc(row.questionId)}">Unpin</button>`;
  const row = item => item.available
    ? `<div class="pinned-answer"><small>${esc(item.title)}</small><strong>${esc(item.question)}</strong>${item.superseded ? '<em>Answer from an earlier premise.</em>' : ''}`
      + (item.answer.length > excerptLength ? `<p>${esc(item.answer.slice(0, excerptLength))}…</p><details><summary>Show full answer</summary><p>${esc(item.answer)}</p></details>` : `<p>${esc(item.answer)}</p>`)
      + `${item.certainty ? `<small class="certainty-label">${esc(item.certainty)}</small>` : ''}<div class="pinned-actions"><button type="button" class="text-button" data-pin-go="${esc(item.nodeId)}">Go to idea</button>${unpin(item)}</div></div>`
    : `<div class="pinned-answer unavailable"><p>${historic ? 'Not present at this growth step.' : 'This answer is no longer on the map.'}</p><div class="pinned-actions">${unpin(item)}</div></div>`;
  return `<details class="pinned-answers" data-editor="pins"${open ? ' open' : ''}><summary>Pinned answers (${shown.length})</summary>${shown.map(row).join('')}</details>`;
}

// The Pin toggle on an answered question. With three pinned, another cannot be added, and the reason is shown.
export function pinToggleHtml({ nodeId, questionId, pins, esc }) {
  const pinned = pins.some(pin => same(pin, { nodeId, questionId })), full = !pinned && pins.length >= maxPins;
  return `<span class="pin-answer"><button type="button" class="text-button" data-pin-answer="${esc(nodeId)}" data-question-id="${esc(questionId)}" aria-pressed="${pinned}"${full ? ' disabled' : ''}>${pinned ? 'Pinned' : 'Pin answer'}</button>${full ? '<small class="pin-note">Unpin one to add another.</small>' : ''}</span>`;
}

// Pin, Unpin and Go to idea in the inspector. Returns true when it handled the click.
export async function pinClick(event, { act, focusNode, toast }) {
  const go = event.target.closest('[data-pin-go]');
  if (go) { focusNode(go.dataset.pinGo); return true; }
  const button = event.target.closest('[data-pin-answer], [data-pin-unpin]');
  if (!button) return false;
  const pinned = button.dataset.pinAnswer ? button.getAttribute('aria-pressed') !== 'true' : false;
  button.disabled = true;
  if (await act(null, 'pin-answer', { nodeId: button.dataset.pinAnswer || button.dataset.pinUnpin, questionId: button.dataset.questionId, pinned })) toast(pinned ? 'Answer pinned.' : 'Answer unpinned.');
  button.disabled = false;
  return true;
}
