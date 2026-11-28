import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { inboxJobTypes, noteLines } from '../skills/explore/scripts/inbox.mjs';
import { restoreSummary, versionLabel } from '../skills/explore/assets/workspace-view.js';
import { openThoughts, inboxHtml, notesHtml, proposalItemFor, previewText, textKey, SORT_THOUGHTS } from '../skills/explore/assets/inbox.js';
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
  const act = async (input, options) => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input }, options);
  const rewrite = async change => { const raw = JSON.parse(await readFile(store.file(map.id), 'utf8')); change(raw); await writeFile(store.file(map.id), JSON.stringify(raw)); };
  return { dir, store, map, act, rewrite };
}
const sortsOf = map => (map.proposals ?? []).filter(proposal => proposal.type === SORT_THOUGHTS);

test('a thought can be added, edited and discarded with no agent connected, and it survives a reload', async () => {
  const { dir, store, map, act, rewrite } = await setup();
  let saved = await act({ type: 'inbox-add', text: '  Volunteers forget their passwords.  ' });
  const [thought] = saved.inbox;
  assert.match(thought.id, /^thought-[0-9a-f]{8}$/); assert.equal(thought.text, 'Volunteers forget their passwords.'); assert.equal(thought.state, 'open'); assert.ok(thought.createdAt);
  saved = await act({ type: 'inbox-edit', thoughtId: thought.id, text: 'Volunteers forget their PINs.' });
  assert.equal(saved.inbox[0].text, 'Volunteers forget their PINs.');
  await act({ type: 'inbox-add', text: 'Maybe paper backup?' });
  saved = await act({ type: 'inbox-discard', thoughtId: thought.id });
  assert.deepEqual(saved.inbox.map(item => item.state), ['discarded', 'open']); assert.ok(saved.inbox[0].discardedAt); assert.equal(saved.jobs.filter(job => job.status === 'queued').length, 0, 'no work queued');
  assert.deepEqual(openThoughts(await new Store(dir).get(map.id)).map(item => item.text), ['Maybe paper backup?']);
  await assert.rejects(act({ type: 'inbox-add', text: 'x'.repeat(4001) }), /at most 4000/);
  await assert.rejects(act({ type: 'inbox-add', text: '   ' }), /required/);
  await assert.rejects(act({ type: 'inbox-edit', thoughtId: thought.id, text: 'Back?' }), error => error.status === 409);
  await rewrite(raw => { raw.inbox = Array.from({ length: 200 }, (_, i) => ({ id: `thought-${String(i).padStart(8, '0')}`, text: `T${i}`, createdAt: '2026-01-01T00:00:00.000Z', state: 'open' })); });
  await assert.rejects(act({ type: 'inbox-add', text: 'One more.' }), error => error.status === 409 && /at most 200 open/.test(error.message));
});

test('Undo and restore include the inbox, a placed note included, and history names each change', async () => {
  const { store, map, act } = await setup();
  let saved = await act({ type: 'inbox-add', text: 'Paper backup.' });
  let versions = (await store.versions.list(map.id)).versions;
  assert.equal(versions[0].labels[0], 'thought-added');
  saved = await act({ type: 'restore-version', version: versions[1].id, undo: true });
  assert.deepEqual(saved.inbox, [], 'Undo takes the thought back out');
  saved = await act({ type: 'inbox-add', text: 'Encrypt local storage?' });
  const storage = saved.nodes.find(node => node.title === 'Storage');
  await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  const packet = await store.claim('agent', map.id);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements: [{ thoughtId: saved.inbox[0].id, action: 'note', nodeId: storage.id, reason: 'Fits.' }] });
  const [proposal] = sortsOf(saved);
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id });
  assert.equal(saved.nodes.find(node => node.id === storage.id).notes.length, 1);
  versions = (await store.versions.list(map.id)).versions;
  saved = await act({ type: 'restore-version', version: versions[1].id, undo: true });
  assert.equal(saved.nodes.find(node => node.id === storage.id).notes, undefined, 'Undo takes the note off');
  assert.equal(saved.inbox[0].state, 'open', 'and the thought is open again, never lost');
  assert.equal(saved.proposals.at(-1).items[0].review, 'unreviewed', 'and its suggestion waits again');
  saved = await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'dismissed' });
  versions = (await store.versions.list(map.id)).versions;
  saved = await act({ type: 'restore-version', version: versions[1].id, undo: true });
  assert.equal(saved.proposals.at(-1).items[0].review, 'unreviewed', 'Undo after a Dismiss brings the suggestion back');
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0, termsChanged: 0, thoughtsChanged: 1 }, reopened: [] }), /^Restoring changes the inbox\./);
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0, termsChanged: 0, reviewsChanged: 1 }, reopened: [] }), /^Restoring changes agents' suggestions or your reviews of them\./);
  assert.deepEqual(['thought-added', 'thought-edited', 'thought-discarded', 'thought-placed'].map(label => versionLabel({ labels: [label] })), ['Thought added to the inbox', 'Thought edited', 'Thought discarded', 'Thought placed']);
});

async function sorted() {
  const ctx = await setup();
  const { store, map, act } = ctx;
  await act({ type: 'inbox-add', text: 'Paper backup for flat batteries.' });
  await act({ type: 'inbox-add', text: 'Check whether phones encrypt local storage.' });
  await act({ type: 'inbox-add', text: 'Lunch.' });
  const thoughts = openThoughts(await store.get(map.id)), storage = (await store.get(map.id)).nodes.find(node => node.title === 'Storage');
  const before = (await store.get(map.id)).jobs.length;
  const saved = await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  assert.equal(saved.jobs.length, before + 1, 'queued only when asked');
  const packet = await store.claim('agent', map.id);
  const placements = [{ thoughtId: thoughts[0].id, action: 'new-branch', parentId: map.rootId, title: 'Paper backup', body: 'When batteries die, notes go on paper.' },
    { thoughtId: thoughts[1].id, action: 'note', nodeId: storage.id, reason: 'It adds to the storage question.' }, { thoughtId: thoughts[2].id, action: 'unplaced', reason: 'Not about this exploration.' }];
  return { ...ctx, thoughts, storage, packet, placements };
}

test('sorting sends the open thoughts and an index of ideas; the job keeps which it sent and a key of each, never the words', async () => {
  const { store, map, thoughts, packet, placements } = await sorted();
  assert.equal(packet.jobType, SORT_THOUGHTS); assert.deepEqual(packet.thoughts, thoughts.map(({ id, text }) => ({ id, text })));
  assert.equal(packet.remainingThoughts, 0); assert.ok(packet.ideas.some(idea => idea.id === map.rootId && idea.title === 'Field notebook' && idea.completed === true)); assert.equal(packet.omittedIdeas, 0);
  const raw = await store.get(map.id), finishedNotExplored = { ...raw.nodes.find(node => node.title === 'Storage'), status: 'interrupted', completedAt: '2026-01-01T00:00:00.000Z' };
  const index = inboxJobTypes[SORT_THOUGHTS].packet({ map: { ...raw, nodes: raw.nodes.map(node => (node.id === finishedNotExplored.id ? finishedNotExplored : node)) }, budget: 15500 }).ideas;
  assert.equal(index.find(idea => idea.id === finishedNotExplored.id).completed, true, 'complete by the Store\'s rule, not only when explored');
  assert.match(packet.retrieval, /read --map/); assert.match(packet.instruction, /never activate/i);
  const job = (await store.get(map.id)).jobs.find(item => item.id === packet.jobId);
  assert.deepEqual(job.included, thoughts.map(thought => ({ thoughtId: thought.id, textKey: textKey(thought.text) })));
  assert.deepEqual(job.input, {}); assert.equal(JSON.stringify(job).includes('flat batteries'), false, 'no third copy of the words');
  const before = await readFile(store.file(map.id), 'utf8');
  for (const [bad, message] of [[placements.slice(1), /exactly one placement for every thought/], [[...placements.slice(0, 2), placements[0]], /places a thought twice|exactly one placement/],
    [[{ ...placements[0], parentId: 'node-nope' }, ...placements.slice(1)], /idea that does not exist/], [[{ ...placements[1], nodeId: 'node-nope' }, placements[0], placements[2]], /idea that does not exist/],
    [[{ ...placements[0], action: 'move' }, ...placements.slice(1)], /new-branch, note or unplaced/], [[{ ...placements[0], kind: 'idea' }, ...placements.slice(1)], /research or hypothesis/],
    [[{ ...placements[1], title: 'Extra' }, placements[0], placements[2]], /does not take: title/], [[{ ...placements[0], title: 'Storage' }, ...placements.slice(1)], /already a direction under that idea; propose a note/],
    [[{ ...placements[0], test: 'Try it.' }, ...placements.slice(1)], /only a hypothesis carries a test/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { placements: bad }), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const [proposal] = sortsOf(saved);
  assert.deepEqual(proposal.items.map(item => [item.action, item.review, item.textKey]), [['new-branch', 'unreviewed', textKey(thoughts[0].text)], ['note', 'unreviewed', textKey(thoughts[1].text)], ['unplaced', 'unreviewed', textKey(thoughts[2].text)]]);
  assert.equal(Object.hasOwn(proposal, 'stale'), false); assert.equal(store.view(saved).proposals.at(-1).stale, false, 'a sort is never outdated by Check answers\' rule');
});

test('the agent reads the thoughts as they are when it takes the work: edits count, discarded ones go, and none left fails the job', async () => {
  const { store, map, act } = await setup();
  let saved = await act({ type: 'inbox-add', text: 'Salary figures, private.' });
  saved = await act({ type: 'inbox-add', text: 'Paper backup.' });
  const [secret, paper] = saved.inbox;
  await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  await act({ type: 'inbox-discard', thoughtId: secret.id });
  await act({ type: 'inbox-edit', thoughtId: paper.id, text: 'Paper backup, laminated.' });
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.thoughts, [{ id: paper.id, text: 'Paper backup, laminated.' }], 'the discarded thought is never sent; the edit is');
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements: [{ thoughtId: paper.id, action: 'new-branch', parentId: map.rootId, title: 'Paper backup', body: 'Laminated paper.' }] });
  assert.notEqual(store.view(saved).jobs.find(job => job.id === packet.jobId).stale, true, 'current when nothing it read changed');
  const [proposal] = sortsOf(saved);
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id });
  assert.equal(saved.inbox.find(item => item.id === paper.id).state, 'placed', 'what the agent read can be placed');
  // A thought edited while the agent worked: the result is kept, marked stale.
  await act({ type: 'inbox-add', text: 'Encrypt?' });
  await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  const running = await store.claim('agent', map.id), encrypt = (await store.get(map.id)).inbox.at(-1);
  await act({ type: 'inbox-edit', thoughtId: encrypt.id, text: 'Encrypt local storage?' });
  saved = await store.complete(map.id, running.jobId, running.claimKey, { placements: [{ thoughtId: encrypt.id, action: 'unplaced', reason: 'Unclear.' }] });
  assert.equal(store.view(saved).jobs.find(job => job.id === running.jobId).stale, true, 'stale once a thought it read changed');
  await act({ type: 'inbox-discard', thoughtId: encrypt.id });
  await act({ type: 'inbox-add', text: 'Gone soon.' });
  await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  await act({ type: 'inbox-discard', thoughtId: (await store.get(map.id)).inbox.at(-1).id });
  assert.equal(await store.claim('agent', map.id), null, 'nothing to hand out');
  const failed = (await store.get(map.id)).jobs.at(-1);
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /No open thoughts are left to sort/);
  assert.match(inboxHtml({ map: { ...(await store.get(map.id)), inbox: [{ id: 'thought-x', text: 'New.', state: 'open' }] }, esc, live: true, listening: false }), /Your agent could not sort these thoughts\. No open thoughts are left to sort/);
  await assert.rejects(act({ type: 'request-map-job', jobType: SORT_THOUGHTS }), error => error.status === 409 && /no open thoughts/.test(error.message));
});

test('long thoughts are sent whole as far as they fit; the idea index takes the rest in one pass', async () => {
  const { store, map, act, rewrite } = await setup();
  await rewrite(raw => { raw.inbox = Array.from({ length: 4 }, (_, i) => ({ id: `thought-0000000${i}`, text: `${i}${'x'.repeat(3999)}`, createdAt: '2026-01-01T00:00:00.000Z', state: 'open' })); });
  await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
  let packet = await store.claim('agent', map.id);
  assert.ok(packet.contextCharacters <= 15500); assert.ok(packet.thoughts.length >= 1 && packet.thoughts.every(thought => thought.text.length === 4000), 'whole thoughts only');
  assert.equal(packet.remainingThoughts, 4 - packet.thoughts.length);
  await store.fail(map.id, packet.jobId, packet.claimKey, 'Stopped for the test.');
  // Many ideas: the index is cut once, to exactly what fits.
  await rewrite(raw => {
    raw.inbox = Array.from({ length: 20 }, (_, i) => ({ id: `thought-${String(i).padStart(8, '0')}`, text: `Thought ${i} ${'y'.repeat(680)}`, createdAt: '2026-01-01T00:00:00.000Z', state: 'open' }));
    for (let i = 0; i < 400; i++) raw.nodes.push({ id: `node-${String(i).padStart(8, '0')}`, title: `Idea ${i}`, kind: 'research', status: 'suggested', reviewState: 'unreviewed', summary: 's'.repeat(i % 180), prompt: 'p', body: 'p', parentId: raw.rootId, questions: [], sources: [], contentRevision: 1, stale: false, createdAt: '2026-01-01T00:00:00.000Z' });
  });
  const saved = await store.get(map.id), budget = 15500 - 800;
  packet = inboxJobTypes[SORT_THOUGHTS].packet({ map: saved, budget: 15500 });
  assert.ok(packet.omittedIdeas > 0 && packet.ideas.length > 1);
  assert.ok(JSON.stringify(packet).length <= budget, 'it fits');
  packet.ideas.push({ id: 'one-more', title: 'x', kind: 'research', status: 'suggested', completed: false, summary: '' });
  const naive = inboxJobTypes[SORT_THOUGHTS].packet({ map: { ...saved, nodes: saved.nodes.slice(0, saved.nodes.length - packet.omittedIdeas) }, budget: 1e9 }).ideas.length;
  assert.equal(packet.ideas.length - 1, naive, 'the same ideas as cutting one at a time would keep');
});

test('thoughts never sorted go first, so every thought gets its turn; a dismissed suggestion never brings back an older one', async () => {
  const { store, map, act, rewrite } = await setup();
  await rewrite(raw => { raw.inbox = Array.from({ length: 25 }, (_, i) => ({ id: `thought-${String(i).padStart(8, '0')}`, text: `Thought ${i}.`, createdAt: '2026-01-01T00:00:00.000Z', state: 'open' })); });
  const round = async () => {
    await act({ type: 'request-map-job', jobType: SORT_THOUGHTS });
    const packet = await store.claim('agent', map.id);
    const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements: packet.thoughts.map(thought => ({ thoughtId: thought.id, action: 'unplaced', reason: 'Not sure.' })) });
    return { packet, proposal: sortsOf(saved).at(-1) };
  };
  const first = await round();
  assert.deepEqual(first.packet.thoughts.map(thought => thought.text), Array.from({ length: 20 }, (_, i) => `Thought ${i}.`));
  const second = await round();
  assert.deepEqual(second.packet.thoughts.map(thought => thought.text), ['Thought 20.', 'Thought 21.', 'Thought 22.', 'Thought 23.', 'Thought 24.'], 'only those never sorted: a suggestion still waiting is never replaced');
  await assert.rejects(act({ type: 'request-map-job', jobType: SORT_THOUGHTS }), error => error.status === 409 && /suggestion waiting/.test(error.message), 'nothing left to sort');
  // A thought edited since its suggestion goes again; dismissing the newer suggestion never brings back the older one.
  const thought = (await store.get(map.id)).inbox[0];
  await act({ type: 'inbox-edit', thoughtId: thought.id, text: 'Thought 0, edited.' });
  const third = await round();
  assert.deepEqual(third.packet.thoughts.map(entry => entry.id), [thought.id]);
  assert.ok(first.proposal.items.some(entry => entry.thoughtId === thought.id && entry.review === 'unreviewed'), 'an older suggestion still waits');
  const item = third.proposal.items[0];
  await act({ type: 'review-proposal', proposalId: third.proposal.id, itemId: item.id, decision: 'dismissed' });
  assert.equal(proposalItemFor(await store.get(map.id), (await store.get(map.id)).inbox[0]), null, 'no older suggestion comes back');
  await assert.rejects(act({ type: 'review-proposal', proposalId: third.proposal.id, itemId: item.id, decision: 'dismissed' }), error => error.status === 409, 'reviewed once');
});

test('accepting a new branch makes one inactive suggestion as Add a direction does, and refuses a title the idea already has', async () => {
  const { store, map, act, thoughts, packet, placements } = await sorted();
  const twice = [{ ...placements[0], kind: 'hypothesis', test: 'Leave a phone flat for a day.' }, { thoughtId: placements[1].thoughtId, action: 'new-branch', parentId: map.rootId, title: 'paper backup', body: 'Again.' }, placements[2]];
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { placements: twice }), /another placement already proposes "paper backup"/, 'one title once per result');
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements: [twice[0], { ...twice[1], title: 'Encrypted backup' }, placements[2]] });
  const [proposal] = sortsOf(saved), nodes = saved.nodes.length, batches = saved.growth?.batches.length ?? 0, jobs = saved.jobs.length;
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id }, { actor: { name: 'Sam' } });
  const branch = saved.nodes.at(-1);
  assert.equal(saved.nodes.length, nodes + 1); assert.deepEqual([branch.title, branch.status, branch.parentId, branch.kind], ['Paper backup', 'suggested', map.rootId, 'hypothesis']);
  assert.equal(branch.hypothesis.test, 'Leave a phone flat for a day.', 'the hypothesis says how to test it');
  assert.equal(saved.growth.batches.length, batches + 1); assert.equal(saved.jobs.length, jobs, 'nothing queued');
  const thought = saved.inbox.find(entry => entry.id === thoughts[0].id);
  assert.equal(thought.state, 'placed'); assert.deepEqual(thought.placement, { action: 'new-branch', nodeId: branch.id });
  assert.deepEqual([sortsOf(saved)[0].items[0].review, sortsOf(saved)[0].items[0].reviewedBy], ['accepted', { name: 'Sam' }]);
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id }), error => error.status === 409, 'once');
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Encrypted backup', body: 'Added by hand meanwhile.' });
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id }), error => error.status === 409 && /already a direction/.test(error.message), 'no duplicate siblings, even when the title arrived since');
  await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'dismissed' }), error => error.status === 409, 'an accepted suggestion is never dismissed after');
});

test('accepting a note appends the thought\'s own text and changes nothing else, even on a finished branch; dismissing leaves the thought open', async () => {
  const { store, map, act, thoughts, storage, packet, placements } = await sorted();
  await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  await act({ type: 'activate', nodeId: storage.id });
  const run = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Limits known.', body: 'Phones cap storage.' });
  const finished = saved.nodes.find(node => node.id === storage.id);
  assert.equal(finished.status, 'explored');
  const [proposal] = sortsOf(saved);
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id });
  const noted = saved.nodes.find(node => node.id === storage.id);
  assert.deepEqual(noted.notes.map(note => [note.text, note.fromThought]), [['Check whether phones encrypt local storage.', thoughts[1].id]], 'the thought\'s own words, not the agent\'s reason');
  assert.deepEqual([noted.status, noted.body, noted.contentRevision, noted.stale, noted.completedAt], [finished.status, finished.body, finished.contentRevision, finished.stale, finished.completedAt]);
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[2].id }), error => error.status === 409 && /can only be dismissed/.test(error.message));
  saved = await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[2].id, decision: 'dismissed' });
  assert.equal(saved.inbox.find(entry => entry.id === thoughts[2].id).state, 'open', 'dismissing leaves it open');
  await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'accepted' }), /Accept to place/, 'placing goes through place-thought');
});

test('a thought edited since it was sorted cannot be placed; branch packets carry the newest notes within their room, labelled', async () => {
  const { store, map, act, rewrite, thoughts, storage, packet, placements } = await sorted();
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const [proposal] = sortsOf(saved);
  await act({ type: 'inbox-edit', thoughtId: thoughts[0].id, text: 'Paper backup, laminated.' });
  await assert.rejects(act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[0].id }), error => error.status === 409 && /changed since/.test(error.message));
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id });
  // Notes beyond their room: the newest stay, a long one is marked shortened, the rest are counted.
  await rewrite(raw => { const node = raw.nodes.find(item => item.id === storage.id); node.notes = [...node.notes, ...Array.from({ length: 6 }, (_, i) => ({ id: `note-0000000${i}`, text: `${i}${'n'.repeat(i === 5 ? 900 : 300)}`, createdAt: '2026-01-02T00:00:00.000Z' }))]; });
  await act({ type: 'activate', nodeId: storage.id });
  const run = await store.claim('agent', map.id);
  assert.match(run.instruction, /userNotes are the user's own notes/);
  assert.ok(run.selected.userNotes.length < 7 && run.selected.omittedNotes === 7 - run.selected.userNotes.length, 'counted');
  assert.match(run.selected.userNotes.at(-1).text, /^5n+\n\[Shortened; read --section notes for the full text\.\]$/, 'the newest, shortened with a marker');
  assert.equal(JSON.stringify(run.selected.userNotes).length < 2000, true, 'within their room');
  assert.match(run.retrieval, /\|notes/);
  const read = contextExcerpt(await store.get(map.id), storage.id, { section: 'notes' });
  assert.equal(read.totalRecords, 7); assert.match(read.excerpt, /5n{900}/, 'read --section notes has them in full');
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${storage.id}.md`), 'utf8');
  assert.match(markdown, /## Your notes\n\n_The user's own notes, not findings\._\n\n- Check whether phones encrypt local storage\./);
  const brief = mapBrief(await store.get(map.id));
  assert.equal(brief.counts.openThoughts, 2); assert.match(brief.markdown, /2 open thoughts in the inbox/);
});

test('notes give way before questions when a branch packet is full, and their Markdown is escaped', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'inbox-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.', mode: 'decide', objective: 'o'.repeat(2000), successCriteria: 's'.repeat(2000) });
  const first = await store.claim('agent', map.id); await store.fail(map.id, first.jobId, first.claimKey, 'Stopped for the test.');
  const raw = JSON.parse(await readFile(store.file(map.id), 'utf8')), node = raw.nodes[0];
  Object.assign(node, { prompt: 'p'.repeat(2400), body: 'b'.repeat(4000), summary: 'S.', questions: Array.from({ length: 8 }, (_, i) => ({ id: `q-${i}`, text: 'q'.repeat(600), answer: 'a'.repeat(1000) })),
    notes: Array.from({ length: 3 }, (_, i) => ({ id: `note-${i}`, text: `${i}${'n'.repeat(499)}`, createdAt: '2026-01-01T00:00:00.000Z' })) }); // Exactly their own room.
  await writeFile(store.file(map.id), JSON.stringify(raw));
  const saved = await store.get(map.id), packet = store.packet(saved, { id: 'job-x', nodeId: saved.rootId, reason: 'Test.' }, { claimKey: 'k' });
  assert.equal(packet.selected.questions.length, 3, 'the questions the budget keeps');
  assert.deepEqual([packet.selected.userNotes.length, packet.selected.omittedNotes], [2, 1], 'a note went first');
  assert.match(packet.selected.userNotes.at(-1).text, /^2n+$/, 'the newest stays');
  assert.ok(noteLines({ notes: [{ text: 'Mine *bold* <b>.' }] }).includes(String.raw`- Mine \*bold\* \<b\>.`), 'escaped');
});

test('the inbox modules load first without an import cycle back to the Store', async () => {
  const { execFile } = await import('node:child_process');
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', "await import('./skills/explore/scripts/inbox.mjs'); const { defaultRegistry } = await import('./skills/explore/scripts/job-types.mjs'); console.log(Boolean(defaultRegistry.jobTypes['sort-thoughts']));"], (error, stdout, stderr) => (error ? reject(new Error(stderr)) : resolve(stdout))));
  assert.equal(out.trim(), 'true');
});

test('restoring the branch a thought was placed on puts the thought back in the inbox, never in neither place', async () => {
  const { store, map, act, thoughts, storage, packet, placements } = await sorted();
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { placements });
  const version = (await store.versions.list(map.id)).versions[0];
  const [proposal] = sortsOf(saved);
  saved = await act({ type: 'place-thought', proposalId: proposal.id, itemId: proposal.items[1].id });
  assert.equal(saved.inbox.find(item => item.id === thoughts[1].id).state, 'placed');
  const { previewBranchRestore } = await import('../skills/explore/scripts/branch-restore.mjs');
  const preview = await previewBranchRestore(store, map.id, version.id, { nodeId: storage.id });
  saved = await act({ type: 'restore-branch', nodeId: storage.id, version: version.id, previewHash: preview.hash });
  assert.equal(saved.nodes.find(node => node.id === storage.id).notes, undefined, 'the note went with the restore');
  const thought = saved.inbox.find(item => item.id === thoughts[1].id);
  assert.deepEqual([thought.state, thought.placement, thought.placedAt], ['open', undefined, undefined], 'so the thought is open again');
});

test('maps without an inbox or notes load unchanged; malformed ones are reported', () => {
  const base = { schemaVersion: 1, id: 'map-1', title: 'T', rootId: 'root', edges: [], jobs: [], history: [], revision: 1, updatedAt: '2026-01-01' };
  const idea = (extra = {}) => ({ id: 'root', title: 'Root', kind: 'idea', status: 'explored', reviewState: 'unreviewed', summary: 'S', questions: [], sources: [], ...extra });
  assert.deepEqual(validateMap({ ...base, nodes: [idea()] }).errors, []);
  assert.ok(validateMap({ ...base, inbox: 'x', nodes: [idea()] }).errors.some(error => error.at === 'inbox'));
  assert.ok(validateMap({ ...base, inbox: [{ id: 'thought-1', text: 'T', state: 'lost' }], nodes: [idea()] }).errors.some(error => /inbox\[0\]/.test(error.at)));
  assert.ok(validateMap({ ...base, nodes: [idea({ notes: [{ text: 5 }] })] }).errors.some(error => /notes/.test(error.at)));
  assert.deepEqual(openThoughts({ nodes: [] }), []);
});

test('the inbox lists open thoughts with their suggestions, each control naming its thought; history is read-only', () => {
  const map = { nodes: [{ id: 'root', title: 'Root <a>' }], inbox: [{ id: 'thought-1', text: 'Paper <backup>.', state: 'open' }, { id: 'thought-2', text: 'Encrypt?', state: 'open' }, { id: 'thought-3', text: 'Gone.', state: 'discarded' }, { id: 'thought-4', text: 'Moved.', state: 'open' }, { id: 'thought-5', text: 'New.', state: 'open' }],
    proposals: [{ id: 'proposal-1', type: SORT_THOUGHTS, items: [{ id: 'item-1', thoughtId: 'thought-1', textKey: textKey('Paper <backup>.'), action: 'new-branch', parentId: 'root', title: 'Paper', body: 'When <batteries> die.', review: 'unreviewed' },
      { id: 'item-2', thoughtId: 'thought-2', textKey: textKey('Encrypt?'), action: 'unplaced', reason: 'Not <here>.', review: 'unreviewed' }, { id: 'item-4', thoughtId: 'thought-4', textKey: textKey('Moved.'), action: 'note', nodeId: 'node-gone', reason: 'Fits.', review: 'unreviewed' }] }], jobs: [] };
  const html = inboxHtml({ map, esc, live: true, editing: null, preview: null, listening: false });
  assert.match(html, /<p class="thought-text" id="thought-text-thought-1">Paper &lt;backup&gt;\.<\/p>/); assert.doesNotMatch(html, /Gone\./);
  assert.match(html, /data-thought-edit="thought-1" aria-describedby="thought-text-thought-1">Edit<\/button>/);
  assert.match(html, /Your agent suggests a new branch under “Root &lt;a&gt;”: <strong>Paper<\/strong><\/p><p class="form-note">When &lt;batteries&gt; die\.<\/p>/, 'the title and the body it would get');
  assert.match(html, /data-place-thought="item-1" data-proposal="proposal-1" data-thought="thought-1" aria-describedby="thought-text-thought-1">Accept<\/button>/);
  assert.match(html, /data-focus-node="root">Show “Root &lt;a&gt;”<\/button>/);
  assert.match(html, /Your agent could not place it: Not &lt;here&gt;\./); assert.doesNotMatch(html, /data-place-thought="item-2"/, 'an unplaced item can only be dismissed');
  assert.match(html, /a note on a removed idea\./); assert.doesNotMatch(html, /node-gone/);
  assert.match(html, /<button type="button" class="primary" data-inbox-sort="">Ask the agent where these belong<\/button>/);
  assert.match(inboxHtml({ map: { ...map, inbox: map.inbox.slice(0, 4) }, esc, live: true, listening: false }), /Every thought has a suggestion waiting for you\./, 'nothing to sort while every suggestion waits');
  const changed = { ...map, inbox: [{ ...map.inbox[0], text: 'Paper backup, laminated.' }] };
  assert.match(inboxHtml({ map: changed, esc, live: true, listening: false }), /changed since your agent sorted it/); assert.doesNotMatch(inboxHtml({ map: changed, esc, live: true, listening: false }), /data-place-thought/);
  const waiting = inboxHtml({ map: { ...map, jobs: [{ id: 'job-1', type: SORT_THOUGHTS, status: 'queued' }] }, esc, live: true, listening: true });
  assert.match(waiting, /Your agent will pick this up next\. <button type="button" class="text-button" data-inbox-stop="job-1">Stop<\/button>/); assert.doesNotMatch(waiting, /data-inbox-sort/);
  const history = inboxHtml({ map, esc, live: false, listening: false, readOnly: 'Read-only growth history.' });
  assert.match(history, /Read-only growth history\. Return to the live map to add or place thoughts\./); assert.doesNotMatch(history, /<button[^>]*data-(thought-edit|thought-discard|place-thought|dismiss-item|inbox-sort)/);
  assert.match(inboxHtml({ map, esc, live: true, editing: 'thought-1', listening: false }), /<textarea id="thought-edit" maxlength="4000" rows="3">Paper &lt;backup&gt;\.<\/textarea>/);
  assert.match(notesHtml({ notes: [{ id: 'note-1', text: 'Mine <b>.' }, { text: 7 }] }, { esc }), /<h3 class="section-label">Your notes<\/h3><ul class="idea-notes"><li>Mine &lt;b&gt;\.<\/li><\/ul>/);
  assert.equal(notesHtml({}, { esc }), '');
  const preview = { thoughts: [{ id: 't1' }, { id: 't2' }], remainingThoughts: 3, ideas: [{}, {}, {}], omittedIdeas: 5, goal: { objective: 'Ship.' }, glossary: [{}, {}] };
  assert.equal(previewText(preview), 'Your agent will read 2 thoughts in full (3 more wait for a later sort) and an index of 3 of 8 ideas (titles, kinds, status and a short summary), with the map\'s goal and 2 agreed terms. Nothing is placed until you accept it.');
  assert.equal(previewText({ thoughts: [{}], ideas: [{}] }), 'Your agent will read 1 thought in full and an index of 1 idea (titles, kinds, status and a short summary). Nothing is placed until you accept it.');
});

// A small fake DOM for the dialog: an element's querySelector finds only what its HTML has, the same object each time.
function fakeDialog({ map, act, api, live = () => true }) {
  const elements = new Map(), focused = [], chosen = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', open: false, disabled: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); },
        querySelector(selector) {
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1)}"`) : this.innerHTML.includes(selector.slice(1, -1).replace(/^([\w-]+)$/, '$1='));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const captureButton = { disabled: false }; element('inbox-capture').querySelector = selector => (selector === 'button' ? captureButton : null);
  const dialog = inboxDialog({ map, act, api, esc, toast: message => toasts.push(message), live, readOnly: () => 'Read-only growth history.', listening: () => false, focusNode: id => chosen.push(id) });
  const click = dataset => element('inbox-body').fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  return { element, dialog, click, chosen, focused, toasts };
}

test('the inbox dialog captures, edits, discards and asks after F1\'s preview, keeping focus inside; history cannot capture', async () => {
  const thoughts = [{ id: 'thought-1', text: 'Paper backup.', state: 'open' }, { id: 'thought-2', text: 'Encrypt?', state: 'open' }];
  const map = { id: 'map-1', revision: 5, nodes: [{ id: 'root', title: 'Root' }], inbox: thoughts, proposals: [{ id: 'proposal-1', type: SORT_THOUGHTS, items: [{ id: 'item-1', thoughtId: 'thought-1', textKey: textKey('Paper backup.'), action: 'note', nodeId: 'root', reason: 'Fits.', review: 'unreviewed' }] }], jobs: [] };
  const calls = [], routes = [];
  const io = fakeDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; }, api: async route => { routes.push(route); return { thoughts: [{ id: 'thought-1' }, { id: 'thought-2' }], remainingThoughts: 0, ideas: [{}], omittedIdeas: 0, mapRevision: map.revision }; } });
  try {
    io.element('tools-dialog').open = true;
    await io.element('inbox-open').fire('click');
    assert.equal(io.element('inbox-dialog').open, true); assert.equal(io.element('tools-dialog').open, false); assert.equal(io.focused.at(-1), '#inbox-capture-text');
    io.element('inbox-capture-text').value = 'Volunteers forget PINs.';
    await io.element('inbox-capture').fire('submit', { preventDefault() {} });
    assert.deepEqual(calls.at(-1), [null, 'inbox-add', { text: 'Volunteers forget PINs.' }]); assert.equal(io.element('inbox-capture-text').value, ''); assert.equal(io.focused.at(-1), '#inbox-capture-text');
    await io.click({ thoughtEdit: 'thought-1' });
    assert.equal(io.focused.at(-1), '#thought-edit');
    const before = io.element('inbox-body').innerHTML;
    map.jobs = [{ id: 'job-9', type: SORT_THOUGHTS, status: 'queued' }]; io.dialog.mapChanged(); map.jobs = [];
    assert.equal(io.element('inbox-body').innerHTML, before, 'never redrawn while editing, even when the map changed');
    io.element('thought-edit').value = 'Paper backup, laminated.';
    await io.click({ thoughtSave: 'thought-1' });
    assert.deepEqual(calls.at(-1), [null, 'inbox-edit', { thoughtId: 'thought-1', text: 'Paper backup, laminated.' }]); assert.equal(io.focused.at(-1), '[data-thought-edit="thought-1"]');
    await io.click({ thoughtDiscard: 'thought-1' });
    assert.deepEqual(calls.at(-1), [null, 'inbox-discard', { thoughtId: 'thought-1' }]); assert.equal(io.focused.at(-1), '[data-thought-edit="thought-2"]', 'focus moves to the next thought');
    const sends = calls.length;
    await io.click({ inboxSort: '' });
    assert.deepEqual(routes, ['/maps/map-1/job-preview?type=sort-thoughts'], 'F1\'s preview of the packet itself'); assert.equal(calls.length, sends, 'nothing queued');
    assert.match(io.element('inbox-body').innerHTML, /Your agent will read 2 thoughts in full and an index of 1 idea/); assert.equal(io.focused.at(-1), '[data-inbox-send]');
    map.revision = 6; io.dialog.mapChanged();
    assert.doesNotMatch(io.element('inbox-body').innerHTML, /Your agent will read/, 'a preview of an earlier map is dropped');
    await io.click({ inboxSort: '' }); assert.equal(routes.length, 2);
    await io.click({ inboxSend: '' }); assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: SORT_THOUGHTS }]);
    // The agent takes the work: the poll redraws, and focus stays on Stop.
    map.jobs = [{ id: 'job-7', type: SORT_THOUGHTS, status: 'queued' }]; io.dialog.mapChanged();
    globalThis.document.activeElement = { id: '', dataset: { inboxStop: 'job-7' } }; io.element('inbox-body').contains = () => true;
    map.jobs = [{ id: 'job-7', type: SORT_THOUGHTS, status: 'running' }]; io.dialog.mapChanged();
    assert.equal(io.focused.at(-1), '[data-inbox-stop="job-7"]', 'focus stays on Stop through the redraw');
    // The suggestions arrive: the dialog says so and focus moves to the first one.
    map.jobs = []; io.dialog.mapChanged();
    assert.equal(io.toasts.at(-1), 'Your agent\'s suggestions are in.'); assert.equal(io.focused.at(-1), '[data-place-thought]');
    globalThis.document.activeElement = null; io.element('inbox-body').contains = () => false;
    await io.click({ placeThought: 'item-1', proposal: 'proposal-1', thought: 'thought-1' });
    assert.deepEqual(calls.at(-1), [null, 'place-thought', { proposalId: 'proposal-1', itemId: 'item-1' }]); assert.equal(io.focused.at(-1), '[data-thought-edit="thought-2"]', 'the next thought');
    await io.click({ dismissItem: 'item-1', proposal: 'proposal-1', thought: 'thought-1' });
    assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'dismissed' }]); assert.equal(io.focused.at(-1), '[data-thought-edit="thought-1"]', 'the thought it stays with');
    await io.click({ focusNode: 'root' }); assert.equal(io.element('inbox-dialog').open, false); assert.deepEqual(io.chosen, ['root']);
  } finally { delete globalThis.document; }
  const history = fakeDialog({ map: () => map, act: async () => true, api: async () => ({}), live: () => false });
  try {
    await history.element('inbox-open').fire('click');
    assert.equal(history.element('inbox-capture-text').disabled, true, 'no capture in history');
    assert.equal(history.element('inbox-capture').querySelector('button').disabled, true, 'nor its button');
    assert.match(history.element('inbox-body').innerHTML, /Read-only growth history\. Return to the live map/);
  } finally { delete globalThis.document; }
});
