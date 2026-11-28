import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { answerFileMarkdown, answerFilename, parseAnswerFile, answerPreview, answerPreviewHtml, openQuestionsForFile } from '../skills/explore/assets/answer-file.js';
import { answersDialog } from '../skills/explore/assets/answers-dialog.js';

// Answer questions in a Markdown file (K11, #57). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const exec = promisify(execFile);
const idea = (id, extra = {}) => ({ id, parentId: id === 'root' ? null : 'root', title: `Idea ${id}`, summary: 'S', status: 'awaiting-answer', reviewState: 'unreviewed', questions: [], sources: [], ...extra });
const q = (id, extra = {}) => ({ id, text: `Question ${id}?`, answer: null, ...extra });
const fixture = () => ({ id: 'map-1a2b3c4d', title: 'Field notes: offline', revision: 17, rootId: 'root', edges: [], jobs: [], nodes: [
  idea('root', { questions: [q('q-aaaaaaaa'), q('q-bbbbbbbb', { answer: 'Done.' }), q('q-cccccccc', { supersededAt: '2026-01-01' }), q('q-dddddddd', { dismissedAt: '2026-01-01' }), q('q-later000', { deferredAt: '2026-01-01' })] }),
  idea('a', { title: 'Sync\n# twice', questions: [q('q-eeeeeeee', { text: 'Who resolves\nconflicts?' })] }),
  idea('done', { status: 'explored', questions: [q('q-ffffffff')] }), idea('quiet', { status: 'queued' })] });
// Fill an exported file's answer blocks: { questionId: text }.
const fill = (markdown, answers) => markdown.replace(/<!-- question (\S+) -->\n<!-- answer -->\n\n<!-- end answer -->/g, (block, id) => (id in answers ? `<!-- question ${id} -->\n<!-- answer -->\n${answers[id]}\n<!-- end answer -->` : block));

test('the export lists every open question with its ID, grouped by idea, and leaves answered, superseded, dismissed and finished ones out', () => {
  const map = fixture(), markdown = answerFileMarkdown(map);
  assert.ok(markdown.startsWith('# Open questions: Field notes: offline\n<!-- explore-answers v1 map=map-1a2b3c4d revision=17 -->\n'));
  assert.deepEqual([...markdown.matchAll(/<!-- question (\S+) -->/g)].map(match => match[1]), ['q-aaaaaaaa', 'q-later000', 'q-eeeeeeee'], 'saved-for-later questions are open too');
  assert.match(markdown, /\n## Idea root\n\n### Question q-aaaaaaaa\?\n<!-- question q-aaaaaaaa -->\n<!-- answer -->\n\n<!-- end answer -->\n/);
  assert.match(markdown, /\n## Sync # twice\n\n### Who resolves conflicts\?\n/, 'titles and questions stay on their heading line');
  assert.deepEqual(openQuestionsForFile(map).map(group => [group.node.id, group.questions.length]), [['root', 2], ['a', 1]]);
  assert.equal(answerFilename(map), 'Field notes- offline-questions.md');
  assert.match(answerFileMarkdown({ ...map, nodes: [idea('root')] }), /There are no open questions on this map\./);
});

test('import reads only the text inside answer blocks, by question ID: edited headings change nothing, CRLF works, empty blocks are skipped', () => {
  const map = fixture();
  let text = fill(answerFileMarkdown(map), { 'q-aaaaaaaa': '  The team lead.\n\nThen the group.  ', 'q-eeeeeeee': '   \n  ' });
  text = text.replace('### Question q-aaaaaaaa?', '### A question I rewrote').replace('Write each answer', 'I scribbled here. Write each answer');
  const parsed = parseAnswerFile(text.replace(/\n/g, '\r\n'), { mapId: map.id });
  assert.deepEqual(parsed.answers, [{ questionId: 'q-aaaaaaaa', answer: 'The team lead.\n\nThen the group.', line: 9 }]);
  assert.equal(parsed.revision, 17);
});

test('an answer can say how sure it is on a first line; a state alone is no answer, and an unknown state rejects the file', () => {
  const map = fixture(), blank = answerFileMarkdown(map);
  const parsed = parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'State: Decided\nThe lead.', 'q-later000': 'state: assumption', 'q-eeeeeeee': 'Plain answer.' }), { mapId: map.id });
  assert.deepEqual(parsed.answers.map(({ questionId, answer, answerState }) => [questionId, answer, answerState ?? null]), [['q-aaaaaaaa', 'The lead.', 'decided'], ['q-eeeeeeee', 'Plain answer.', null]]);
  assert.throws(() => parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'state: certain\nThe lead.' }), { mapId: map.id }), error => error.line === 10 && /state must be decided, tentative or assumption/.test(error.message));
  assert.deepEqual(parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'State of the art: unclear.' }), { mapId: map.id }).answers[0].answer, 'State of the art: unclear.', 'only a one-word state line is a state');
});

test('a file for another map, with a question twice, or with broken markers is rejected with a line number', () => {
  const map = fixture(), blank = answerFileMarkdown(map);
  const rejects = (text, line, pattern) => assert.throws(() => parseAnswerFile(text, { mapId: map.id }), error => error.line === line && pattern.test(error.message), pattern.source);
  rejects(blank.replace('map=map-1a2b3c4d', 'map=map-99999999'), 2, /for map map-99999999, not map-1a2b3c4d/);
  rejects(blank.replace('<!-- question q-later000 -->', '<!-- question q-aaaaaaaa -->'), 14, /q-aaaaaaaa appears twice \(first on line 8\)/);
  rejects(blank.replace('<!-- question q-aaaaaaaa -->\n<!-- answer -->\n\n<!-- end answer -->', '<!-- question q-aaaaaaaa -->\n<!-- answer -->\nUnfinished.'), 13, /The answer to q-aaaaaaaa \(line 9\) needs <!-- end answer --> before this marker/);
  rejects(blank.replace(/<!-- answer -->\n\n<!-- end answer -->\s*$/, '<!-- answer -->\nUnfinished.\n'), 23, /The answer to q-eeeeeeee \(line 23\) has no <!-- end answer -->/);
  rejects(blank.replace('<!-- question q-aaaaaaaa -->\n', ''), 8, /must follow a question marker/);
  rejects(blank.replace('<!-- explore-answers v1 map=map-1a2b3c4d revision=17 -->\n', ''), 1, /not an Explore answers file/);
  rejects(blank.replace('<!-- answer -->\n\n<!-- end answer -->\n\n### Question q-later000', '\n### Question q-later000'), 8, /Question q-aaaaaaaa \(line 8\) has no answer block/);
});

test('the preview says what each answer would do, and shows the user\'s text escaped', () => {
  const map = fixture();
  const answers = [{ questionId: 'q-aaaaaaaa', answer: '<b>Lead</b> & **group**', line: 1 }, { questionId: 'q-bbbbbbbb', answer: 'Again.', line: 2 }, { questionId: 'q-cccccccc', answer: 'Old.', line: 3 },
    { questionId: 'q-ffffffff', answer: 'Late.', line: 4 }, { questionId: 'q-zzzzzzzz', answer: 'Who?', line: 5 }, { questionId: 'q-eeeeeeee', answer: 'x'.repeat(12001), line: 6 }, { questionId: 'q-dddddddd', answer: 'Back?', line: 7 }];
  const preview = answerPreview(map, answers);
  assert.deepEqual(preview.map(item => item.status), ['ready', 'answered', 'superseded', 'completed', 'unknown', 'too-long', 'dismissed']);
  assert.deepEqual(preview[0], { questionId: 'q-aaaaaaaa', answer: '<b>Lead</b> & **group**', line: 1, status: 'ready', nodeId: 'root', question: 'Question q-aaaaaaaa?', title: 'Idea root' });
  const html = answerPreviewHtml(preview, { esc });
  assert.match(html, /<p class="answer-preview-text">&lt;b&gt;Lead&lt;\/b&gt; &amp; \*\*group\*\*<\/p>/); assert.doesNotMatch(html, /<b>Lead/);
  assert.match(html, /Already answered: the saved answer is kept/); assert.match(html, /Unknown question q-zzzzzzzz/);
});

async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'answers-'));
  const store = new Store(path.join(dir, 'ideas'));
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Found.', body: 'Details.', questions: ['Who decides?', 'When?'] });
  return { dir, store, map: await store.get(map.id) };
}

test('the CLI exports a file, previews an import without saving, and with --apply saves each answer so the branch continues', async () => {
  const { dir, store, map } = await workspace();
  const app = await startServer({ workspace: dir, port: 0 });
  const cli = async args => JSON.parse((await exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', dir])).stdout);
  try {
    const out = path.join(dir, 'answers.md');
    const exported = await cli(['answers', 'export', '--map', map.id, '--out', out]);
    assert.deepEqual(exported, { exported: map.id, questions: 2, file: out });
    await assert.rejects(cli(['answers', 'export', '--map', map.id, '--out', out]), /already exists/);
    const [first, second] = map.nodes[0].questions;
    await writeFile(out, fill(await readFile(out, 'utf8'), { [first.id]: 'state: decided\nThe <lead>.', [second.id]: 'Weekly.' }));
    const before = await store.get(map.id);
    const preview = await cli(['answers', 'import', '--map', map.id, '--file', out]);
    assert.deepEqual(preview.preview.map(item => [item.questionId, item.status]), [[first.id, 'ready'], [second.id, 'ready']]); assert.equal(preview.applied, undefined);
    assert.equal((await store.get(map.id)).revision, before.revision, 'without --apply nothing changes');
    const applied = await cli(['answers', 'import', '--map', map.id, '--file', out, '--apply']);
    assert.deepEqual(applied.applied, { saved: [first.id, second.id], failed: [] });
    const after = await store.get(map.id);
    assert.deepEqual(after.nodes[0].questions.map(item => [item.answer, item.answerState]), [['The <lead>.', 'decided'], ['Weekly.', 'tentative']], 'plain text, as typed');
    assert.equal(after.nodes[0].status, 'queued', 'the branch continues as if answered in the browser');
    const again = await cli(['answers', 'import', '--map', map.id, '--file', out, '--apply']);
    assert.deepEqual(again.preview.map(item => item.status), ['answered', 'answered']); assert.deepEqual(again.applied, { saved: [], failed: [] });
    assert.deepEqual((await store.get(map.id)).nodes[0].questions.map(item => item.answer), ['The <lead>.', 'Weekly.'], 'saved answers are kept');
    await writeFile(out, (await readFile(out, 'utf8')).replace(`map=${map.id}`, 'map=map-00000000'));
    await assert.rejects(cli(['answers', 'import', '--map', map.id, '--file', out, '--apply']), /Line 2: This file is for map map-00000000/);
  } finally { await app.close(); }
});

// A small fake DOM for the browser flow.
function fakeDialog({ map, act }) {
  const elements = new Map(), downloads = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, open: false, files: [],
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, click() { this.clicked = (this.clicked ?? 0) + 1; }, focus() {} });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  answersDialog({ map, act, esc, toast: message => toasts.push(message), download: (text, type, name) => downloads.push({ text, type, name }) });
  return { element, downloads, toasts };
}

test('the browser exports a file, previews an import, and saves the ready answers one at a time, listing what failed', async () => {
  let map = fixture();
  const calls = [];
  const io = fakeDialog({ map: () => map, act: async (nodeId, type, input, { onError }) => { calls.push([nodeId, type, input]); if (input.questionId === 'q-later000') { onError('The map changed.'); return false; } return true; } });
  try {
    io.element('tools-dialog').open = true;
    await io.element('answers-export').fire('click');
    assert.equal(io.downloads[0].name, 'Field notes- offline-questions.md'); assert.equal(io.downloads[0].type, 'text/markdown');
    const text = fill(io.downloads[0].text, { 'q-aaaaaaaa': 'state: assumption\nThe lead.', 'q-later000': 'Later.' });
    await io.element('answers-import').fire('click');
    assert.equal(io.element('answers-file').clicked, 1);
    io.element('answers-file').files = [{ text: async () => text }]; await io.element('answers-file').fire('change');
    assert.equal(io.element('answers-dialog').open, true); assert.equal(io.element('tools-dialog').open, false);
    assert.match(io.element('answers-summary').textContent, /^2 answers ready to save\./); assert.equal(io.element('answers-save').hidden, false);
    await io.element('answers-save').fire('click');
    assert.deepEqual(calls, [['root', 'answer', { questionId: 'q-aaaaaaaa', answer: 'The lead.', answerState: 'assumption' }], ['root', 'answer', { questionId: 'q-later000', answer: 'Later.' }]]);
    assert.match(io.element('answers-summary').textContent, /^Saved 1 answer\. 1 was not saved\./); assert.match(io.element('answers-body').innerHTML, /The map changed\./);
    assert.equal(io.element('answers-save').hidden, true, 'saving happens once');
    io.element('answers-file').files = [{ text: async () => text.replace('map=map-1a2b3c4d', 'map=map-00000000') }]; await io.element('answers-file').fire('change');
    assert.match(io.toasts.at(-1), /^Line 2: This file is for map map-00000000/); assert.equal(calls.length, 2, 'a rejected file saves nothing');
  } finally { delete globalThis.document; }
});
