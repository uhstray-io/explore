import { togglePin, pinsOf, maxPins } from '../assets/pinned-answers.js';

// Pin or unpin a saved answer (Z11). The pins live in map.view, like positions: saving them records no event, so
// no version, and an outside change to them alone is not news. They never reach a brief or a work packet.
class PinProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new PinProblem(message, status); };

export const pinActions = {
  // User-only. `nodeId`, `questionId`, `pinned`. Unpinning works even when the idea is gone.
  'pin-answer': { target: 'map', apply: ({ map, input }) => {
    need(typeof input.nodeId === 'string' && typeof input.questionId === 'string', 'Name the answer to pin.');
    need(typeof input.pinned === 'boolean', 'Say whether to pin or unpin the answer.');
    const pins = pinsOf(map), ref = { nodeId: input.nodeId, questionId: input.questionId };
    const pinnedNow = pins.some(pin => pin.nodeId === ref.nodeId && pin.questionId === ref.questionId);
    need(pinnedNow !== input.pinned, input.pinned ? 'This answer is already pinned.' : 'This answer is not pinned.', 409);
    if (input.pinned) need(map.nodes.find(node => node.id === ref.nodeId)?.questions.find(question => question.id === ref.questionId)?.answer, 'Only an answered question can be pinned.', 409);
    const next = togglePin(pins, ref);
    need(next, `At most ${maxPins} answers can be pinned. Unpin one to add another.`, 409);
    map.view = { ...map.view, pinnedAnswers: next };
  } },
};
