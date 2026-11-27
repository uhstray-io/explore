import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOverview, visibleSelection, briefFilename, briefPreview, historyStepLabel } from '../skills/explore/assets/workspace-view.js';

test('overview distinguishes awaiting input, queue, inactive ideas and stale findings without editing the map', () => {
  const map = { nodes: [
    { id: 'answer', status: 'awaiting-answer' }, { id: 'queued', status: 'queued' },
    { id: 'future', status: 'suggested' }, { id: 'running', status: 'running' },
    { id: 'accepted', status: 'explored', reviewState: 'accepted' },
    { id: 'changed', status: 'explored', reviewState: 'accepted', stale: true },
    { id: 'retry', status: 'interrupted' },
  ] };
  const before = structuredClone(map), result = mapOverview(map);
  assert.deepEqual(result.groups.map(group => [group.id, group.nodes.map(node => node.id)]), [
    ['answer', ['answer']], ['queued', ['queued']], ['unexplored', ['future']], ['stale', ['changed']],
  ]);
  assert.equal(result.total, 7); assert.equal(result.explored, 2); assert.equal(result.accepted, 1); assert.equal(result.running, 1);
  assert.deepEqual(map, before);
  assert.equal(mapOverview({ nodes: [] }).groups.every(group => group.nodes.length === 0), true);
});

test('scrubbing clears a selection absent from that growth step instead of displaying a future idea', () => {
  const early = { rootId: 'root', nodes: [{ id: 'root' }] };
  assert.equal(visibleSelection(early, 'future'), null);
  assert.equal(visibleSelection(early, 'root'), 'root');
  assert.equal(visibleSelection({ nodes: [] }, 'root'), null);
});

test('brief filenames remain usable for titles containing platform path characters', () => {
  assert.equal(briefFilename('Pricing / launch: Q4?'), 'Pricing - launch- Q4--brief.md');
  assert.equal(briefFilename(''), 'exploration-brief.md');
  assert.equal(briefFilename('Plan...'), 'Plan-brief.md');
  assert.ok(!briefFilename('../data\\node\u0000').includes('/'));
});

test('timeline labels distinguish unknown dates from recorded additions without inventing time', () => {
  const step = { index: 1, nodeCount: 4, edgeCount: 3, kind: 'unknown' };
  assert.equal(historyStepLabel(step, 2), 'Step 2 of 2 · 4 ideas · 3 connections · Additions with unknown dates');
  assert.match(historyStepLabel({ ...step, kind: 'dated' }, 2), /recorded node dates/);
  assert.match(historyStepLabel({ ...step, kind: 'recorded' }, 2), /Recorded addition/);
  assert.equal(historyStepLabel(null, 0), 'No growth has been recorded yet');
});

test('brief preview treats saved HTML and links as text while preserving stale and omission notices', () => {
  const brief = { originalIdea: '<img src=x onerror=alert(1)>', counts: { nodes: 3, explored: 2, accepted: 1, stale: 1, awaitingAnswer: 0 }, sections: [
    { label: '<script>alert(1)</script>', omitted: 2, items: [{ title: 'Research <b>title</b>', text: '[click](javascript:alert(1)) & <iframe>', nodeId: 'node-123', status: 'explored', reviewState: 'accepted', stale: true }] },
  ] };
  const html = briefPreview(brief);
  assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<iframe'));
  assert.ok(!html.includes('<a ') && !html.includes('<b>title'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Explored · needs review/);
  assert.match(html, /2 more records/);
  assert.match(html, /node-123/);
});

test('the open map is reported removed, unreadable or changed, comparing content rather than revision alone', async () => {
  const { openMapChange } = await import('../skills/explore/assets/workspace-view.js');
  const shown = { id: 'map-a', revision: 4, fingerprint: 'f1' };
  assert.equal(openMapChange({ id: 'map-a', revision: 4, fingerprint: 'f1' }, shown), null);
  assert.equal(openMapChange(undefined, shown), 'removed');
  assert.equal(openMapChange({ id: 'map-a', unreadable: true, problem: 'conflict-markers' }, shown), 'unreadable');
  assert.equal(openMapChange({ id: 'map-a', revision: 4, fingerprint: 'f2' }, shown), 'changed', 'same revision, different content');
  assert.equal(openMapChange({ id: 'map-a', revision: 2, fingerprint: 'f0' }, shown), 'changed', 'a revision that goes backwards still counts');
  assert.equal(openMapChange({ id: 'map-a' }, null), null);
});

test('unreadable maps are explained in plain words without quoting the file', async () => {
  const { unreadableLabel } = await import('../skills/explore/assets/workspace-view.js');
  assert.equal(unreadableLabel('conflict-markers'), "Can't open: unresolved Git conflict");
  for (const problem of ['invalid-json', 'unsupported-version', 'invalid-map', 'something-new']) assert.match(unreadableLabel(problem), /^Can't open/);
});

test('an outside change is announced once, quietly', async () => {
  const { outsideChangeNote } = await import('../skills/explore/assets/workspace-view.js');
  const change = { at: '2026-11-27T10:00:00Z', preserved: 'preserved/a.json', inGit: false };
  assert.match(outsideChangeNote(change, null), /outside Explore, for example a pull.*earlier version was kept/);
  assert.equal(outsideChangeNote(change, change.at), null);
  assert.doesNotMatch(outsideChangeNote({ ...change, preserved: null, inGit: true }, null), /kept/);
  assert.equal(outsideChangeNote(null, null), null);
});

test('versions are described in plain words, never internal event names', async () => {
  const { versionLabel } = await import('../skills/explore/assets/workspace-view.js');
  assert.equal(versionLabel({ labels: ['answered', 'activated'] }), 'Answer saved');
  assert.equal(versionLabel({ labels: ['result'] }), 'Agent result');
  assert.equal(versionLabel({ labels: ['version-restored'] }), 'Restored an earlier version');
  assert.equal(versionLabel({ labels: ['before-outside-change'] }), 'Before a pull or branch switch');
  assert.equal(versionLabel({ labels: ['branch-restarted', 'activated'] }), 'Branch restarted');
  assert.equal(versionLabel({ labels: ['answer-changed', 'activated'] }), 'Answer changed');
  assert.equal(versionLabel({ labels: ['reaffirmed'] }), 'Finding still holds');
  assert.equal(versionLabel({ labels: ['cleared'] }), 'Finding no longer relevant');
  assert.equal(versionLabel({ labels: ['something-new'] }), 'Saved change');
  assert.equal(versionLabel({ labels: ['suggested'], name: 'Before the workshop' }), 'Before the workshop');
});

test('undo goes back to the version before my latest change and names anything newer it also undoes', async () => {
  const { undoTarget } = await import('../skills/explore/assets/workspace-view.js');
  const versions = [{ id: 'v4', author: 'Bo' }, { id: 'v3', author: 'Ana' }, { id: 'v2' }, { id: 'v1', author: 'Ana' }];
  assert.deepEqual(undoTarget(versions, 'Ana'), { target: versions[2], undoing: versions[1], alsoUndone: [versions[0]] });
  assert.deepEqual(undoTarget(versions, null), { target: versions[1], undoing: versions[0], alsoUndone: [] });
  assert.deepEqual(undoTarget(versions, 'Cy'), { target: versions[1], undoing: versions[0], alsoUndone: [] }, 'with no change of mine, undo the latest');
  assert.equal(undoTarget([{ id: 'v1', author: 'Ana' }], 'Ana'), null, 'nothing earlier to go back to');
  assert.equal(undoTarget([], 'Ana'), null);
});

test('a restore summary says what changes and that research does not start', async () => {
  const { restoreSummary } = await import('../skills/explore/assets/workspace-view.js');
  const text = restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 2, nodesChanged: 1, linksAdded: 0, linksRemoved: 2 }, reopened: ['node-a'] });
  assert.match(text, /removes 2 ideas/); assert.match(text, /changes 1 idea\b/); assert.match(text, /removes 2 connections/);
  assert.match(text, /reopens 1 finished branch\b/); assert.match(text, /Nothing is explored until you choose Retry/);
  assert.doesNotMatch(text, /adds 0/);
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 1, linksAdded: 0, linksRemoved: 0 }, reopened: [] }), /^Restoring changes 1 idea\./);
});

test('an undo summary speaks of undoing', async () => {
  const { restoreSummary } = await import('../skills/explore/assets/workspace-view.js');
  assert.match(restoreSummary({ counts: { nodesAdded: 1, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0 }, reopened: [], queuedCancelled: 1 }), / It cancels 1 queued exploration\./);
  const text = restoreSummary({ counts: { nodesAdded: 1, nodesRemoved: 0, nodesChanged: 0, linksAdded: 1, linksRemoved: 0 }, reopened: [] }, { undo: true });
  assert.match(text, /^Undoing brings back 1 idea and brings back 1 connection\./); assert.match(text, /you can undo this too/);
});

test('pressing undo again steps further back instead of redoing', async () => {
  const { undoTarget } = await import('../skills/explore/assets/workspace-view.js');
  const T = { id: 'T' }, A = { id: 'A', author: 'Ana', labels: ['suggested'] }, B = { id: 'B', author: 'Ana', labels: ['suggested'] };
  const U1 = { id: 'U1', author: 'Ana', labels: ['change-undone'] };
  assert.deepEqual(undoTarget([U1, B, A, T], 'Ana'), { target: T, undoing: A, alsoUndone: [] });
  const U2 = { id: 'U2', author: 'Ana', labels: ['change-undone'] };
  assert.equal(undoTarget([U2, U1, B, A, T], 'Ana'), null, 'nothing of mine is left to undo');
  assert.deepEqual(undoTarget([U1, B, A, T], null), { target: T, undoing: A, alsoUndone: [] }, 'the same without a Git name');
});

test('copies kept around a pull are never the change that undo undoes', async () => {
  const { undoTarget } = await import('../skills/explore/assets/workspace-view.js');
  const A = { id: 'A', author: 'Ana', labels: ['answered'] }, X = { id: 'X', author: 'Bo', labels: ['result'] };
  const P = { id: 'P', labels: ['before-outside-change'] }, K = { id: 'K', labels: ['preserved'] }, O = { id: 'O' };
  assert.deepEqual(undoTarget([P, X, A, O], 'Ana'), { target: O, undoing: A, alsoUndone: [X] });
  assert.deepEqual(undoTarget([P, K, X, A, O], null), { target: A, undoing: X, alsoUndone: [] });
});

test('option cards label only the recommended one, say it is the agent’s view, and escape text', async () => {
  const { optionsHtml } = await import('../skills/explore/assets/workspace-view.js');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const node = { options: [
    { id: 'a', title: 'Hands-on <b>', description: 'Do it.', fit: 'Small groups.', pros: ['Fun'], cons: ['Tools'] },
    { id: 'b', title: 'Discussion', description: 'Talk.', fit: 'Big groups.', pros: [], cons: [] },
  ], recommendation: { optionId: 'a', rationale: 'Learning by doing.', mainTradeoff: 'Needs tools.', reconsiderIf: 'No hall.' } };
  const html = optionsHtml(node, esc);
  assert.match(html, /Hands-on &lt;b&gt;/); assert.doesNotMatch(html, /<b>/);
  assert.equal(html.match(/Recommended/g).length, 1);
  assert.match(html, /not a decision/i); assert.match(html, /Main trade-off/); assert.match(html, /Reconsider if/);
  const none = optionsHtml({ ...node, recommendation: { optionId: null, missing: 'Budget.' } }, esc);
  assert.match(none, /No recommendation yet/); assert.match(none, /Budget\./); assert.doesNotMatch(none, /Recommended/);
  assert.equal(optionsHtml({}, esc), '');
});

test('a suggested answer is added to the draft, never replacing it', async () => {
  const { appendSuggestion } = await import('../skills/explore/assets/workspace-view.js');
  assert.equal(appendSuggestion('', 'I would start hands-on.'), 'I would start hands-on.');
  assert.equal(appendSuggestion('My own thoughts.  ', 'I would start hands-on.'), 'My own thoughts.\n\nI would start hands-on.');
});

test('the answer chooser lists saved, current answers by idea, with nothing chosen at first', async () => {
  const { answerChoices } = await import('../skills/explore/assets/workspace-view.js');
  const map = { rootId: 'a', nodes: [
    { id: 'a', title: 'Root', parentId: null, questions: [{ id: 'q1', text: 'Budget?', answer: 'None.' }, { id: 'q2', text: 'Old?', answer: 'x', supersededAt: 't' }, { id: 'q3', text: 'Open?', answer: null }] },
    { id: 'b', title: 'Venue', parentId: 'a', questions: [{ id: 'q4', text: 'Hall?', answer: 'Church.' }] },
    { id: 'c', title: 'Empty', parentId: 'a', questions: [] },
  ] };
  assert.deepEqual(answerChoices(map), [
    { nodeId: 'a', title: 'Root', answers: [{ questionId: 'q1', question: 'Budget?' }] },
    { nodeId: 'b', title: 'Venue', answers: [{ questionId: 'q4', question: 'Hall?' }] },
  ]);
});

test('the check-answers panel shows what it reads, its progress, and each point to keep or dismiss', async () => {
  const { checkAnswersHtml } = await import('../skills/explore/assets/workspace-view.js');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const map = { rootId: 'a', nodes: [{ id: 'a', title: 'Root <i>', parentId: null, questions: [{ id: 'q1', text: 'Budget?', answer: 'None.' }] }], jobs: [], proposals: [] };
  const preview = { records: [{ kind: 'idea' }, { kind: 'answer' }, { kind: 'answer' }, { kind: 'open-question' }], omittedRecords: [{ reason: 'earlier premise' }] };
  let html = checkAnswersHtml({ map, preview, listening: false, esc });
  assert.match(html, /Reads 2 answers and 1 open question/); assert.match(html, /1 answer from an earlier premise is left out/);
  assert.match(html, /data-check-answers/); assert.match(html, /never changes an answer/);
  html = checkAnswersHtml({ map: { ...map, jobs: [{ id: 'job-1', type: 'check-answers', status: 'queued' }] }, preview, listening: false, esc });
  assert.doesNotMatch(html, /data-check-answers/); assert.match(html, /Connect your agent/); assert.match(html, /data-cancel-job="job-1"/);
  const proposal = { id: 'p1', type: 'check-answers', createdAt: '2026-11-27T10:00:00Z', stale: true, items: [
    { id: 'i1', category: 'unresolved-choice', explanation: 'Food costs <money>.', resolution: 'Decide on food.', refs: [{ nodeId: 'a', questionId: 'q1' }], review: 'unreviewed' },
    { id: 'i2', category: 'untested-assumption', explanation: 'Everyone comes.', resolution: 'Ask.', refs: [{ nodeId: 'a', questionId: 'q1' }], review: 'dismissed' },
  ] };
  html = checkAnswersHtml({ map: { ...map, proposals: [proposal] }, preview, listening: true, esc });
  assert.match(html, /Unresolved choice/); assert.match(html, /Food costs &lt;money&gt;/); assert.match(html, /What would settle it/);
  assert.match(html, /data-review-item="i1"[^>]*data-decision="accepted"[^>]*>Keep/); assert.match(html, /data-decision="dismissed"[^>]*>Dismiss/);
  assert.match(html, /Dismissed/); assert.match(html, /answers changed since this check/);
  assert.match(html, /data-select="a"[^>]*>Root &lt;i&gt; · Budget\?/);
  assert.match(checkAnswersHtml({ map: { ...map, proposals: [{ ...proposal, stale: false, items: [] }] }, preview, listening: true, esc }), /No tensions found/);
});

test('the question menu lists its items in the agreed order and is labelled for assistive technology', async () => {
  const { questionMenuHtml } = await import('../skills/explore/assets/workspace-view.js');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const open = questionMenuHtml({ id: 'q1', text: 'Budget?', answer: null }, { nodeId: 'n1', kind: 'open', lastBlocking: false, esc });
  assert.match(open, /<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-label="More for this question"/);
  assert.match(open, /role="menu"[^>]*hidden/);
  const labels = [...open.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(labels, ['Answer later', 'Regenerate', 'Dismiss', 'Good question', 'Bad question']);
  assert.match(questionMenuHtml({ id: 'q1', answer: null }, { nodeId: 'n1', kind: 'open', lastBlocking: true, esc }), />Dismiss and continue</);
  const answered = questionMenuHtml({ id: 'q2', answer: 'Yes' }, { nodeId: 'n1', kind: 'answered', esc });
  assert.deepEqual([...answered.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(match => match[1]), ['Change answer', 'Good question', 'Bad question']);
  assert.match(open, /data-reason-for="q1"[^>]*hidden/); assert.match(open, /What was wrong\? \(optional\)/);
  const rated = questionMenuHtml({ id: 'q3', answer: 'Yes', rating: 'bad', ratingReason: 'Leading.' }, { nodeId: 'n1', kind: 'answered', esc });
  assert.match(rated, /You rated this a bad question/); assert.match(rated, /data-q-rate=""[^>]*>Undo</);
});

test('arrow keys move around the menu and wrap; Home and End jump to the ends', async () => {
  const { menuFocusIndex } = await import('../skills/explore/assets/workspace-view.js');
  assert.equal(menuFocusIndex(0, 'ArrowDown', 5), 1);
  assert.equal(menuFocusIndex(4, 'ArrowDown', 5), 0);
  assert.equal(menuFocusIndex(0, 'ArrowUp', 5), 4);
  assert.equal(menuFocusIndex(2, 'Home', 5), 0);
  assert.equal(menuFocusIndex(2, 'End', 5), 4);
  assert.equal(menuFocusIndex(2, 'x', 5), 2);
});

test('the question sequence follows the newest batch and counts what is handled', async () => {
  const { questionSequence } = await import('../skills/explore/assets/workspace-view.js');
  const old = { id: 'q0', text: 'Earlier?', answer: 'Yes.', jobId: 'job-1' };
  const a = { id: 'q1', text: 'One?', answer: 'Done.', jobId: 'job-2' }, b = { id: 'q2', text: 'Two?', answer: null, jobId: 'job-2' }, c = { id: 'q3', text: 'Three?', answer: null, jobId: 'job-2' };
  let sequence = questionSequence({ questions: [old, a, b, c] });
  assert.deepEqual([sequence.current.id, sequence.index, sequence.total, sequence.remaining], ['q2', 2, 3, 2]);
  sequence = questionSequence({ questions: [old, a, { ...b, deferredAt: 't' }, c] });
  assert.deepEqual([sequence.current.id, sequence.index, sequence.total], ['q3', 3, 3], 'answer later advances');
  sequence = questionSequence({ questions: [old, a, { ...b, dismissedAt: 't', replacedBy: 'pending' }, c] });
  assert.equal(sequence.current.id, 'q3'); assert.equal(sequence.total, 3, 'a pending regeneration still counts');
  const replacement = { id: 'q4', text: 'Better two?', answer: null, jobId: 'job-9', replaces: 'q2' };
  sequence = questionSequence({ questions: [old, a, { ...b, dismissedAt: 't', replacedBy: 'q4' }, { ...c, answer: 'x' }, replacement] });
  assert.deepEqual([sequence.current.id, sequence.index, sequence.total], ['q4', 3, 3], 'a replacement takes its original’s place');
  sequence = questionSequence({ questions: [old, { ...a }, { ...b, answer: 'x' }, { ...c, answer: 'y' }] });
  assert.equal(sequence.current, null); assert.equal(sequence.total, 3); assert.equal(sequence.remaining, 0);
  const legacy = questionSequence({ questions: [{ id: 'l1', text: 'A?', answer: null }, { id: 'l2', text: 'B?', answer: null }] });
  assert.deepEqual([legacy.current.id, legacy.index, legacy.total], ['l1', 1, 2], 'older maps: all open questions are one batch');
});
