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
