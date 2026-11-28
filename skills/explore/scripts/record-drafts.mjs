// Drafts written from records the user chose (F4 implementation handoff, F5 decision record): 1–40 saved answers and
// explored ideas' findings, sent with their review state and staleness and shortened together to share the room. The
// result cites the records it used, and becomes one proposal with one editable item the user accepts or dismisses, once.
import { textField } from './fields.mjs';
import { includedKey, includedRecords } from './map-jobs.mjs';
import { certaintyText } from '../assets/questions.js';
import { answerChoices } from '../assets/workspace-view.js';

class DraftProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new DraftProblem(message, status); };
export const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
// A field that must be one line, such as a title.
export const oneLine = (value, field, max, fail, options) => { const text = textField(value, field, max, fail, options); if (text !== undefined && /[\r\n]/.test(text)) fail(`${field} must be one line.`); return text; };

// 1–`max` of what the shared selector offers (answerChoices with findings): saved, current answers ({ nodeId,
// questionId }) and explored ideas' findings ({ nodeId }), each once.
export function chosenRecords(map, selection, { max = 40 } = {}) {
  need(Array.isArray(selection) && selection.length >= 1 && selection.length <= max, `Choose 1 to ${max} answers or findings.`);
  const offered = new Set(answerChoices(map, { findings: true }).flatMap(group => [...(group.findings ? [`${group.nodeId}/`] : []), ...group.answers.map(answer => `${group.nodeId}/${answer.questionId}`)]));
  const seen = new Set();
  return selection.map(item => {
    const key = `${item?.nodeId}/${item?.questionId ?? ''}`;
    need(offered.has(key), 'A chosen record is not a saved answer or an explored idea\'s findings on this map.');
    need(!seen.has(key), 'A record is chosen twice.'); seen.add(key);
    return { nodeId: item.nodeId, ...(item.questionId !== undefined ? { questionId: item.questionId } : {}) };
  });
}

// Each record with its idea, review state and staleness. When they would not fit with the type's own `fields` (its
// result format, instruction and hints), their text is shortened step by step, marked, with how to read it in full; a
// choice that cannot fit even then is refused with `tooBig`.
const steps = [{ findings: 2400, summary: 700, answer: 1200 }, { findings: 1200, summary: 400, answer: 600 }, { findings: 500, summary: 200, answer: 300 }, { findings: 200, summary: 120, answer: 150 }];
const retrieval = 'Use CLI read --map MAP --node NODE --section findings, or --section questions --question ID, to read anything shortened here.';
export function recordsPacket({ map, selection, budget, fields, tooBig }) {
  const build = caps => selection.map(({ nodeId, questionId }) => {
    const node = map.nodes.find(n => n.id === nodeId), question = questionId ? node.questions.find(q => q.id === questionId) : null;
    const texts = question ? { answer: question.answer } : { summary: node.summary, findings: node.body === node.prompt ? '' : node.body };
    const cut = Object.entries(texts).some(([key, text]) => String(text ?? '').length > caps[key]), clipped = Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, clip(text, caps[key])]));
    return { nodeId, idea: clip(node.title, 100), reviewState: node.reviewState, stale: !!node.stale, ...(question ? { questionId, question: clip(question.text, 400), certainty: certaintyText(question) } : {}), ...clipped, ...(cut ? { shortened: true } : {}) };
  });
  let packet;
  for (const caps of steps) {
    const records = build(caps);
    packet = { records, ...(records.some(record => record.shortened) ? { retrieval } : {}), ...fields };
    if (JSON.stringify(packet).length <= budget - 800) break; // Room for the shared identifying fields the Store adds.
  }
  need(JSON.stringify(packet).length <= budget - 800, tooBig);
  packet[includedKey] = includedRecords(map, packet.records);
  return packet;
}

// The records a draft cites: at least one, each a record it was given, once; questionId only for an answer.
export function citedRecords(refs, job, fail) {
  const read = new Set((job.included ?? []).map(record => `${record.nodeId}/${record.questionId ?? ''}`)), seen = new Set();
  if (!Array.isArray(refs) || !refs.length) fail('Cite at least one record you relied on in refs.');
  return refs.map((ref, index) => {
    const key = `${ref?.nodeId}/${ref?.questionId ?? ''}`;
    if (!read.has(key)) fail(`Ref ${index + 1} names a record that was not read for this draft.`);
    if (seen.has(key)) fail(`Ref ${index + 1} repeats a record.`);
    seen.add(key);
    return { nodeId: ref.nodeId, ...(ref.questionId ? { questionId: ref.questionId } : {}) };
  });
}

// F1's review-proposal for one editable item: Accept or Dismiss, once, so an accepted draft is never reviewed again.
// Accepting saves the user's text, `name`, at most `max` characters (and UTF-8 bytes, with `bytes`); an item that keeps
// the agent's `original` also records whether the user changed it.
export function editableReview({ name, max, bytes = false }) {
  return {
    reviewRefusal: 'Choose Accept or Dismiss.', finalReview: true,
    review: ({ item, input }) => {
      if (input.decision !== 'accepted') return;
      const text = input.text === undefined ? item.text : textField(input.text, name, max, message => need(false, message));
      if (bytes) need(Buffer.byteLength(text, 'utf8') <= max, `${name} must be at most ${Math.round(max / 1024)} KiB.`);
      item.text = text;
      if (item.original !== undefined) item.editedByUser = text !== item.original;
    },
  };
}
