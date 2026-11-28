import { certaintyText } from './questions.js';

// Pinned reference answers (Z11): up to three saved answers kept in view while working elsewhere on the map.
// Pins are shared map view state in view.pinnedAnswers: saving them records no version, a pin that arrives by pull
// is not reported as an outside change, and they never reach a brief or agent context.
export const maxPins = 3;
const isPin = pin => !!pin && typeof pin === 'object' && typeof pin.nodeId === 'string' && typeof pin.questionId === 'string';
// The saved pins that are well formed, in pin order.
export const pinsOf = map => (Array.isArray(map?.view?.pinnedAnswers) ? map.view.pinnedAnswers.filter(isPin) : []);
export const samePin = (a, b) => a.nodeId === b.nodeId && a.questionId === b.questionId;
export const isPinned = (pins, ref) => pins.some(pin => samePin(pin, ref));
export const canAddPin = pins => pins.length < maxPins;

// Each pin as a row: its idea's title, question and answer in `map`, or unavailable when that idea or answer is not
// there (a growth step or saved version from before it, or an idea removed since).
export function resolvePins(map, pins) {
  return pins.map(pin => {
    const node = map.nodes.find(entry => entry.id === pin.nodeId), question = node?.questions.find(entry => entry.id === pin.questionId);
    return question?.answer ? { ...pin, available: true, title: node.title, question: question.text, answer: question.answer, certainty: certaintyText(question), superseded: !!question.supersededAt } : { ...pin, available: false };
  });
}

const excerptLength = 300;
// The section above the open questions, for the map on screen (`map`, which may be history) and today's pins. The
// selected idea's own answers are already on screen, so they are left out. `open` is the default: open while the
// idea has an open question. The user's choice is kept per default, so questions arriving still open it. Only the
// live map can unpin.
export function pinnedAnswersHtml(map, pins, { esc, selectedId, open, live }) {
  const shown = resolvePins(map, pins).filter(row => row.nodeId !== selectedId);
  if (!shown.length) return '';
  const ref = row => `data-node-id="${esc(row.nodeId)}" data-question-id="${esc(row.questionId)}"`;
  const unpin = row => (live ? `<button type="button" class="text-button" data-pin-unpin="${esc(row.nodeId)}" ${ref(row)}>Unpin</button>` : '');
  const answer = row => (row.answer.length > excerptLength
    ? `<p class="pin-excerpt">${esc(row.answer.slice(0, excerptLength))}…</p><details data-editor="pin-full-${esc(row.nodeId)}-${esc(row.questionId)}"><summary>Show full answer</summary><p>${esc(row.answer)}</p></details>`
    : `<p>${esc(row.answer)}</p>`);
  const row = item => (item.available
    ? `<div class="pinned-answer"><small>${esc(item.title)}</small><strong>${esc(item.question)}</strong>${item.superseded ? '<em>Answer from an earlier premise.</em>' : ''}${answer(item)}`
      + `${item.certainty ? `<small class="certainty-label">${esc(item.certainty)}</small>` : ''}<div class="pinned-actions"><button type="button" class="text-button" data-pin-go="${esc(item.nodeId)}" ${ref(item)}>Go to idea</button>${unpin(item)}</div></div>`
    : `<div class="pinned-answer unavailable"><p>${live ? 'This answer is no longer on the map.' : 'Not in this view of the map.'}</p>${live ? `<div class="pinned-actions">${unpin(item)}</div>` : ''}</div>`);
  return `<details class="pinned-answers" data-editor="pins-${open ? 'open' : 'closed'}"${open ? ' open' : ''}><summary>Pinned answers (${shown.length})</summary>${shown.map(row).join('')}</details>`;
}

// The answered question's ⋯ menu item. With three pinned it stays in the menu and says why it cannot be used.
export function pinMenuItem({ nodeId, questionId, pins, esc }) {
  const attributes = `type="button" role="menuitem" tabindex="-1" data-node-id="${esc(nodeId)}" data-question-id="${esc(questionId)}"`;
  if (isPinned(pins, { nodeId, questionId })) return `<button ${attributes} data-pin-answer="unpin">Unpin answer</button>`;
  return canAddPin(pins) ? `<button ${attributes} data-pin-answer="pin">Pin answer</button>` : `<button ${attributes} data-pin-full aria-disabled="true">Pin answer · Unpin one to add another</button>`;
}
// Beside a pinned answer, so its state shows without opening the menu.
export const pinnedLabel = (pins, ref) => (isPinned(pins, ref) ? '<small class="pin-label">Pinned</small>' : '');

// Pin and Unpin (menu items or the section's Unpin) and Go to idea. Returns true when it handled the click.
export async function pinClick(event, { act, focusNode, toast, closeMenus }) {
  const go = event.target.closest('[data-pin-go]');
  if (go) { focusNode(go.dataset.pinGo); return true; }
  if (event.target.closest('[data-pin-full]')) return true; // It explains itself and does nothing.
  const button = event.target.closest('[data-pin-answer], [data-pin-unpin]');
  if (!button) return false;
  const pinned = button.dataset.pinAnswer === 'pin', { nodeId, questionId } = button.dataset;
  if (button.dataset.pinAnswer) closeMenus(true); // Focus goes back to the question's ⋯ button.
  button.disabled = true;
  if (await act(null, 'pin-answer', { nodeId, questionId, pinned })) toast(pinned ? 'Answer pinned.' : 'Answer unpinned.');
  button.disabled = false;
  return true;
}
