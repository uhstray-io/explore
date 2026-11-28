import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { togglePin, resolvePins, pinnedAnswersHtml, pinToggleHtml, maxPins } from '../skills/explore/assets/pinned-answers.js';

// Pin reference answers (Z11, #69). Illustrative maps under .test-output, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'pins-')), 'ideas'));
  let map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('test', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Offline first.', body: 'Findings.', questions: ['What is the budget?', 'Who is the audience?', 'Which phones?', 'How long?', 'Where?'] });
  map = await store.get(map.id);
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  const [q1, q2, q3, q4, q5] = map.nodes[0].questions;
  for (const [q, answer] of [[q1, 'Under 500.'], [q2, 'Field rangers.'], [q3, 'Android only.'], [q4, 'A season.']]) map = await act({ type: 'answer', nodeId: map.rootId, questionId: q.id, answer });
  return { store, map, act, root: map.rootId, questions: [q1, q2, q3, q4, q5] };
}

test('toggling adds in pin order, removes, and never goes past three', () => {
  const a = { nodeId: 'n', questionId: 'a' }, b = { nodeId: 'n', questionId: 'b' }, c = { nodeId: 'n', questionId: 'c' }, d = { nodeId: 'n', questionId: 'd' };
  assert.equal(maxPins, 3);
  assert.deepEqual(togglePin([a, b], c), [a, b, c]);
  assert.deepEqual(togglePin([a, b, c], b), [a, c]);
  assert.equal(togglePin([a, b, c], d), null, 'a fourth is refused');
});

test('pins are saved in the map without a version or an outside-change notice, and never reach a brief or a packet', async () => {
  const { store, map, act, root, questions: [q1, q2, q3, q4, q5] } = await workspace();
  const versions = (await store.versions.list(map.id)).versions.length;
  let saved = await act({ type: 'pin-answer', nodeId: root, questionId: q1.id, pinned: true });
  saved = await act({ type: 'pin-answer', nodeId: root, questionId: q2.id, pinned: true });
  assert.deepEqual(saved.view.pinnedAnswers, [{ nodeId: root, questionId: q1.id }, { nodeId: root, questionId: q2.id }]);
  assert.equal((await store.versions.list(map.id)).versions.length, versions, 'no version for a pin');
  await act({ type: 'pin-answer', nodeId: root, questionId: q3.id, pinned: true });
  await assert.rejects(act({ type: 'pin-answer', nodeId: root, questionId: q4.id, pinned: true }), error => error.status === 409 && /Unpin one/.test(error.message));
  await assert.rejects(act({ type: 'pin-answer', nodeId: root, questionId: q5.id, pinned: false }), error => error.status === 409, 'not pinned');
  saved = await act({ type: 'pin-answer', nodeId: root, questionId: q2.id, pinned: false });
  await assert.rejects(act({ type: 'pin-answer', nodeId: root, questionId: q5.id, pinned: true }), error => error.status === 409 && /answered/.test(error.message), 'an unanswered question');
  assert.doesNotMatch(JSON.stringify(mapBrief(saved)), /pinnedAnswers/);
  await act({ type: 'answer', nodeId: root, questionId: q5.id, answer: 'Here.' }); // The last answer continues the branch.
  const packet = await store.claim('test', map.id);
  assert.doesNotMatch(JSON.stringify(packet), /pinnedAnswers/);
  // A teammate's pin arriving by pull is not an outside change.
  const file = store.file(map.id), now = JSON.parse(await readFile(file, 'utf8'));
  await store.get(map.id);
  await writeFile(file, JSON.stringify({ ...now, view: { ...now.view, pinnedAnswers: [{ nodeId: root, questionId: q4.id }] } }, null, 2) + '\n');
  await store.get(map.id);
  assert.equal(store.tracking(map.id).outsideChange, null);
});

test('a pin whose idea is missing can still be unpinned', async () => {
  const { store, map, act, root, questions: [q1] } = await workspace();
  await act({ type: 'pin-answer', nodeId: root, questionId: q1.id, pinned: true });
  const file = store.file(map.id), now = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...now, view: { ...now.view, pinnedAnswers: [...now.view.pinnedAnswers, { nodeId: 'node-gone', questionId: 'q-gone' }] } }, null, 2) + '\n');
  const saved = await act({ type: 'pin-answer', nodeId: 'node-gone', questionId: 'q-gone', pinned: false });
  assert.deepEqual(saved.view.pinnedAnswers, [{ nodeId: root, questionId: q1.id }]);
});

test('the inspector shows pins from other ideas above the open questions, with Go to idea, Unpin and unavailable rows', async () => {
  const { map, root, questions: [q1, q2] } = await workspace();
  const pins = [{ nodeId: root, questionId: q1.id }, { nodeId: 'node-elsewhere', questionId: 'q-x' }];
  map.nodes[0].questions[0].answer = 'Under 500. '.repeat(60);
  const rows = resolvePins(map, pins);
  assert.deepEqual(rows.map(row => row.available), [true, false]);
  const html = pinnedAnswersHtml(rows, { esc, selectedId: "node-other", open: true, historic: true });
  assert.match(html, /<details class="pinned-answers" data-editor="pins" open>/);
  assert.match(html, /data-pin-go="[^"]+"/); assert.match(html, /data-pin-unpin=/); assert.match(html, /Show full answer/);
  assert.match(html, /Not present at this growth step/);
  assert.doesNotMatch(pinnedAnswersHtml(rows, { esc, selectedId: root, open: false }), /What is the budget/, 'the selected idea’s own answers are not repeated');
  assert.equal(pinnedAnswersHtml([], { esc, selectedId: root, open: true }), '');
  // The toggle on an answered question.
  const pinned = pinToggleHtml({ nodeId: root, questionId: q1.id, pins, esc });
  assert.match(pinned, /aria-pressed="true"[^>]*>Pinned</);
  const full = pinToggleHtml({ nodeId: root, questionId: q2.id, pins: [...pins, { nodeId: 'n', questionId: 'z' }], esc });
  assert.match(full, /disabled/); assert.match(full, /Unpin one to add another/);
});
