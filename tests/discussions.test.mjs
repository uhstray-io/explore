import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { validateMap, readProblem } from '../skills/explore/scripts/map-validation.mjs';
import { compareVersion } from '../skills/explore/scripts/versions.mjs';
import { previewRestart } from '../skills/explore/scripts/restart.mjs';
import { discussionLines } from '../skills/explore/scripts/discussions.mjs';
import { mapOverview, versionLabel, restoreSummary, restartPreviewHtml } from '../skills/explore/assets/workspace-view.js';
import { discussionHtml, discussionRequest, discussionClick, openDiscussionsFilter, threadsOf, nodeThreads, discussionLimits } from '../skills/explore/assets/discussions.js';

// Comment threads (H6, #35). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const ben = { name: 'Ben' }, ana = { name: 'Ana' };

// A map whose root is explored with a question still open, and one suggested direction.
async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'discuss-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  const saved = await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Sync is the hard part.', body: 'Phones keep notes locally.', questions: ['Who edits notes?'], suggestions: [{ title: 'Storage', body: 'What lives on the phone.' }] });
  const branch = saved.nodes.find(node => node.title === 'Storage');
  const act = async (input, actor = ben) => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input }, { actor });
  return { store, map, branch, act };
}
// Everything a comment must leave alone: every idea whole, links, jobs, growth and the view.
const untouched = map => JSON.stringify([map.nodes, map.edges, map.jobs, map.growth, map.view]);

test('a comment on an idea waiting for an answer answers nothing: the question stays open and the idea cannot be explored', async () => {
  const { store, map, act } = await setup();
  const before = await store.get(map.id);
  assert.equal(before.nodes[0].status, 'awaiting-answer');
  const saved = await act({ type: 'comment', text: 'The field team, I think.' });
  assert.equal(saved.revision, before.revision + 1, 'it bumps the map revision');
  assert.equal(untouched(saved), untouched(before), 'no work state, review state, question, answer, revision, link, job, growth or view changes');
  assert.equal(saved.nodes[0].questions[0].answer ?? null, null); assert.equal(saved.nodes[0].status, 'awaiting-answer');
  await assert.rejects(act({ type: 'activate' }), error => error.status >= 400, 'still waiting for a real answer');
  assert.deepEqual(saved.history.filter(event => event.type === 'commented').map(event => event.nodeId), [map.rootId]);
});

test('a comment while the idea is being explored never makes that result stale', async () => {
  const { store, map, branch, act } = await setup();
  await act({ type: 'activate', nodeId: branch.id });
  const run = await store.claim('agent', map.id);
  assert.equal(run.selected.id, branch.id);
  await act({ type: 'comment', nodeId: branch.id, text: 'Remember the old phones.' });
  const done = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'A week of notes fits.', body: 'Fixture.' });
  const node = done.nodes.find(entry => entry.id === branch.id), job = done.jobs.find(entry => entry.id === run.jobId);
  assert.deepEqual([node.status, node.stale ?? false, job.status, job.stale ?? false], ['explored', false, 'completed', false]);
  assert.equal(JSON.stringify(run).includes('old phones'), false, 'and the packet never carried it');
  const later = await act({ type: 'comment', nodeId: branch.id, text: 'Even on a finished branch.' });
  assert.equal(threadsOf(later).length, 2, 'a finished branch can be discussed too, since nothing changes');
});

test('threads and replies survive a restart; a resolved thread takes no reply until it is reopened', async () => {
  const { store, map, act } = await setup();
  let saved = await act({ type: 'comment', text: 'Is this finding right?' });
  const [thread] = threadsOf(saved);
  saved = await act({ type: 'comment', threadId: thread.id, text: 'Yes, see the notes.' }, ana);
  saved = await act({ type: 'resolve-discussion', threadId: thread.id }, ana);
  await assert.rejects(act({ type: 'comment', threadId: thread.id, text: 'One more thing.' }), error => error.status === 409 && /resolved\. Reopen it to reply/.test(error.message));
  await assert.rejects(act({ type: 'resolve-discussion', threadId: thread.id }), /already resolved/);
  const reloaded = threadsOf(await new Store(store.directory).get(map.id))[0];
  assert.deepEqual([reloaded.status, reloaded.resolvedBy, reloaded.messages.map(message => [message.by?.name, message.text])], ['resolved', { name: 'Ana' }, [['Ben', 'Is this finding right?'], ['Ana', 'Yes, see the notes.']]]);
  assert.ok(reloaded.messages.every(message => /^message-[a-f0-9]{8}$/.test(message.id) && !Number.isNaN(Date.parse(message.at))));
  saved = await act({ type: 'reopen-discussion', threadId: thread.id });
  assert.deepEqual([threadsOf(saved)[0].status, 'resolvedAt' in threadsOf(saved)[0], 'resolvedBy' in threadsOf(saved)[0]], ['open', false, false]);
  saved = await act({ type: 'comment', threadId: thread.id, text: 'One more thing.' }, null);
  assert.equal('by' in threadsOf(saved)[0].messages.at(-1), false, 'no name, no by');
  await assert.rejects(act({ type: 'reopen-discussion', threadId: thread.id }), /already open/);
  await assert.rejects(act({ type: 'comment', threadId: 'thread-nope0000', text: 'Hi' }), error => error.status === 404);
  const { branch } = await setup(); // A thread belongs to its idea: another idea cannot reply to it.
  await assert.rejects(store.action(map.id, { expectedRevision: saved.revision, nodeId: saved.nodes.find(node => node.id !== map.rootId)?.id ?? branch.id, type: 'comment', threadId: thread.id, text: 'Hi' }, { actor: ben }), error => error.status === 404);
  assert.deepEqual(saved.history.filter(event => event.type.startsWith('discussion-') || event.type === 'commented').map(event => event.type), ['commented', 'commented', 'discussion-resolved', 'discussion-reopened', 'commented']);
});

test('work packets and briefs carry no comment; read --section discussion returns them, labelled', async () => {
  const { store, map, branch, act } = await setup();
  await act({ type: 'comment', nodeId: branch.id, text: 'SECRET-COMMENT about storage.' });
  await act({ type: 'activate', nodeId: branch.id });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.selected.id, branch.id);
  assert.equal(JSON.stringify(packet).includes('SECRET-COMMENT'), false, 'never in a work packet');
  const saved = await store.get(map.id);
  assert.equal(JSON.stringify(mapBrief(saved)).includes('SECRET-COMMENT'), false, 'or a brief');
  const read = contextExcerpt(saved, branch.id, { section: 'discussion' });
  assert.match(read.excerpt, /^## thread-[a-f0-9]{8} \(open\)\nDiscussion between people, not an answer\.\nBen, [^:]+:\d\d:\d\d\.\d{3}Z: SECRET-COMMENT about storage\.$/);
  assert.equal(contextExcerpt(saved, map.rootId, { section: 'discussion' }).totalRecords, 0);
  assert.throws(() => contextExcerpt(saved, branch.id, { section: 'chat' }), /notes, discussion, sources/);
});

test('HTML and Markdown in a comment stay literal in the app and in the idea\'s Markdown view', async () => {
  const { store, map, act } = await setup();
  await act({ type: 'comment', text: 'Look <img src=x onerror=alert(1)> & *this*\n\n# not a heading' }, { name: 'Ben <b>' });
  const saved = await store.get(map.id), node = saved.nodes[0];
  const html = discussionHtml(saved, node, { esc, live: true });
  assert.match(html, /<p class="discussion-meta">Ben &lt;b&gt; · [^<]+<\/p><p class="discussion-text">Look &lt;img src=x onerror=alert\(1\)&gt; &amp; \*this\*\n\n# not a heading<\/p>/);
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /## Discussion \(not answers\)\n\n### Open, started \d{4}-\d{2}-\d{2}\n\n\*\*Ben \\<b\\>\*\*, \d{4}-\d{2}-\d{2}:\n\n> Look \\<img src=x onerror=alert\(1\)\\> & \\\*this\\\*\n>\n> \\# not a heading/);
});

test('a limit too far is refused with a clear error, and nothing is saved', async () => {
  const { store, map, act } = await setup();
  const before = await store.get(map.id);
  await assert.rejects(act({ type: 'comment', text: 'x'.repeat(discussionLimits.text + 1) }), /at most 4000/);
  await assert.rejects(act({ type: 'comment', text: '   ' }), /required/i);
  assert.equal((await store.get(map.id)).revision, before.revision);
  // A full thread, and a full map, built as a pulled file could bring them.
  const full = structuredClone(before);
  full.discussions = { version: 1, threads: [{ id: 'thread-full0000', nodeId: map.rootId, createdAt: '2026-11-04T10:00:00.000Z', status: 'open', messages: Array.from({ length: 50 }, (_, i) => ({ id: `message-${String(i).padStart(8, '0')}`, at: '2026-11-04T10:00:00.000Z', text: 'm' })) }] };
  await store.save(full);
  const saved = await store.get(map.id);
  await assert.rejects(act({ type: 'comment', threadId: 'thread-full0000', text: 'One too many.' }), /at most 50 messages\. Start a new one\./);
  saved.discussions.threads.push(...Array.from({ length: 199 }, (_, i) => ({ id: `thread-${String(i).padStart(8, '0')}`, nodeId: map.rootId, createdAt: '2026-11-04T10:00:00.000Z', status: 'resolved', messages: [] })));
  await store.save(saved);
  const crowded = await store.get(map.id);
  await assert.rejects(act({ type: 'comment', text: 'New thread.' }), /at most 200 discussions/);
  assert.equal((await store.get(map.id)).revision, crowded.revision, 'refused before anything is written');
});

test('a map without discussions loads unchanged; a block the views cannot read is refused, never overwritten', async () => {
  const { store, map, act } = await setup();
  const plain = await store.get(map.id);
  assert.equal('discussions' in plain, false); assert.deepEqual(validateMap(plain).errors, []);
  const saved = await act({ type: 'comment', text: 'Hi.' });
  assert.equal(readProblem(saved), null); assert.deepEqual(validateMap(saved).errors, []);
  for (const [name, spoil, at] of [
    ['a newer version', m => { m.discussions.version = 2; }, 'discussions'],
    ['threads not a list', m => { m.discussions.threads = {}; }, 'discussions'],
    ['a thread that is not a record', m => { m.discussions.threads.push('x'); }, 'discussions.threads[1]'],
    ['no messages', m => { delete m.discussions.threads[0].messages; }, 'discussions.threads[0].messages'],
    ['a message that is not a record', m => { m.discussions.threads[0].messages.push(null); }, 'discussions.threads[0].messages[1]'],
    ['a message that is not text', m => { m.discussions.threads[0].messages[0].text = 5; }, 'discussions.threads[0].messages[0].text'],
    ['an author without a name', m => { m.discussions.threads[0].messages[0].by = { name: [] }; }, 'discussions.threads[0].messages[0].by'],
    ['resolved by someone without a name', m => { m.discussions.threads[0].resolvedBy = 'Ana'; }, 'discussions.threads[0].resolvedBy'],
  ]) {
    const copy = structuredClone(saved); spoil(copy);
    assert.equal(readProblem(copy), 'invalid-map', name);
    assert.ok(validateMap(copy).errors.some(error => error.at === at && error.unreadable), `${name}: at ${at}`);
  }
  for (const [name, spoil, code, at] of [
    ['a thread ID used twice', m => { m.discussions.threads.push(structuredClone(m.discussions.threads[0])); }, 'duplicate-id', 'discussions.threads[1].id'],
    ['a message ID used twice', m => { m.discussions.threads[0].messages.push(structuredClone(m.discussions.threads[0].messages[0])); }, 'duplicate-id', 'discussions.threads[0].messages[1].id'],
    ['an idea that does not exist', m => { m.discussions.threads[0].nodeId = 'node-gone0000'; }, 'missing-node', 'discussions.threads[0].nodeId'],
    ['an unknown status', m => { m.discussions.threads[0].status = 'archived'; }, 'unknown-value', 'discussions.threads[0].status'],
  ]) {
    const copy = structuredClone(saved); spoil(copy);
    assert.equal(readProblem(copy), null, `${name}: reported, the map still opens`);
    assert.ok(validateMap(copy).errors.some(error => error.code === code && error.at === at), `${name}: ${code} at ${at}`);
  }
  assert.deepEqual(threadsOf({ discussions: { threads: [null, 1, { id: 'a' }, { id: 'b', messages: [] }] } }).map(thread => thread.id), ['b']);
});

test('the section lists open threads first with a reply box each, resolved ones collapsed, drafts kept, and nothing to do in history', () => {
  const message = (id, text, name) => ({ id, at: '2026-11-04T10:00:00.000Z', ...(name ? { by: { name } } : {}), text });
  const map = { discussions: { version: 1, threads: [
    { id: 'thread-old', nodeId: 'node-a', createdAt: '2026-11-01T10:00:00.000Z', status: 'resolved', resolvedBy: { name: 'Cy <i>' }, messages: [message('message-1', 'Settled.', 'Cy')] },
    { id: 'thread-new', nodeId: 'node-a', createdAt: '2026-11-04T10:00:00.000Z', status: 'open', messages: [message('message-2', 'Open one.', 'Ana'), message('message-3', 'Reply.')] },
    { id: 'thread-other', nodeId: 'node-b', createdAt: '2026-11-04T10:00:00.000Z', status: 'open', messages: [message('message-4', 'Elsewhere.')] }] } };
  const node = { id: 'node-a' };
  assert.deepEqual(nodeThreads(map, 'node-a').map(thread => thread.id), ['thread-new', 'thread-old']);
  const html = discussionHtml(map, node, { esc, live: true, drafts: { 'discussion-reply:thread-new': 'Half <typed>', 'discussion-new:node-a': 'New <one>' } });
  assert.ok(html.indexOf('Open one.') < html.indexOf('<details class="discussion-resolved"'), 'open first');
  assert.match(html, /<p class="discussion-meta">Someone · [^<]+<\/p><p class="discussion-text">Reply\.<\/p>/, 'no name: Someone');
  assert.match(html, /<form class="discussion-reply" data-reply-form="thread-new" data-node-id="node-a">[\s\S]*data-draft="discussion-reply:thread-new">Half &lt;typed&gt;<\/textarea>[\s\S]*data-discussion-resolve="thread-new"/);
  assert.match(html, /<details class="discussion-resolved" data-editor="discussion-resolved"><summary>Resolved \(1\)<\/summary><article class="discussion-thread resolved" data-thread="thread-old">[\s\S]*Resolved by Cy &lt;i&gt;\.[\s\S]*data-discussion-reopen="thread-old"/);
  assert.doesNotMatch(html, /data-reply-form="thread-old"|Elsewhere/, 'no reply to a resolved thread, and only this idea\'s threads');
  assert.match(html, /<details data-editor="discussion"><summary>Start a discussion<\/summary><form id="discussion-form" data-node-id="node-a">[\s\S]*data-draft="discussion-new:node-a">New &lt;one&gt;<\/textarea>/);
  const history = discussionHtml(map, node, { esc, live: false });
  assert.match(history, /Open one\./); assert.doesNotMatch(history, /<form|data-discussion-|<details data-editor="discussion">/, 'history only shows');
  assert.equal(discussionHtml(map, { id: 'node-c' }, { esc, live: false }), '', 'nothing to show, nothing at all');
  assert.deepEqual(discussionRequest({ id: 'discussion-form', dataset: {} }, { text: 'Hi' }), { type: 'comment', input: { text: 'Hi' } });
  assert.deepEqual(discussionRequest({ id: '', dataset: { replyForm: 'thread-new' } }, { text: 'Re' }), { type: 'comment', input: { text: 'Re', threadId: 'thread-new' } });
  assert.equal(discussionRequest({ id: 'assign-form', dataset: {} }, {}), null);
  const groups = mapOverview({ nodes: ['a', 'b', 'c'].map(key => ({ id: `node-${key}`, title: key, status: 'explored', reviewState: 'unreviewed', questions: [] })), edges: [] }, { filters: [openDiscussionsFilter(map)] }).groups;
  const filter = groups.find(group => group.id === 'discussions');
  assert.equal(filter.label, 'Open discussions'); assert.deepEqual(filter.nodes.map(entry => entry.id), ['node-a', 'node-b']);
  assert.match(filter.lines(filter.nodes[0])[0].text, /^1 open discussion; latest from Someone · /);
});

test('Resolve and Reopen act through the app and keep focus in the section', async () => {
  const calls = [], toasts = [], focused = []; let rendered = 0;
  const ctx = { act: async (...args) => { calls.push(args); return true; }, toast: message => toasts.push(message), renderDetail: force => { assert.equal(force, true); rendered++; } };
  const click = dataset => discussionClick({ target: { closest: selector => { const name = selector.match(/^\[data-([a-z-]+)\]$/)[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()); return name in dataset ? { dataset, disabled: false } : null; } } }, ctx);
  globalThis.document = { querySelector: selector => ({ focus: () => focused.push(selector) }) };
  try {
    assert.equal(await click({ discussionResolve: 'thread-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'resolve-discussion', { threadId: 'thread-1' }]); assert.equal(focused.at(-1), '#detail #discussion-heading-node-a');
    assert.equal(await click({ discussionReopen: 'thread-1', nodeId: 'node-a' }), true);
    assert.deepEqual(calls.at(-1), ['node-a', 'reopen-discussion', { threadId: 'thread-1' }]); assert.equal(focused.at(-1), '#detail [data-reply-form="thread-1"] textarea');
    assert.deepEqual(toasts, ['Resolved.', 'Reopened.']); assert.equal(rendered, 2);
    assert.equal(await click({ assignmentTake: 'a' }), false, 'other clicks are left alone');
  } finally { delete globalThis.document; }
});

test('Undo and restore name discussion changes; a restart drops threads on the ideas it deletes and says so first', async () => {
  for (const [label, words] of [['commented', 'Comment added'], ['discussion-resolved', 'Discussion resolved'], ['discussion-reopened', 'Discussion reopened']]) assert.equal(versionLabel({ labels: [label] }), words);
  const { store, map, act } = await setup();
  const before = await store.get(map.id), after = await act({ type: 'comment', text: 'Hi.' });
  const counts = compareVersion(after, before, () => false).counts;
  assert.deepEqual([counts.discussionsChanged, counts.nodesChanged], [1, 0]);
  assert.match(restoreSummary({ counts, reopened: [] }, { undo: true }), /^Undoing changes discussions\. /);
  assert.match(restoreSummary({ counts: { ...counts, assignmentsChanged: 1, termsChanged: 1 }, reopened: [] }), /^Restoring changes the glossary, changes who is asked to look at branches and changes discussions\./);
  assert.equal((await store.versions.list(map.id)).versions[0].labels[0], 'commented');
  assert.match(restartPreviewHtml({ deleteCount: 2, deleted: [], linksRemoved: 3, requestsRemoved: 1, discussionsRemoved: 2, superseded: [], flagged: [], checkpointName: 'c' }, { esc }), /Restarting deletes 2 ideas below this branch, with 3 links, 1 open request to look at them and 2 open discussions\./);
  assert.match(restartPreviewHtml({ deleteCount: 2, deleted: [], linksRemoved: 0, requestsRemoved: 0, discussionsRemoved: 1, superseded: [], flagged: [], checkpointName: 'c' }, { esc }), /below this branch, with 1 open discussion\./);
  assert.ok(previewRestart, 'restart drops are tested through a real restart in restart-branch.test.mjs');
  assert.deepEqual(discussionLines({ discussions: { version: 1, threads: [] } }, { id: 'x' }), []);
});
