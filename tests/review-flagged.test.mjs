import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { reviewQueue } from '../skills/explore/assets/workspace-view.js';

// Root (finished) → Venue (finished) → Parking (finished). Revising Venue flags Venue and Parking.
async function finishedTree() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'review-')), 'ideas'));
  let map = await store.create({ title: 'Workshop', idea: 'Plan a workshop.' });
  const act = async (input, actor) => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, ...input }, actor ? { actor } : {}); };
  const finish = async (nodeId, extra = {}) => { await act({ type: 'activate', nodeId }).catch(() => {}); const job = await store.claim('test'); return store.complete(map.id, job.jobId, job.claimKey, { summary: `Findings for ${nodeId}.`, body: 'Done.', ...extra }); };
  let job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Root findings.', body: 'Done.', suggestions: [{ title: 'Venue', body: 'Where?' }] });
  const venue = map.nodes[1];
  map = await finish(venue.id, { suggestions: [{ title: 'Parking', body: 'Cars?' }] });
  const parking = map.nodes[2];
  map = await finish(parking.id);
  return { store, map: await store.get(map.id), act, venue, parking };
}

test('a changed premise records why each finding was flagged', async () => {
  const { store, map, act, venue, parking } = await finishedTree();
  let saved = await act({ type: 'fork-revision', nodeId: venue.id, body: 'An outdoor venue instead.' });
  for (const node of [saved.nodes.find(n => n.id === venue.id), saved.nodes.find(n => n.id === parking.id)]) {
    assert.equal(node.stale, true);
    assert.equal(node.reviewCauses.at(-1).kind, 'premise-forked'); assert.equal(node.reviewCauses.at(-1).sourceId, venue.id);
  }
  assert.ok(map);
  assert.deepEqual(reviewQueue(saved), [venue.id, parking.id], 'tree order from the root');
});

test('Still holds clears the flag, keeps the finding and makes Accept available; accepted findings go back to accepted', async () => {
  const { act, venue, parking } = await finishedTree();
  await act({ type: 'accept', nodeId: parking.id });
  await act({ type: 'fork-revision', nodeId: venue.id, body: 'Outdoor.' });
  let saved = await act({ type: 'reaffirm', nodeId: venue.id }, { name: 'Ana' });
  const node = saved.nodes.find(n => n.id === venue.id);
  assert.equal(node.stale, false); assert.equal(node.summary, `Findings for ${venue.id}.`); assert.ok(node.reaffirmedAt);
  assert.deepEqual(node.resolvedBy, { name: 'Ana' }); assert.equal(node.reviewCauses, undefined);
  saved = await act({ type: 'accept', nodeId: venue.id });
  assert.equal(saved.nodes.find(n => n.id === venue.id).reviewState, 'accepted');
  saved = await act({ type: 'reaffirm', nodeId: parking.id });
  const p = saved.nodes.find(n => n.id === parking.id);
  assert.equal(p.reviewState, 'accepted'); assert.equal(p.stale, false);
});

test('No longer relevant keeps the finding but stops relying on it', async () => {
  const { act, venue, map } = await finishedTree();
  await act({ type: 'fork-revision', nodeId: venue.id, body: 'Outdoor.' });
  const saved = await act({ type: 'clear-finding', nodeId: venue.id });
  const node = saved.nodes.find(n => n.id === venue.id);
  assert.equal(node.reviewState, 'cleared'); assert.equal(node.stale, false); assert.ok(node.clearedAt);
  assert.equal(node.summary, `Findings for ${venue.id}.`);
  const brief = mapBrief(saved);
  assert.ok(!brief.sections.find(s => s.id === 'findings').items.some(item => item.nodeId === venue.id));
  assert.ok(brief.sections.find(s => s.id === 'cleared').items.some(item => item.nodeId === venue.id));
  assert.match(brief.markdown, /Cleared findings — not relied on/);
  assert.ok(map);
});

test('Re-explore on a finished finding starts a changed-premise branch and marks the original replaced', async () => {
  const { act, venue } = await finishedTree();
  await act({ type: 'fork-revision', nodeId: venue.id, body: 'Outdoor.' });
  const saved = await act({ type: 'fork-revision', nodeId: venue.id, body: 'Indoor after all, but bigger.', resolveReview: true, start: true });
  const original = saved.nodes.find(n => n.id === venue.id), child = saved.nodes.at(-1);
  assert.equal(child.status, 'queued');
  assert.equal(original.reviewState, 'cleared'); assert.equal(original.replacedBy, child.id); assert.equal(original.stale, false);
});

test('only a flagged finding can be reaffirmed or cleared', async () => {
  const { store, act, venue, map } = await finishedTree();
  const before = await readFile(store.file(map.id), 'utf8');
  await assert.rejects(act({ type: 'reaffirm', nodeId: venue.id }), error => error.status === 409);
  await assert.rejects(act({ type: 'clear-finding', nodeId: venue.id }), error => error.status === 409);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('a late result and a changed answer also record their cause; older flags say none was recorded', async () => {
  const { store, act, venue, map } = await finishedTree();
  await act({ type: 'suggest', nodeId: venue.id, title: 'Catering', body: 'Food?' });
  const catering = (await store.get(map.id)).nodes.at(-1);
  await act({ type: 'activate', nodeId: catering.id });
  const job = await store.claim('test');
  await act({ type: 'revise', nodeId: catering.id, body: 'Just drinks.' });
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Built on food.' });
  assert.equal(saved.nodes.find(n => n.id === catering.id).reviewCauses.at(-1).kind, 'result-during-change');
  const legacy = await store.get(map.id);
  legacy.nodes[0].stale = true; delete legacy.nodes[0].reviewCauses;
  const { reviewStepHtml } = await import('../skills/explore/assets/workspace-view.js');
  const html = reviewStepHtml({ map: legacy, nodeId: legacy.nodes[0].id, index: 0, total: 1, esc: String });
  assert.match(html, /Flagged before causes were recorded/);
});

test('the review step names what changed and offers the three choices in order', async () => {
  const { act, venue } = await finishedTree();
  const saved = await act({ type: 'fork-revision', nodeId: venue.id, body: 'Outdoor.' });
  const { reviewStepHtml } = await import('../skills/explore/assets/workspace-view.js');
  const html = reviewStepHtml({ map: saved, nodeId: venue.id, index: 1, total: 2, esc: String });
  assert.match(html, /Item 2 of 2/);
  assert.match(html, /explored with a changed premise/);
  assert.match(html, /data-select="[^"]+"/);
  const order = [...html.matchAll(/data-resolve="([a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(order, ['reaffirm', 'reexplore', 'clear']);
});
