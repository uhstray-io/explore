import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { connectionLabel, connectionsHtml } from '../skills/explore/assets/workspace-view.js';

// Dependencies you add yourself (D1, #17). Illustrative fixtures under .test-output, never ideas/.
async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'links-')), 'ideas'));
  let map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('setup', map.id); // The map's own first exploration, done before the tests begin.
  map = await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Explored.', body: 'Root findings.' });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  for (const title of ['Sync', 'Battery']) map = await act({ nodeId: map.rootId, type: 'suggest', title, body: `${title} idea.` });
  const [sync, battery] = map.nodes.slice(1);
  map = await act({ nodeId: sync.id, type: 'suggest', title: 'Conflict rules', body: 'How edits merge.' });
  const rules = map.nodes.at(-1);
  return { store, map, act, sync, battery, rules };
}

test('a user can record that one idea depends on another, across branches, and it shows in growth', async () => {
  const { act, rules, battery } = await fixture();
  const saved = await act({ type: 'link', nodeId: rules.id, to: battery.id, note: 'Merging drains the battery.' });
  const edge = saved.edges.find(e => e.from === rules.id && e.to === battery.id);
  assert.deepEqual({ type: edge.type, addedBy: edge.addedBy, note: edge.note }, { type: 'depends_on', addedBy: 'user', note: 'Merging drains the battery.' });
  assert.ok(saved.growth.batches.at(-1).edges.some(e => e.from === rules.id && e.to === battery.id), 'growth history shows the new link');
  assert.ok(saved.history.some(e => e.type === 'linked' && e.nodeId === rules.id));
});

test('self-links, duplicates, contains and dependency loops are refused without saving', async () => {
  const { store, act, map, sync, battery, rules } = await fixture();
  await act({ type: 'link', nodeId: rules.id, to: battery.id });
  const before = (await store.get(map.id)).revision;
  await assert.rejects(act({ type: 'link', nodeId: rules.id, to: rules.id }), error => error.status === 400);
  await assert.rejects(act({ type: 'link', nodeId: rules.id, to: battery.id }), error => error.status === 409, 'duplicate');
  await assert.rejects(act({ type: 'link', nodeId: rules.id, to: battery.id, relation: 'contains' }), error => error.status === 400);
  await assert.rejects(act({ type: 'link', nodeId: battery.id, to: rules.id }), error => error.status === 409 && /loop/.test(error.message), 'battery → rules → battery');
  await act({ type: 'link', nodeId: battery.id, to: sync.id, relation: 'supports' });
  await assert.rejects(act({ type: 'unlink', nodeId: sync.id, to: rules.id, relation: 'contains' }), error => error.status === 400, 'containment stays');
  assert.equal((await store.get(map.id)).revision, before + 1, 'only the valid link saved');
});

test('revising the prerequisite flags the dependent; after unlinking it no longer does', async () => {
  const { store, act, map, battery, rules } = await fixture();
  await act({ type: 'activate', nodeId: rules.id });
  let job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Rules done.', body: 'Findings.' });
  await act({ type: 'activate', nodeId: battery.id });
  job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Battery so far.', body: 'Findings.', questions: ['How long are trips?'] });
  await act({ type: 'link', nodeId: rules.id, to: battery.id });
  let saved = await act({ type: 'revise', nodeId: battery.id, body: 'Batteries last a week.' });
  assert.equal(saved.nodes.find(n => n.id === rules.id).stale, true, 'the dependent is flagged');
  await act({ type: 'reaffirm', nodeId: rules.id });
  saved = await act({ type: 'unlink', nodeId: rules.id, to: battery.id, relation: 'depends_on' });
  assert.ok(!saved.edges.some(e => e.from === rules.id && e.to === battery.id)); assert.ok(saved.history.some(e => e.type === 'unlinked'));
  saved = await act({ type: 'revise', nodeId: battery.id, body: 'Batteries last two weeks.' });
  assert.equal(saved.nodes.find(n => n.id === rules.id).stale, false, 'no longer flagged through the removed link');
});

test('a link change makes work already reading either idea come back stale', async () => {
  const { store, act, map, battery, rules } = await fixture();
  await act({ type: 'activate', nodeId: rules.id });
  const job = await store.claim('agent', map.id);
  await act({ type: 'link', nodeId: rules.id, to: battery.id });
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Late findings.' });
  assert.equal(saved.jobs.find(j => j.id === job.jobId).stale, true);
});

test('connections read in the right direction, with the user\'s note and a Remove button', () => {
  const map = { nodes: [{ id: 'a', title: 'Battery' }, { id: 'b', title: 'Rules' }], edges: [{ from: 'b', to: 'a', type: 'depends_on', addedBy: 'user', note: 'Drains it.' }, { from: 'a', to: 'b', type: 'supports' }] };
  assert.equal(connectionLabel(map.edges[0], 'b'), 'Depends on'); assert.equal(connectionLabel(map.edges[0], 'a'), 'Needed by');
  assert.equal(connectionLabel(map.edges[1], 'a'), 'Supports'); assert.equal(connectionLabel(map.edges[1], 'b'), 'Supported by');
  const html = connectionsHtml(map.nodes[1], map, { esc: String, live: true });
  assert.match(html, /Depends on<strong>Battery<\/strong>/); assert.match(html, /Drains it\./);
  assert.match(html, /data-unlink data-from="b" data-to="a" data-relation="depends_on"/);
  assert.match(html, /Supported by<strong>Battery<\/strong>/);
  assert.doesNotMatch(connectionsHtml(map.nodes[1], map, { esc: String, live: false }), /data-unlink/, 'not in growth history');
});

test('linking works through the CLI and shows in node Markdown', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'links-cli-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    let map = await app.store.create({ title: 'Field notebook', idea: 'Notes.' });
    map = await app.store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'suggest', title: 'Sync', body: 'x' });
    const child = map.nodes[1], file = path.join(workspace, 'link.json');
    await writeFile(file, JSON.stringify({ expectedRevision: map.revision, nodeId: child.id, type: 'link', to: map.rootId, relation: 'related_to', note: 'Same team.' }));
    await promisify(execFile)(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), 'act', '--map', map.id, '--file', file, '--workspace', workspace]);
    const markdown = await readFile(path.join(path.dirname(app.store.file(map.id)), 'nodes', `${child.id}.md`), 'utf8');
    assert.match(markdown, /related_to .*added by the user: Same team\./);
  } finally { await app.close(); }
});

test('a link never makes a Check answers result look out of date', async () => {
  const { proposalOutdated } = await import('../skills/explore/scripts/map-jobs.mjs');
  const { store, act, map, battery, rules } = await fixture();
  const before = await store.get(map.id);
  const included = before.nodes.map(n => ({ nodeId: n.id, contentRevision: n.contentRevision }));
  const saved = await act({ type: 'link', nodeId: rules.id, to: battery.id, relation: 'related_to' });
  assert.equal(saved.nodes.find(n => n.id === rules.id).contentRevision, before.nodes.find(n => n.id === rules.id).contentRevision, 'no content changed');
  assert.ok(!proposalOutdated(saved, { included: included.filter(r => r.nodeId === rules.id).map(r => ({ ...r })) }));
  await assert.rejects(act({ type: 'link', nodeId: battery.id, to: rules.id, relation: 'related_to' }), error => error.status === 409, 'related to has no direction');
});

test('the editor keeps what was typed, opens only from the ⋯ menu, and names version history entries', async () => {
  const { linkEditorHtml, nodeMenuHtml, versionLabel } = await import('../skills/explore/assets/workspace-view.js');
  const map = { nodes: [{ id: 'a', title: 'Battery' }, { id: 'b', title: 'Rules' }], edges: [], jobs: [] };
  const drafts = { 'link-relation-b': 'supports', 'link-to-b': 'a', 'link-note-b': 'Because <power>.' };
  const html = linkEditorHtml(map.nodes[1], map, { esc: value => String(value).replace(/</g, '&lt;'), drafts, shown: true });
  assert.match(html, /<option value="supports" selected>/); assert.match(html, /<option value="a" selected>Battery/); assert.match(html, /Because &lt;power>\./);
  assert.match(linkEditorHtml(map.nodes[1], map, { esc: String }), /data-editor="link" hidden/, 'not on the main path until the menu opens it');
  assert.doesNotMatch(linkEditorHtml(map.nodes[1], map, { esc: String }), /exploring a branch/);
  assert.match(linkEditorHtml(map.nodes[1], { ...map, jobs: [{ status: 'running' }] }, { esc: String }), /exploring a branch/);
  assert.match(nodeMenuHtml(map.nodes[1], { esc: String, live: true }), /data-link-open>Add a connection/);
  assert.doesNotMatch(nodeMenuHtml(map.nodes[1], { esc: String, live: false }), /Add a connection/);
  assert.equal(versionLabel({ labels: ['linked'] }), 'Connection added'); assert.equal(versionLabel({ labels: ['unlinked'] }), 'Connection removed');
});

test('an agent link can be removed, and a removed and re-added link keeps its first growth time', async () => {
  const { store, act, map, sync, battery, rules } = await fixture();
  const { brief } = await (async () => ({ brief: (await import('../skills/explore/scripts/brief.mjs')).mapBrief }))();
  // An agent-recorded link, as a result would record it.
  await act({ type: 'activate', nodeId: sync.id });
  let job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Sync done.', body: 'F.', links: [{ to: battery.id, type: 'related_to' }] });
  let saved = await act({ type: 'unlink', nodeId: sync.id, to: battery.id, relation: 'related_to' });
  assert.ok(!saved.edges.some(e => e.from === sync.id && e.to === battery.id), 'an agent link can be removed');
  saved = await act({ type: 'link', nodeId: rules.id, to: battery.id });
  const first = saved.edges.find(e => e.from === rules.id).createdAt;
  await act({ type: 'unlink', nodeId: rules.id, to: battery.id, relation: 'depends_on' });
  saved = await act({ type: 'link', nodeId: rules.id, to: battery.id, note: 'Again.' });
  const batch = saved.growth.batches.find(b => b.edges.some(e => e.from === rules.id && e.to === battery.id));
  assert.equal(batch.at, first, 'growth history shows it at its first addition (identities are recorded once)');
  const text = JSON.stringify(brief(saved));
  assert.match(text, /added by the user: Again\./);
});

test('research saved by an earlier version, before links counted, is still current', async () => {
  const { signature, signatureMatches } = await import('../skills/explore/scripts/neighbourhood.mjs');
  const { createHash } = await import('node:crypto');
  const { contextNodes } = await import('../skills/explore/scripts/neighbourhood.mjs');
  const { map, rules } = await fixture();
  const old = createHash('sha256').update(JSON.stringify(contextNodes(map, rules).map(n => [n.id, n.contentRevision]))).digest('hex');
  assert.equal(signatureMatches(map, rules, old), true, 'an unprefixed signature is compared the old way');
  assert.equal(signatureMatches(map, rules, signature(map, rules)), true);
  assert.match(signature(map, rules), /^v2:/);
});
