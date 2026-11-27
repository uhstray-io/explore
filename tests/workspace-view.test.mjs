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
