import { isOpen, answerStates } from './questions.js';
import { branchComplete } from './graph.js';
import { downloadName } from './workspace-view.js';

// Answer questions in a Markdown file (K11): export a map's open questions, answer them in any editor, and import the
// answers. Only text between an answer block's markers is read, matched by question ID; everything else in the file
// is ignored, so editing it changes nothing. Shared by the browser, the CLI and the tests. Import never guesses: a
// file it cannot read exactly is rejected with a line number, and nothing is saved.
export const answerMax = 12000; // As the answer action allows.
const marker = { header: /^<!--\s*explore-answers\s+v1\s+map=(\S+)\s+revision=(\d+)\s*-->$/, question: /^<!--\s*question\s+(\S+)\s*-->$/, answer: /^<!--\s*answer\s*-->$/, end: /^<!--\s*end answer\s*-->$/ };
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// The open questions a file lists: every open one (saved for later too) on a branch that is not finished, by idea.
export function openQuestionsForFile(map) {
  return map.nodes.filter(node => !branchComplete(node)).map(node => ({ node, questions: (node.questions ?? []).filter(isOpen) })).filter(group => group.questions.length);
}
export const answerFilename = map => downloadName(map.title, '-questions.md');

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
  constructor(line, message) { super(`Line ${line}: ${message}`); this.line = line; this.status = 400; }
}

// { mapId, revision, answers: [{ questionId, answer, answerState?, line }] }, where `line` is the answer marker's line.
// An empty block, or one holding only a state line, is skipped. Throws AnswerFileError for a file for another map, a
// question twice, or a marker out of place.
export function parseAnswerFile(text, { mapId }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n'), answers = [], seen = new Map();
  const fail = (line, message) => { throw new AnswerFileError(line, message); };
  let header = null, question = null, block = null;
  const finish = ({ id, line, body }) => {
    let rest = body, answerState;
    const first = rest.findIndex(item => item.trim());
    const state = first >= 0 ? rest[first].trim().match(/^state:\s*(\S+)$/i) : null;
    if (state) {
      answerState = state[1].toLowerCase();
      if (!answerStates.includes(answerState)) fail(line + 1 + first, 'state must be decided, tentative or assumption.');
      rest = rest.slice(first + 1);
    }
    const answer = rest.join('\n').trim();
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
      const [, id, revision] = line.match(marker.header);
      if (id !== mapId) fail(n, `This file is for map ${id}, not ${mapId}.`);
      header = { revision: Number(revision) };
    } else if (which === 'question') {
      if (!header) fail(1, 'This is not an Explore answers file: its explore-answers header is missing.');
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
  return { mapId, revision: header.revision, answers };
}

// What each answer would do on the map as it is now: ready, or why it would not be saved. `nodeId`, `question` and
// `title` come from the map, so a question's text edited in the file never matters.
export const previewWords = { ready: 'Ready to save', answered: 'Already answered: the saved answer is kept', superseded: 'From an earlier premise: not saved', completed: 'The branch is finished: not saved',
  unknown: 'Unknown question', 'too-long': `Too long: at most ${answerMax.toLocaleString('en')} characters`, dismissed: 'Dismissed: not saved' };
export function answerPreview(map, answers) {
  const where = new Map(map.nodes.flatMap(node => (node.questions ?? []).map(question => [question.id, { node, question }])));
  return answers.map(item => {
    const found = where.get(item.questionId);
    const status = !found ? 'unknown' : found.question.supersededAt ? 'superseded' : found.question.answer ? 'answered' : found.question.dismissedAt ? 'dismissed'
      : branchComplete(found.node) ? 'completed' : item.answer.length > answerMax ? 'too-long' : 'ready';
    return { ...item, status, nodeId: found?.node.id ?? null, question: found?.question.text ?? null, title: found?.node.title ?? null };
  });
}

// The preview, or after saving, the outcome: `failed` maps a question ID to why it was not saved.
export function answerPreviewHtml(items, { esc, saved = null, failed = {} }) {
  const outcome = item => (saved ? (saved.includes(item.questionId) ? 'Saved' : failed[item.questionId] ?? previewWords[item.status]) : previewWords[item.status]);
  return `<ul class="answer-preview">${items.map(item => `<li class="${item.status === 'ready' && !failed[item.questionId] ? 'ready' : 'skipped'}">`
    + `<p class="answer-preview-question">${item.question ? `${esc(item.title)} · ${esc(item.question)}` : `Unknown question ${esc(item.questionId)}`}</p>`
    + `<p class="answer-preview-text">${esc(item.answer)}</p><p class="answer-preview-status">${esc(outcome(item))}${item.answerState ? ` · ${esc(item.answerState)}` : ''}</p></li>`).join('')}</ul>`;
}
