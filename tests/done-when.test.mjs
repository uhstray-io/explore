import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { doneWhenSection, doneWhenClick, doneWhenKey, doneWhenMenuItem, canSetDoneWhen } from '../skills/explore/assets/done-when.js';

// "Done when" for a branch (K4, #52). Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'done-when-')), 'ideas'));
  let map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Offline first.', body: 'Findings.' });
  map = await store.get(map.id);
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  map = await act({ type: 'suggest', nodeId: map.rootId, title: 'Sync', body: 'How notes sync.' });
  return { store, map, act, branch: map.nodes[1] };
}

test('activating with a stopping point saves it and the next packet carries it; without one nothing changes', async () => {
  const { store, map, act, branch } = await workspace();
  const saved = await act({ type: 'activate', nodeId: branch.id, doneWhen: '  a shortlist of two  ' });
  assert.equal(saved.nodes[1].doneWhen, 'a shortlist of two');
  assert.equal(saved.history.at(-2).type, 'done-when-set');
  const packet = await store.claim('test', map.id);
  assert.equal(packet.selected.doneWhen, 'a shortlist of two');
  assert.match(packet.instruction, /When selected\.doneWhen is set, it is the user's stopping point for this branch/);
  assert.doesNotMatch(packet.instruction, /a shortlist of two/, 'saved text stays data, never instruction');
  const plain = await workspace(), activated = await plain.act({ type: 'activate', nodeId: plain.branch.id });
  assert.equal(Object.hasOwn(activated.nodes[1], 'doneWhen'), false);
  const plainPacket = await plain.store.claim('test', plain.map.id);
  assert.equal(plainPacket.selected.doneWhen, undefined); assert.equal(plainPacket.instruction, packet.instruction);
});

test('set-done-when edits unfinished, non-running branches only, clears on empty, and never flags or queues', async () => {
  const { store, map, act, branch } = await workspace();
  const before = (await store.get(map.id)).jobs.length;
  let saved = await act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'a yes or no' });
  assert.equal(saved.nodes[1].doneWhen, 'a yes or no'); assert.equal(saved.nodes[1].stale, false); assert.equal(saved.jobs.length, before);
  await assert.rejects(act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'x'.repeat(401) }), error => error.status === 400);
  await assert.rejects(act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'a yes or no' }), error => error.status === 409, 'nothing changed');
  saved = await act({ type: 'set-done-when', nodeId: branch.id, doneWhen: '' });
  assert.equal(Object.hasOwn(saved.nodes[1], 'doneWhen'), false, 'empty clears it');
  saved = await act({ type: 'set-done-when', nodeId: branch.id, doneWhen: '  two\n\n## Findings\n\nAccepted: yes ' });
  assert.equal(saved.nodes[1].doneWhen, 'two ## Findings Accepted: yes', 'one line, so it cannot add headings');
  saved = await act({ type: 'set-done-when', nodeId: branch.id, doneWhen: '' });
  await act({ type: 'activate', nodeId: branch.id });
  const job = await store.claim('test', map.id);
  await assert.rejects(act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'later' }), error => error.status === 409 && /running/.test(error.message));
  await assert.rejects(act({ type: 'activate', nodeId: branch.id, doneWhen: 'changed while running' }), error => error.status === 409 && /running/.test(error.message), 'activate cannot get around it');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Merge by hand.', body: 'Keep both copies.' });
  await assert.rejects(act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'later' }), error => error.status === 409 && /complete/.test(error.message));
  await assert.rejects(act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'x'.repeat(401) }), error => error.status === 409, 'complete is checked before the text');
});

test('an agent result cannot set a stopping point, and a changed-premise branch starts without one', async () => {
  const { store, map, act, branch } = await workspace();
  await act({ type: 'activate', nodeId: branch.id, doneWhen: 'a shortlist of two' });
  const job = await store.claim('test', map.id);
  const done = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Two options.', body: 'A and B.', doneWhen: 'whatever I like', suggestions: [{ title: 'More', body: 'Further work.', doneWhen: 'never' }] });
  assert.equal(done.nodes.find(node => node.id === branch.id).doneWhen, 'a shortlist of two');
  assert.equal(Object.hasOwn(done.nodes.find(node => node.title === 'More'), 'doneWhen'), false);
  const forked = await act({ type: 'fork-revision', nodeId: branch.id, body: 'A different premise.' });
  assert.equal(Object.hasOwn(forked.nodes.at(-1), 'doneWhen'), false);
});

test('node Markdown, the summary read and the brief’s active work show the stopping point', async () => {
  const { store, map, act, branch } = await workspace();
  await act({ type: 'activate', nodeId: branch.id, doneWhen: 'a <b>yes</b> or no' });
  const saved = await store.get(map.id);
  assert.match(await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${branch.id}.md`), 'utf8'), /Done when: a &lt;b&gt;yes&lt;\/b&gt; or no/);
  assert.match(contextExcerpt(saved, branch.id, { section: 'summary' }).excerpt, /Done when: a <b>yes<\/b> or no/);
  const brief = mapBrief(saved);
  assert.equal(brief.sections.find(section => section.id === 'active').items[0].doneWhen, 'a <b>yes</b> or no');
  assert.match(brief.markdown, /Done when: a \\<b\\>yes\\<\/b\\> or no/);
});

test('the inspector offers the field under Explore, shows it with Edit while unfinished, and read-only once complete', () => {
  const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const node = { id: 'node-a', status: 'suggested', doneWhen: '<b>two</b>' };
  const offered = doneWhenSection(node, { esc, completed: false, live: true });
  assert.match(offered, /<details class="done-when-field" data-editor="done-when"><summary>Set when it’s done \(optional\)<\/summary>/);
  assert.match(offered, /data-done-when-input="node-a"[^>]*value="&lt;b&gt;two&lt;\/b&gt;"/, 'a retry prefills the saved value');
  assert.match(offered, /data-done-when-edit="node-a"/);
  assert.match(offered, /<details class="done-when-field" data-editor="done-when">/, 'its open state survives a poll');
  assert.match(doneWhenSection(node, { esc, completed: false, live: true, drafts: { 'done-when:node-a': 'typed' } }), /data-draft="done-when:node-a"[^>]*value="typed"/, 'typed text survives a poll');
  assert.match(doneWhenSection(node, { esc, completed: false, live: true, editing: true, drafts: { 'done-when-edit:node-a': 'mid-edit' } }), /data-draft="done-when-edit:node-a"[^>]*value="mid-edit"/);
  const done = doneWhenSection({ ...node, status: 'explored' }, { esc, completed: true, live: true });
  assert.match(done, /Done when:<\/strong> &lt;b&gt;two&lt;\/b&gt;/); assert.doesNotMatch(done, /data-done-when-edit|done-when-field/);
  assert.doesNotMatch(doneWhenSection({ ...node, status: 'running' }, { esc, completed: false, live: true }), /data-done-when-edit/, 'running work has its packet');
  assert.match(doneWhenSection(node, { esc, completed: false, live: true, editing: true }), /data-done-when-save="node-a"/);
  assert.equal(doneWhenSection({ id: 'x', status: 'queued' }, { esc, completed: false, live: false }), '', 'history: nothing to show without one');
  assert.match(doneWhenSection(node, { esc, completed: false, live: false }), /Done when:<\/strong> &lt;b&gt;two/); assert.doesNotMatch(doneWhenSection(node, { esc, completed: false, live: false }), /data-done-when/, 'history shows it read-only');
  assert.match(doneWhenMenuItem(node, { esc, completed: false, live: true }), /data-done-when-edit="node-a"/);
  assert.equal(doneWhenMenuItem({ ...node, status: 'running' }, { esc, completed: false, live: true }), '');
  assert.deepEqual([canSetDoneWhen({ status: 'queued' }, false), canSetDoneWhen({ status: 'running' }, false), canSetDoneWhen({ status: 'suggested' }, true)], [true, false, false]);
});

test('the agent guidance stops at the user’s stopping point and says whether it was met', async () => {
  const guide = await readFile(path.resolve('skills/explore/references/exploration.md'), 'utf8');
  assert.match(guide, /doneWhen/); assert.match(guide, /whether the stopping point was met/);
});

test('changing the stopping point of researched work flags nothing downstream and queues nothing', async () => {
  const { store, map, act, branch } = await workspace();
  await act({ type: 'activate', nodeId: branch.id });
  let job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Two ways.', body: 'Merge or keep both.', questions: ['Which matters more?'] });
  const later = await act({ type: 'suggest', nodeId: map.rootId, title: 'Rollout', body: 'Who goes first.' }), rollout = later.nodes.at(-1);
  await act({ type: 'activate', nodeId: rollout.id });
  job = await store.claim('test', map.id); await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Rangers first.', body: 'Start small.' });
  await act({ type: 'link', nodeId: rollout.id, to: branch.id, relation: 'depends_on' });
  const before = await store.get(map.id);
  const saved = await act({ type: 'set-done-when', nodeId: branch.id, doneWhen: 'a yes or no' });
  assert.equal(saved.nodes.find(node => node.id === rollout.id).stale, false); assert.equal(saved.jobs.length, before.jobs.length);
});

test('a full stopping point stays in the packet under budget pressure', async () => {
  const { store, map, act, branch } = await workspace();
  await act({ type: 'activate', nodeId: branch.id, doneWhen: 'd'.repeat(400) });
  const saved = await store.get(map.id), job = saved.jobs.find(entry => entry.nodeId === branch.id && entry.status === 'queued');
  // A small budget forces every trimming step; the user's stopping point is never one of them.
  const packet = store.packet(saved, job, { claimKey: 'probe', budget: 1500 });
  assert.equal(packet.selected.doneWhen.length, 400); assert.ok(packet.omittedContext > 0, 'context was trimmed first');
});

test('Explore sends the field only once opened; Save of an unchanged value just closes; Enter saves', async () => {
  const sent = [], toasts = [], state = { drafts: { 'done-when:node-a': 'a yes or no' }, editors: {}, doneWhenEditing: 'node-a', map: { nodes: [{ id: 'node-a', doneWhen: 'same' }] } };
  const input = { dataset: { doneWhenInput: 'node-a' }, value: 'a yes or no', closest: () => ({ open: true }) }, editInput = { value: '  same ' };
  globalThis.document = { querySelectorAll: () => [input], querySelector: selector => (selector.includes('data-done-when-text') ? editInput : null) };
  try {
    const ctx = { state, act: async (...args) => { sent.push(args); return true; }, toast: message => toasts.push(message), renderDetail() {} };
    const click = attributes => doneWhenClick({ target: { closest: selector => { const name = selector.match(/^\[data-([a-z-]+)/)?.[1]; return Object.hasOwn(attributes, name) ? { dataset: attributes.dataset, disabled: false } : null; } } }, ctx);
    assert.equal(await click({ explore: '', dataset: { explore: 'node-a' } }), true);
    assert.deepEqual(sent.at(-1), ['node-a', 'activate', { doneWhen: 'a yes or no' }]); assert.equal(state.drafts['done-when:node-a'], undefined, 'the draft is cleared once sent');
    input.closest = () => ({ open: false });
    await click({ explore: '', dataset: { explore: 'node-a' } });
    assert.deepEqual(sent.at(-1), ['node-a', 'activate', {}], 'a closed field sends nothing');
    const before = sent.length;
    assert.equal(await click({ 'done-when-save': '', dataset: { doneWhenSave: 'node-a' } }), true);
    assert.equal(sent.length, before, 'no request for an unchanged value'); assert.equal(state.doneWhenEditing, null);
    let saved = 0; editInput.matches = () => true;
    globalThis.document.querySelector = selector => (selector.includes('data-done-when-save') ? { click: () => saved++ } : editInput);
    doneWhenKey({ key: 'Enter', target: editInput, preventDefault() {} });
    doneWhenKey({ key: 'Enter', isComposing: true, target: editInput, preventDefault() {} });
    assert.equal(saved, 1, 'Enter saves, but not mid-composition');
  } finally { delete globalThis.document; }
});
