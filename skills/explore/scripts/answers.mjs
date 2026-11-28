// Answer questions in a Markdown file (K11), over the bridge API: the CLI's `answers import --apply`.
import { applyAnswers } from '../assets/answer-file.js';

// The CLI's way to apply answers over the bridge API: each answer is an action on the map as last read, and `refresh`
// re-reads it. `api(route, body?)` is the CLI's request. Resolves what --apply reports.
export async function applyOverApi(preview, { api, mapId, map }) {
  let current = map;
  const send = async (item, fail) => {
    const input = { type: 'answer', nodeId: item.nodeId, questionId: item.questionId, answer: item.answer, ...(item.answerState ? { answerState: item.answerState } : {}) };
    try { current = await api(`/api/maps/${mapId}/action`, { ...input, expectedRevision: current.revision }); return true; } catch (error) { fail(error.message); return false; }
  };
  const { saved, failed, notAttempted, stopped } = await applyAnswers(preview, { send, refresh: async () => (current = await api(`/api/maps/${mapId}`)) });
  return { saved, failed, ...(notAttempted.length ? { notAttempted, stopped } : {}) };
}
