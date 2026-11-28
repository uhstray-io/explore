import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { openThoughts, inboxHtml, notesHtml, sortProposalFor } from '../skills/explore/assets/inbox.js';
import { inboxDialog } from '../skills/explore/assets/inbox-dialog.js';

// Thought inbox (K8, #54). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = path.join(await mkdtemp(path.join(root, 'inbox-')), 'ideas');
  const store = new Store(dir);
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Sync is the hard part.', body: 'Details.', suggestions: [{ title: 'Storage', body: 'Local storage limits.' }] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  return { dir, store, map, act };
}
const thoughtsOf = map => map.inbox ?? [];

test('a thought can be added, edited and discarded with no agent connected, and it survives a reload', async () => {
  const { dir, store, map, act } = await setup();
  let saved = await act({ type: 'inbox-add', text: '  Volunteers forget their passwords.  ' });
  const [thought] = thoughtsOf(saved);
  assert.match(thought.id, /^thought-[0-9a-f]{8}$/); assert.equal(thought.text, 'Volunteers forget their passwords.'); assert.equal(thought.state, 'open'); assert.ok(thought.createdAt);
  saved = await act({ type: 'inbox-edit', thoughtId: thought.id, text: 'Volunteers forget their PINs.' });
  assert.equal(thoughtsOf(saved)[0].text, 'Volunteers forget their PINs.');
  await act({ type: 'inbox-add', text: 'Maybe paper backup?' });
  saved = await act({ type: 'inbox-discard', thoughtId: thought.id });
  assert.deepEqual(thoughtsOf(saved).map(item => item.state), ['discarded', 'open']); assert.equal(saved.jobs.filter(job => job.status === 'queued').length, 0, 'no work queued');
  const reloaded = await new Store(dir).get(map.id);
  assert.deepEqual(openThoughts(reloaded).map(item => item.text), ['Maybe paper backup?']);
  await assert.rejects(act({ type: 'inbox-add', text: 'x'.repeat(4001) }), /at most 4000/);
  await assert.rejects(act({ type: 'inbox-add', text: '   ' }), /required/);
  await assert.rejects(act({ type: 'inbox-edit', thoughtId: thought.id, text: 'Back?' }), error => error.status === 409);
});

async function sorted() {
  const ctx = await setup();
  const { store, map, act } = ctx;
  await act({ type: 'inbox-add', text: 'Paper backup for flat batteries.' });
  await act({ type: 'inbox-add', text: 'Check whether phones encrypt local storage.' });
  await act({ type: 'inbox-add', text: 'Lunch.' });
  const thoughts = openThoughts(await store.get(map.id)), storage = (await store.get(map.id)).nodes.find(node => node.title === 'Storage');
  const before = (await store.get(map.id)).jobs.length;
  const saved = await act({ type: 'request-map-job', jobType: 'sort-thoughts' });
  assert.equal(saved.jobs.length, before + 1, 'queued only when asked');
  const packet = await store.claim('agent', map.id);
  const placements = [{ thoughtId: thoughts[0].id, action: 'new-branch', parentId: map.rootId, title: 'Paper backup', body: 'When batteries die, notes go on paper.' },
    { thoughtId: thoughts[1].id, action: 'note', nodeId: storage.id, reason: 'It adds to the storage question.' }, { thoughtId: thoughts[2].id, action: 'unplaced', reason: 'Not about this exploration.' }];
  return { ...ctx, thoughts, storage, packet, placements };
}

test('sorting sends the open thoughts and an index of ideas, and a result must place each thought once, on ideas that exist', async () => {
  const { store, map, thoughts, packet, placements } = await sorted();
  assert.equal(packet.jobType, 'sort-thoughts'); assert.deepEqual(packet.thoughts.map(item => item.id), thoughts.map(item => item.id));
  assert.ok(packet.ideas.some(idea => idea.id === map.rootId && idea.title === 'Field notebook')); assert.equal(packet.omittedIdeas, 0);
  assert.match(packet.retrieval, /read --map/); assert.match(packet.instruction, /never activate/i);
  const before = await readFile(store.file(map.id), 'utf8');
  for (const [bad, message] of [[placements.slice(1), /exactly one placement for every thought/], [[...placements.slice(0, 2), placements[0]], /places a thought twice|exactly one placement/],
    [[{ ...placements[0], parentId: 'node-nope' }, ...placements.slice(1)], /idea that does not exist/], [[{ ...placements[1], nodeId: 'node-nope' }, placements[0], placements[2]], /idea that does not exist/],
    [[{ ...placements[0], action: 'move' }, ...placements.slice(1)], /new-branch, note or unplaced/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { placements: bad }), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const proposal = sortProposalFor(saved);
  assert.deepEqual(proposal.items.map(item => [item.action, item.review]), [['new-branch', 'unreviewed'], ['note', 'unreviewed'], ['unplaced', 'unreviewed']]);
});

test('accepting a new branch makes one inactive suggestion and one growth batch, and queues nothing', async () => {
  const { store, map, act, thoughts, packet, placements } = await sorted();
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const item = sortProposalFor(saved).items[0], nodes = saved.nodes.length, batches = saved.growth?.batches.length ?? 0, jobs = saved.jobs.length;
  saved = await act({ type: 'place-thought', proposalId: sortProposalFor(saved).id, itemId: item.id });
  const branch = saved.nodes.at(-1);
  assert.equal(saved.nodes.length, nodes + 1); assert.equal(branch.title, 'Paper backup'); assert.equal(branch.status, 'suggested'); assert.equal(branch.parentId, map.rootId);
  assert.equal(saved.growth.batches.length, batches + 1); assert.equal(saved.jobs.length, jobs, 'nothing queued');
  const thought = saved.inbox.find(entry => entry.id === thoughts[0].id);
  assert.equal(thought.state, 'placed'); assert.deepEqual(thought.placement, { action: 'new-branch', nodeId: branch.id }); assert.equal(sortProposalFor(saved).items[0].review, 'accepted');
  await assert.rejects(act({ type: 'place-thought', proposalId: sortProposalFor(saved).id, itemId: item.id }), error => error.status === 409, 'once');
});

test('accepting a note appends the thought\'s own text and changes nothing else, even on a finished branch; dismissing leaves the thought open', async () => {
  const { store, map, act, thoughts, storage, packet, placements } = await sorted();
  await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  // Finish the Storage branch first.
  await act({ type: 'activate', nodeId: storage.id });
  const run = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Limits known.', body: 'Phones cap storage.' });
  const finished = saved.nodes.find(node => node.id === storage.id);
  assert.equal(finished.status, 'explored');
  const proposal = sortProposalFor(saved);
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id });
  const noted = saved.nodes.find(node => node.id === storage.id);
  assert.deepEqual(noted.notes.map(note => [note.text, note.fromThought]), [['Check whether phones encrypt local storage.', thoughts[1].id]], 'the thought\'s own words, not the agent\'s reason');
  assert.deepEqual([noted.status, noted.body, noted.contentRevision, noted.stale, noted.completedAt], [finished.status, finished.body, finished.contentRevision, finished.stale, finished.completedAt]);
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[2].id }), error => error.status === 409 && /can only be dismissed/.test(error.message));
  saved = await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[2].id, decision: 'dismissed' });
  assert.equal(saved.inbox.find(entry => entry.id === thoughts[2].id).state, 'open', 'dismissing leaves it open');
  await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'accepted' }), /Accept to place/, 'placing goes through place-thought');
});

test('a thought edited since it was sorted cannot be placed; a later branch packet carries the idea\'s notes as user notes', async () => {
  const { store, map, act, thoughts, storage, packet, placements } = await sorted();
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const proposal = sortProposalFor(saved);
  await act({ type: 'inbox-edit', thoughtId: thoughts[0].id, text: 'Paper backup, laminated.' });
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id }), error => error.status === 409 && /changed since/.test(error.message));
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id });
  await act({ type: 'activate', nodeId: storage.id });
  const run = await store.claim('agent', map.id);
  assert.deepEqual(run.selected.userNotes, [{ text: 'Check whether phones encrypt local storage.' }]); assert.match(run.instruction, /userNotes are the user's own notes/);
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${storage.id}.md`), 'utf8');
  assert.match(markdown, /## Your notes\n\n_The user's own notes, not findings\._\n\n- Check whether phones encrypt local storage\./);
  const brief = mapBrief(await store.get(map.id));
  assert.equal(brief.counts.openThoughts, 2); assert.match(brief.markdown, /2 open thoughts in the inbox/);
});

test('maps without an inbox or notes load unchanged; malformed ones are reported', () => {
  const base = { schemaVersion: 1, id: 'map-1', title: 'T', rootId: 'root', edges: [], jobs: [], history: [], revision: 1, updatedAt: '2026-01-01' };
  const idea = (extra = {}) => ({ id: 'root', title: 'Root', kind: 'idea', status: 'explored', reviewState: 'unreviewed', summary: 'S', questions: [], sources: [], ...extra });
  assert.deepEqual(validateMap({ ...base, nodes: [idea()] }).errors, []);
  assert.ok(validateMap({ ...base, inbox: 'x', nodes: [idea()] }).errors.some(error => error.at === 'inbox'));
  assert.ok(validateMap({ ...base, nodes: [idea({ notes: [{ text: 5 }] })] }).errors.some(error => /notes/.test(error.at)));
  assert.deepEqual(openThoughts({ nodes: [] }), []);
});

test('the inbox lists open thoughts with their proposals, and the inspector shows an idea\'s notes', () => {
  const map = { nodes: [{ id: 'root', title: 'Root <a>' }, { id: 'n2', title: 'Storage' }], inbox: [{ id: 'thought-1', text: 'Paper <backup>.', state: 'open' }, { id: 'thought-2', text: 'Encrypt?', state: 'open' }, { id: 'thought-3', text: 'Gone.', state: 'discarded' }],
    proposals: [{ id: 'proposal-1', type: 'sort-thoughts', items: [{ id: 'item-1', thoughtId: 'thought-1', thoughtText: 'Paper <backup>.', action: 'new-branch', parentId: 'root', title: 'Paper', body: 'B', review: 'unreviewed' },
      { id: 'item-2', thoughtId: 'thought-2', thoughtText: 'Encrypt?', action: 'unplaced', reason: 'Not <here>.', review: 'unreviewed' }] }], jobs: [] };
  const html = inboxHtml({ map, esc, live: true, editing: null, preview: false, listening: false });
  assert.match(html, /<p class="thought-text">Paper &lt;backup&gt;\.<\/p>/); assert.doesNotMatch(html, /Gone\./);
  assert.match(html, /Your agent suggests a new branch under “Root &lt;a&gt;”: Paper/); assert.match(html, /data-place-thought="item-1" data-proposal="proposal-1">Accept<\/button>/);
  assert.match(html, /data-focus-node="root">Show “Root &lt;a&gt;”<\/button>/);
  assert.match(html, /Your agent could not place it: Not &lt;here&gt;\./); assert.doesNotMatch(html, /data-place-thought="item-2"/, 'an unplaced item can only be dismissed');
  assert.match(html, /data-dismiss-item="item-2" data-proposal="proposal-1">Dismiss<\/button>/);
  assert.match(html, /<button type="button" class="primary" data-inbox-sort="">Ask the agent where these belong<\/button>/);
  assert.match(inboxHtml({ map, esc, live: true, editing: null, preview: true, listening: false }), /Your agent will read 2 open thoughts and an index of 2 ideas/);
  assert.match(inboxHtml({ map, esc, live: true, editing: 'thought-1', preview: false, listening: false }), /<textarea id="thought-edit" maxlength="4000" rows="3">Paper &lt;backup&gt;\.<\/textarea>/);
  assert.match(notesHtml({ notes: [{ id: 'note-1', text: 'Mine <b>.' }] }, { esc }), /<h3 class="section-label">Your notes<\/h3><ul class="idea-notes"><li>Mine &lt;b&gt;\.<\/li><\/ul>/);
  assert.equal(notesHtml({}, { esc }), '');
});

// A small fake DOM for the dialog.
function fakeDialog({ map, act }) {
  const elements = new Map(), chosen = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', open: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, querySelector() { return { focus() {} }; }, reset() { this.value = ''; } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const dialog = inboxDialog({ map, act, esc, toast: () => {}, live: () => true, listening: () => false, focusNode: id => chosen.push(id) });
  const click = dataset => element('inbox-body').fire('click', { target: { closest: () => ({ dataset }) } });
  return { element, dialog, click, chosen };
}

test('the inbox dialog captures a thought, edits and discards one, previews before asking, and accepts or dismisses a proposal', async () => {
  const map = { nodes: [{ id: 'root', title: 'Root' }], inbox: [{ id: 'thought-1', text: 'Paper backup.', state: 'open' }], proposals: [{ id: 'proposal-1', type: 'sort-thoughts', items: [{ id: 'item-1', thoughtId: 'thought-1', thoughtText: 'Paper backup.', action: 'note', nodeId: 'root', reason: 'Fits.', review: 'unreviewed' }] }], jobs: [] };
  const calls = [];
  const io = fakeDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; } });
  try {
    io.element('tools-dialog').open = true;
    await io.element('inbox-open').fire('click');
    assert.equal(io.element('inbox-dialog').open, true); assert.equal(io.element('tools-dialog').open, false);
    io.element('inbox-capture-text').value = 'Volunteers forget PINs.';
    await io.element('inbox-capture').fire('submit', { preventDefault() {} });
    assert.deepEqual(calls.at(-1), [null, 'inbox-add', { text: 'Volunteers forget PINs.' }]); assert.equal(io.element('inbox-capture-text').value, '');
    await io.click({ thoughtEdit: 'thought-1' });
    io.element('thought-edit').value = 'Paper backup, laminated.';
    await io.click({ thoughtSave: 'thought-1' }); assert.deepEqual(calls.at(-1), [null, 'inbox-edit', { thoughtId: 'thought-1', text: 'Paper backup, laminated.' }]);
    await io.click({ thoughtDiscard: 'thought-1' }); assert.deepEqual(calls.at(-1), [null, 'inbox-discard', { thoughtId: 'thought-1' }]);
    const sends = calls.length;
    await io.click({ inboxSort: '' });
    assert.equal(calls.length, sends, 'the preview first; nothing queued'); assert.match(io.element('inbox-body').innerHTML, /Your agent will read/);
    await io.click({ inboxSend: '' }); assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: 'sort-thoughts' }]);
    await io.click({ placeThought: 'item-1', proposal: 'proposal-1' }); assert.deepEqual(calls.at(-1), [null, 'place-thought', { proposalId: 'proposal-1', itemId: 'item-1' }]);
    await io.click({ dismissItem: 'item-1', proposal: 'proposal-1' }); assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'dismissed' }]);
    await io.click({ focusNode: 'root' }); assert.equal(io.element('inbox-dialog').open, false); assert.deepEqual(io.chosen, ['root']);
  } finally { delete globalThis.document; }
});
