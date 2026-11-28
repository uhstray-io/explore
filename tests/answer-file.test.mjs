import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { answerFileMarkdown, parseAnswerFile, answerPreview, applyAnswers, openQuestionsForFile } from '../skills/explore/assets/answer-file.js';
import { answersDialog, answerPreviewHtml, answerFilename } from '../skills/explore/assets/answers-dialog.js';

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

test('import reads only the text inside answer blocks, by question ID: edited headings change nothing, a BOM, CRLF or a lone CR work, empty blocks are skipped', () => {
  const map = fixture();
  let text = fill(answerFileMarkdown(map), { 'q-aaaaaaaa': '  The team lead.\n\n  Then the group.  ', 'q-eeeeeeee': '   \n  ' });
  text = text.replace('### Question q-aaaaaaaa?', '### A question I rewrote').replace('Write each answer', 'I scribbled here. Write each answer');
  const expected = [{ questionId: 'q-aaaaaaaa', answer: 'The team lead.\n\nThen the group.', line: 9 }];
  for (const variant of [text, text.replace(/\n/g, '\r\n'), text.replace(/\n/g, '\r'), `\uFEFF${text}`]) assert.deepEqual(parseAnswerFile(variant, { mapId: map.id }).answers, expected);
  const indented = text.replace('<!-- question q-later000 -->\n<!-- answer -->\n\n<!-- end answer -->', '   <!-- question q-later000 -->  \n\t<!-- answer -->\n    First line.\n      Indented more.\n    Back.\n  <!-- end answer -->   ');
  assert.deepEqual(parseAnswerFile(indented, { mapId: map.id }).answers[1], { questionId: 'q-later000', answer: 'First line.\n  Indented more.\nBack.', line: 17 }, 'markers may be indented; shared indentation is removed');
});

test('an answer can say how sure it is on a first line; a state alone is no answer, and any other "state:" line is answer text', () => {
  const map = fixture(), blank = answerFileMarkdown(map);
  const parsed = parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'State: Decided\nThe lead.', 'q-later000': 'state: assumption', 'q-eeeeeeee': 'Plain answer.' }), { mapId: map.id });
  assert.deepEqual(parsed.answers.map(({ questionId, answer, answerState }) => [questionId, answer, answerState ?? null]), [['q-aaaaaaaa', 'The lead.', 'decided'], ['q-eeeeeeee', 'Plain answer.', null]]);
  assert.deepEqual(parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'State: Delaware' }), { mapId: map.id }).answers[0], { questionId: 'q-aaaaaaaa', answer: 'State: Delaware', line: 9 }, 'an answer, not a state');
  assert.deepEqual(parseAnswerFile(fill(blank, { 'q-aaaaaaaa': 'State of the art: unclear.' }), { mapId: map.id }).answers[0].answer, 'State of the art: unclear.');
});

test('a file for another map, with a question twice, a header out of place or broken markers is rejected with a line number', () => {
  const map = fixture(), blank = answerFileMarkdown(map);
  const rejects = (text, line, pattern) => assert.throws(() => parseAnswerFile(text, { mapId: map.id }), error => error.line === line && pattern.test(error.message) && error.message.startsWith(`Line ${line}: `), pattern.source);
  rejects(blank.replace('map=map-1a2b3c4d', 'map=map-99999999'), 2, /for map map-99999999, not map-1a2b3c4d/);
  rejects(blank.replace('<!-- question q-later000 -->', '<!-- question q-aaaaaaaa -->'), 14, /q-aaaaaaaa appears twice \(first on line 8\)/);
  rejects(blank.replace('<!-- question q-aaaaaaaa -->\n<!-- answer -->\n\n<!-- end answer -->', '<!-- question q-aaaaaaaa -->\n<!-- answer -->\nUnfinished.'), 13, /The answer to q-aaaaaaaa \(line 9\) needs <!-- end answer --> before this marker/);
  rejects(blank.replace(/<!-- answer -->\n\n<!-- end answer -->\s*$/, '<!-- answer -->\nUnfinished.\n'), 23, /The answer to q-eeeeeeee \(line 23\) has no <!-- end answer -->/);
  rejects(blank.replace('<!-- question q-aaaaaaaa -->\n', ''), 8, /must follow a question marker/);
  rejects(blank.replace('<!-- explore-answers v1 map=map-1a2b3c4d revision=17 -->\n', ''), 1, /not an Explore answers file/);
  rejects(blank.replace('<!-- answer -->\n\n<!-- end answer -->\n\n### Question q-later000', '\n### Question q-later000'), 8, /Question q-aaaaaaaa \(line 8\) has no answer block/);
  rejects(blank.replace('### Question q-later000?', '<!-- end answer -->'), 13, /end marker has no answer marker/);
  const header = '<!-- explore-answers v1 map=map-1a2b3c4d revision=17 -->', moved = `${blank.replace(`${header}\n`, '')}${header}\n`;
  rejects(moved, moved.split('\n').indexOf(header) + 1, /header must come before the questions/);
  rejects(`${blank}${header}\n`, 26, /a second explore-answers header/);
  rejects(blank.replace('\n\n## Idea root', '\n<!-- explore-answers v1 map=map-1a2b3c4d revision=17 -->\n\n## Idea root'), 4, /a second explore-answers header/);
});

test('the preview says what each answer would do, by the answer action\'s own rule, and shows the file\'s text and the map\'s words escaped', () => {
  const map = fixture();
  map.nodes[0].title = 'Idea <root>'; map.nodes[0].questions[0].text = 'Who <decides>?';
  const answers = [{ questionId: 'q-aaaaaaaa', answer: '<b>Lead</b> & **group**', line: 1 }, { questionId: 'q-bbbbbbbb', answer: 'Again.', line: 2 }, { questionId: 'q-cccccccc', answer: 'Old.', line: 3 },
    { questionId: 'q-ffffffff', answer: 'Late.', line: 4 }, { questionId: 'q-zzzzzzzz', answer: 'Who?', line: 5 }, { questionId: 'q-eeeeeeee', answer: 'x'.repeat(12001), line: 6 }, { questionId: 'q-dddddddd', answer: 'Back?', line: 7 },
    { questionId: 'q-later000', answer: 'x'.repeat(12000), line: 8, answerState: 'decided' }];
  const preview = answerPreview(map, answers);
  assert.deepEqual(preview.map(item => item.status), ['ready', 'answered', 'superseded', 'completed', 'unknown', 'too-long', 'dismissed', 'ready'], '12,000 characters is still ready');
  assert.deepEqual(preview[0], { questionId: 'q-aaaaaaaa', answer: '<b>Lead</b> & **group**', line: 1, status: 'ready', nodeId: 'root', question: 'Who <decides>?', title: 'Idea <root>', deferred: false });
  assert.equal(preview[1].reason, 'This question was already answered. Refresh the map.', 'the Store\'s own words');
  const html = answerPreviewHtml(preview, { esc });
  assert.match(html, /<p class="answer-preview-question">Line 1 · Idea &lt;root&gt; · Who &lt;decides&gt;\?<\/p><p class="answer-preview-text">&lt;b&gt;Lead&lt;\/b&gt; &amp; \*\*group\*\*<\/p><p class="answer-preview-status">Ready to save · Tentative \(no state given\)<\/p>/);
  assert.doesNotMatch(html, /<b>|<root>|<decides>/); assert.match(html, /Ready to save · Decided/);
  assert.match(html, /Already answered: the saved answer is kept/); assert.match(html, /Unknown question q-zzzzzzzz/);
  assert.match(html, /<p class="answer-preview-text">x{2000}…<\/p>/, 'a long answer is shown shortened');
  assert.match(answerPreviewHtml(preview, { esc, saved: ['q-aaaaaaaa'], failed: new Map([['toString', 'x']]) }), /Saved · /, 'outcomes are looked up by ID, never on an object\'s own names');
});

test('answers are saved one at a time, saved-for-later ones first within an idea, and a failure is checked again and retried once', async () => {
  const item = (questionId, nodeId, extra = {}) => ({ questionId, nodeId, status: 'ready', answer: `A ${questionId}`, line: 1, deferred: false, ...extra });
  const items = [item('q-1', 'n1'), item('q-2', 'n2'), item('q-3', 'n1', { deferred: true }), item('q-4', 'n1', { status: 'answered' })];
  const sent = [], progress = [];
  let active = 0, most = 0;
  const send = async next => { active++; most = Math.max(most, active); await new Promise(resolve => setImmediate(resolve)); active--; sent.push(next.questionId); return true; };
  let result = await applyAnswers(items, { send, refresh: async () => null, onProgress: (done, total) => progress.push(`${done}/${total}`) });
  assert.deepEqual(sent, ['q-3', 'q-1', 'q-2'], 'the idea\'s saved-for-later answer goes before the one that queues it; ideas in file order; only ready ones');
  assert.equal(most, 1, 'never two at once'); assert.deepEqual(result, { saved: ['q-3', 'q-1', 'q-2'], failed: [], notAttempted: [] }); assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
  // The map moved on (an agent claimed a branch): the answer is still ready, so it is sent again.
  const map = { nodes: [{ id: 'n1', status: 'awaiting-answer', questions: [{ id: 'q-1', text: 'Q?', answer: null }] }] };
  let tries = 0;
  result = await applyAnswers([item('q-1', 'n1')], { send: async (next, fail) => { tries++; if (tries === 1) { fail('This map changed. Refresh and try again.'); return false; } return true; }, refresh: async () => map });
  assert.equal(tries, 2); assert.deepEqual(result.saved, ['q-1']);
  // Checked again and no longer ready: not sent again, with the Store's reason.
  map.nodes[0].questions[0].answer = 'Someone else answered.';
  tries = 0;
  result = await applyAnswers([item('q-1', 'n1')], { send: async (next, fail) => { tries++; fail('This map changed.'); return false; }, refresh: async () => map });
  assert.equal(tries, 1); assert.deepEqual(result.failed, [{ questionId: 'q-1', error: 'This question was already answered. Refresh the map.' }]);
  // The server went away: stop, and say what was not attempted.
  result = await applyAnswers([item('q-1', 'n1'), item('q-2', 'n2')], { send: async (next, fail) => { fail('fetch failed'); return false; }, refresh: async () => { throw new Error('fetch failed'); } });
  assert.deepEqual(result, { saved: [], failed: [{ questionId: 'q-1', error: 'fetch failed' }], notAttempted: ['q-2'], stopped: 'fetch failed' });
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

test('the answer action refuses by the same rule the preview uses', async () => {
  const { store, map } = await workspace();
  const [first] = map.nodes[0].questions;
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  await assert.rejects(act({ type: 'answer', nodeId: map.rootId, questionId: 'q-00000000', answer: 'x' }), error => error.status === 404 && error.message === 'Question not found.');
  await assert.rejects(act({ type: 'answer', nodeId: map.rootId, questionId: first.id, answer: 'x'.repeat(12001) }), /at most 12000/);
  await act({ type: 'answer', nodeId: map.rootId, questionId: first.id, answer: 'The lead.' });
  await assert.rejects(act({ type: 'answer', nodeId: map.rootId, questionId: first.id, answer: 'Again.' }), error => error.status === 409 && /already answered/.test(error.message));
});

// A small fake DOM for the browser flow.
function fakeDialog({ map, act, live = () => true }) {
  const elements = new Map(), downloads = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, open: false, files: [], focused: 0,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, click() { this.clicked = (this.clicked ?? 0) + 1; }, focus() { this.focused++; } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  answersDialog({ map, act, live, esc, download: (text, type, name) => downloads.push({ text, type, name }) });
  return { element, downloads };
}

test('the browser exports a file, previews an import, and saves the ready answers one at a time, listing what failed', async () => {
  let map = fixture();
  const calls = [], disabledWhileSaving = [];
  let io;
  const act = async (nodeId, type, input, { onError }) => {
    calls.push([nodeId, type, input]); disabledWhileSaving.push(io.element('answers-save').disabled);
    if (input.questionId === 'q-later000') { onError('The map changed.'); return false; }
    return true;
  };
  io = fakeDialog({ map: () => map, act });
  try {
    io.element('tools-dialog').open = true;
    await io.element('answers-export').fire('click');
    assert.equal(io.downloads[0].name, 'Field notes- offline-questions.md'); assert.equal(io.downloads[0].type, 'text/markdown');
    const text = fill(io.downloads[0].text, { 'q-aaaaaaaa': 'state: assumption\nThe lead.', 'q-later000': 'Later.', 'q-eeeeeeee': 'Sync daily.' }).replace('<!-- question q-later000 -->', '<!-- question q-later000 -->');
    io.element('answers-file').value = 'C:\\fakepath\\answers.md';
    await io.element('answers-import').fire('click');
    assert.equal(io.element('answers-file').clicked, 1); assert.equal(io.element('answers-file').value, '', 'the same file can be read again');
    map.nodes[1].questions[0].answer = 'Answered meanwhile.'; // Not ready: never sent.
    io.element('answers-file').files = [{ text: async () => text }]; await io.element('answers-file').fire('change');
    assert.equal(io.element('answers-dialog').open, true); assert.equal(io.element('tools-dialog').open, false);
    assert.match(io.element('answers-summary').textContent, /^2 answers ready to save\. 1 will not be saved\. Nothing is saved until you choose Save these answers\.$/); assert.equal(io.element('answers-save').hidden, false);
    await io.element('answers-save').fire('click');
    assert.deepEqual(calls, [['root', 'answer', { questionId: 'q-later000', answer: 'Later.' }], ['root', 'answer', { questionId: 'q-later000', answer: 'Later.' }], ['root', 'answer', { questionId: 'q-aaaaaaaa', answer: 'The lead.', answerState: 'assumption' }]],
      'the saved-for-later answer first, retried once after a re-read; the answered one never');
    assert.ok(disabledWhileSaving.every(Boolean), 'Save is disabled while saving');
    assert.match(io.element('answers-summary').textContent, /^Saved 1 answer\. 2 were not saved\./); assert.match(io.element('answers-body').innerHTML, /The map changed\./);
    assert.equal(io.element('answers-save').hidden, true, 'saving happens once'); assert.equal(io.element('answers-summary').focused, 1, 'focus moves to the outcome');
    io.element('answers-file').files = [{ text: async () => text.replace('map=map-1a2b3c4d', 'map=map-00000000') }]; await io.element('answers-file').fire('change');
    assert.match(io.element('answers-status').textContent, /^Line 2: This file is for map map-00000000, not map-1a2b3c4d\. Nothing was saved\.$/, 'said in Map tools, where the user is');
    assert.equal(calls.length, 3, 'a rejected file saves nothing');
  } finally { delete globalThis.document; }
});

test('the browser refuses an import while viewing history, since it changes the live map', async () => {
  const io = fakeDialog({ map: () => fixture(), act: async () => true, live: () => false });
  try {
    await io.element('answers-import').fire('click');
    assert.equal(io.element('answers-file').clicked, undefined); assert.equal(io.element('answers-status').textContent, 'Return to the live map to import answers.');
  } finally { delete globalThis.document; }
});
