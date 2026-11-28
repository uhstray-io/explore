import { isOpen, answerStates, answerRefusal } from './questions.js';
import { branchComplete } from './graph.js';

// Answer questions in a Markdown file (K11): export a map's open questions, answer them in any editor, and import the
// answers. Only text between an answer block's markers is read, matched by question ID; everything else in the file
// is ignored, so editing it changes nothing. Shared by the browser, the CLI and the tests, and free of view code: the
// dialog's markup is in answers-dialog.js. Import never guesses: a file it cannot read exactly is rejected with a line
// number, and nothing is saved.
const marker = { header: /^<!--\s*explore-answers\s+v1\s+map=(\S+)\s+revision=(\d+)\s*-->$/, question: /^<!--\s*question\s+(\S+)\s*-->$/, answer: /^<!--\s*answer\s*-->$/, end: /^<!--\s*end answer\s*-->$/ };
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// The open questions a file lists: every open one (saved for later too) on a branch that is not finished, by idea.
export function openQuestionsForFile(map) {
  return map.nodes.filter(node => !branchComplete(node)).map(node => ({ node, questions: (node.questions ?? []).filter(isOpen) })).filter(group => group.questions.length);
}

export function answerFileMarkdown(map) {
  const groups = openQuestionsForFile(map);
  const lines = [`# Open questions: ${oneLine(map.title)}`, `<!-- explore-answers v1 map=${map.id} revision=${map.revision} -->`,
    'Write each answer between its answer markers. Leave a block empty to skip it. Text outside the markers is ignored. To say how sure you are, start an answer with a line "state: decided", "state: tentative" or "state: assumption"; without one, an answer is Tentative.'];
  if (!groups.length) lines.push('', 'There are no open questions on this map.');
  for (const { node, questions } of groups) {
    lines.push('', `## ${oneLine(node.title)}`);
    for (const question of questions) lines.push('', `### ${oneLine(question.text)}`, `<!-- question ${question.id} -->`, '<!-- answer -->', '', '<!-- end answer -->');
  }
  return `${lines.join('\n')}\n`;
}

export class AnswerFileError extends Error {
  constructor(line, message) { super(`Line ${line}: ${message}`); this.line = line; }
}

// The text of an answer block: blank lines around it dropped, and the indentation its lines share removed.
function blockText(lines) {
  const first = lines.findIndex(line => line.trim()), last = lines.findLastIndex(line => line.trim());
  if (first < 0) return '';
  const kept = lines.slice(first, last + 1), indent = Math.min(...kept.filter(line => line.trim()).map(line => line.match(/^[ \t]*/)[0].length));
  return kept.map(line => line.slice(Math.min(indent, line.match(/^[ \t]*/)[0].length)).trimEnd()).join('\n');
}

// { mapId, answers: [{ questionId, answer, answerState?, line }] }, where `line` is the answer marker's line. A first
// line "state: decided|tentative|assumption" says how sure the answer is; any other "state:" line is answer text. An
// empty block, or one holding only a state line, is skipped. Throws AnswerFileError for a file for another map, a
// question twice, or a marker out of place.
export function parseAnswerFile(text, { mapId }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n'), answers = [], seen = new Map(); // A BOM is trimmed with the first line.
  const fail = (line, message) => { throw new AnswerFileError(line, message); };
  let header = null, question = null, block = null;
  const finish = ({ id, line, body }) => {
    const first = body.findIndex(item => item.trim());
    const state = first >= 0 ? body[first].trim().match(/^state:\s*(\S+)$/i) : null;
    const answerState = state && answerStates.includes(state[1].toLowerCase()) ? state[1].toLowerCase() : null;
    const answer = blockText(answerState ? body.slice(first + 1) : body);
    if (answer) answers.push({ questionId: id, answer, ...(answerState ? { answerState } : {}), line });
  };
  lines.forEach((raw, index) => {
    const n = index + 1, line = raw.trim(), which = Object.keys(marker).find(key => marker[key].test(line));
    if (block) {
      if (which === 'end') { finish(block); block = null; question = null; }
      else if (which) fail(n, `The answer to ${block.id} (line ${block.line}) needs <!-- end answer --> before this marker.`);
      else block.body.push(raw);
      return;
    }
    if (which === 'header') {
      if (header) fail(n, 'The file has a second explore-answers header.');
      const id = line.match(marker.header)[1];
      if (id !== mapId) fail(n, `This file is for map ${id}, not ${mapId}.`);
      header = true;
    } else if (which === 'question') {
      if (!header) {
        const later = lines.findIndex((other, at) => at > index && marker.header.test(other.trim()));
        if (later >= 0) fail(later + 1, 'The explore-answers header must come before the questions.');
        fail(1, 'This is not an Explore answers file: its explore-answers header is missing.');
      }
      if (question) fail(question.line, `Question ${question.id} (line ${question.line}) has no answer block.`);
      const id = line.match(marker.question)[1];
      if (seen.has(id)) fail(n, `Question ${id} appears twice (first on line ${seen.get(id)}).`);
      seen.set(id, n); question = { id, line: n };
    } else if (which === 'answer') {
      if (!question) fail(n, 'An answer marker must follow a question marker.');
      block = { id: question.id, line: n, body: [] };
    } else if (which === 'end') fail(n, 'This end marker has no answer marker before it.');
  });
  if (block) fail(block.line, `The answer to ${block.id} (line ${block.line}) has no <!-- end answer -->.`);
  if (question) fail(question.line, `Question ${question.id} (line ${question.line}) has no answer block.`);
  if (!header) fail(1, 'This is not an Explore answers file: its explore-answers header is missing.');
  return { mapId, answers };
}

// What each answer would do on the map as it is now: 'ready', or why the answer action would refuse it
// (answerRefusal, the rule the Store's answer action uses). `nodeId`, `question` and `title` come from the map, so a
// question's text edited in the file never matters; `deferred` marks a question saved for later.
export function answerPreview(map, answers) {
  const where = new Map(map.nodes.flatMap(node => (node.questions ?? []).map(question => [question.id, { node, question }])));
  return answers.map(item => {
    const found = where.get(item.questionId);
    const refusal = answerRefusal({ completed: found ? branchComplete(found.node) : false, question: found?.question ?? null, answer: item.answer });
    return { ...item, status: refusal?.status ?? 'ready', ...(refusal ? { reason: refusal.message } : {}), nodeId: found?.node.id ?? null, question: found?.question.text ?? null, title: found?.node.title ?? null, deferred: !!found?.question.deferredAt };
  });
}

// Saves the ready answers, one answer action at a time, so each branch continues as if answered in the browser. In two
// passes: first every answer that does not finish its idea (saved-for-later ones, then all but the last one the
// branch waits on), then each idea's last waiting answer. Answering the last question a branch waits on queues it,
// and an agent listening may claim it at once; answers to an idea linked to a claimed one can still make that run
// stale, as answering them in the browser would. `send(item)` resolves true when saved, or false with `error(message)`
// called; then `refresh()` re-reads the map, the answer is checked again and, if still ready, sent once more (the map
// may have moved on, for instance when an agent claimed a branch). A failed refresh stops, and what is left is
// reported as not attempted. Never undoes a save. Resolves { saved, failed: [{ questionId, error }], notAttempted }.
export async function applyAnswers(items, { send, refresh, onProgress = () => {} }) {
  const ready = items.filter(item => item.status === 'ready'), order = [...new Set(ready.map(item => item.nodeId))];
  const waiting = nodeId => ready.filter(item => item.nodeId === nodeId && !item.deferred);
  const queue = [...order.flatMap(nodeId => [...ready.filter(item => item.nodeId === nodeId && item.deferred), ...waiting(nodeId).slice(0, -1)]),
    ...order.map(nodeId => waiting(nodeId).at(-1)).filter(Boolean)];
  const saved = [], failed = [];
  for (const [index, item] of queue.entries()) {
    onProgress(index, queue.length);
    let reason = 'Not saved.';
    const attempt = () => send(item, message => { reason = message; });
    if (await attempt()) { saved.push(item.questionId); continue; }
    let current;
    try { current = await refresh(); } catch (error) { failed.push({ questionId: item.questionId, error: reason }); return { saved, failed, notAttempted: queue.slice(index + 1).map(left => left.questionId), stopped: error.message }; }
    const again = current ? answerPreview(current, [item])[0] : null;
    if (again?.status === 'ready' && await attempt()) saved.push(item.questionId);
    else failed.push({ questionId: item.questionId, error: again?.reason ?? reason });
  }
  onProgress(queue.length, queue.length);
  return { saved, failed, notAttempted: [] };
}

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
