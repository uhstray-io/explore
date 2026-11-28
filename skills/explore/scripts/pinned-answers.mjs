import { pinsOf, isPinned, canAddPin, maxPins } from '../assets/pinned-answers.js';

// Pin or unpin a saved answer (Z11). The pins live in map.view: saving them records no event, so no version, and
// they never reach a brief or a work packet.
class PinnedAnswerProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new PinnedAnswerProblem(message, status); };

export const pinnedAnswerActions = {
  // User-only. `nodeId`, `questionId`, `pinned`. Unpinning works even when the idea is gone.
  'pin-answer': { target: 'map', apply: ({ map, input }) => {
    need(typeof input.nodeId === 'string' && typeof input.questionId === 'string', 'Name the answer to pin.');
    need(typeof input.pinned === 'boolean', 'Say whether to pin or unpin the answer.');
    const pins = pinsOf(map), ref = { nodeId: input.nodeId, questionId: input.questionId };
    need(isPinned(pins, ref) !== input.pinned, input.pinned ? 'This answer is already pinned.' : 'This answer is not pinned.', 409);
    if (input.pinned) {
      need(map.nodes.find(node => node.id === ref.nodeId)?.questions.find(question => question.id === ref.questionId)?.answer, 'Only an answered question can be pinned.', 409);
      need(canAddPin(pins), `At most ${maxPins} answers can be pinned. Unpin one to add another.`, 409);
    }
    map.view = { ...map.view, pinnedAnswers: input.pinned ? [...pins, ref] : pins.filter(pin => !isPinned([pin], ref)) };
  } },
};
