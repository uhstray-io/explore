import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { adrDialogHtml, adrFileText, adrSlug, renderAdr, ADR_DRAFT } from '../skills/explore/assets/adr.js';
import { adrDialog } from '../skills/explore/assets/adr-dialog.js';

// Lightweight ADR (F5, #27). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const exists = file => readFile(file).then(() => true, () => false);

// A server on a temporary workspace, with a map that has saved answers and an explored idea.
async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'adr-'));
  const app = await startServer({ workspace, port: 0 }), { store } = app;
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Store on the device, sync later.', body: 'Phones keep notes locally and sync when online.', questions: ['Who edits notes?', 'How often do teams sync?'] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  let saved = await store.get(map.id);
  for (const [i, answer] of ['The field team.', 'Once a day.'].entries()) saved = await act({ type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[i].id, answer });
  const run = await store.claim('agent', map.id); // Answering everything queued the idea again; finish it.
  await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Store on the device, sync later.', body: 'Phones keep notes locally and sync once a day.' });
  const { token } = await (await fetch(`${app.address}/api/session`)).json();
  const http = async (route, body) => {
    const response = await fetch(`${app.address}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const questions = (await store.get(map.id)).nodes[0].questions;
  const selection = [{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[1].id }, { nodeId: map.rootId }];
  return { app, store, workspace, map, act, http, questions, selection };
}
const draftOf = (questions, map, extra = {}) => ({ title: 'Store notes on the device and sync once a day', context: 'Field teams work without signal.', decision: 'Keep notes on each phone and sync once a day.',
  consequences: 'Edits made the same day can conflict. Why once a day: Not recorded.', alternatives: 'Live sync, which needs signal.', refs: [{ nodeId: map.rootId, questionId: questions[1].id }, { nodeId: map.rootId }], ...extra });
// Ask for a draft and deliver it; returns the proposal and its item.
async function drafted(ctx, result) {
  const { store, map, act, questions, selection } = ctx;
  await act({ type: 'request-map-job', jobType: ADR_DRAFT, selection, titleHint: 'Offline notes' });
  const packet = await store.claim('agent', map.id);
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, result ?? draftOf(questions, map));
  const proposal = saved.proposals.at(-1);
  return { packet, proposal, item: proposal.items[0] };
}
const content = map => JSON.stringify([map.nodes, map.edges, map.growth]);

test('a draft reads only the chosen answers and findings, and delivering, accepting and editing write nothing outside ideas/', async () => {
  const ctx = await setup(), { app, store, workspace, map, act, questions } = ctx;
  try {
    const before = content(await store.get(map.id));
    const { packet, proposal, item } = await drafted(ctx);
    assert.equal(packet.jobType, ADR_DRAFT); assert.equal(packet.titleHint, 'Offline notes');
    assert.deepEqual(packet.records.map(record => [record.questionId ?? 'findings', record.answer ?? record.summary]), [[questions[0].id, 'The field team.'], [questions[1].id, 'Once a day.'], ['findings', 'Store on the device, sync later.']]);
    assert.ok(packet.records.every(record => 'reviewState' in record && 'stale' in record)); assert.match(packet.instruction, /"Not recorded"; never invent/); assert.match(packet.instruction, /never write the file/);
    assert.equal(proposal.type, ADR_DRAFT); assert.equal(proposal.included.length, 3); assert.equal(item.review, 'unreviewed');
    assert.match(item.text, /^# Store notes on the device and sync once a day\n\nStatus: Proposed\nDate: <date saved>\n\n## Context\n\nField teams work without signal\.\n/);
    assert.match(item.text, /## Alternatives considered\n\nLive sync/); assert.doesNotMatch(item.text, /## Open questions/, 'an empty section is left out');
    assert.match(item.text, new RegExp(`## Sources from the exploration\\n\\n- How often do teams sync\\?: Once a day\\. \\(${map.id}, ${map.rootId}, ${questions[1].id}\\)\\n- Field notebook \\(findings\\): Store on the device, sync later\\. \\(${map.id}, ${map.rootId}\\)`));
    const saved = await act({ type: 'adr-accept', proposalId: proposal.id, itemId: item.id, text: `${item.text}\nAn edit of mine.` });
    assert.equal(saved.proposals.at(-1).items[0].review, 'accepted'); assert.match(saved.proposals.at(-1).items[0].text, /An edit of mine\.$/);
    await assert.rejects(act({ type: 'adr-accept', proposalId: proposal.id, itemId: item.id }), error => error.status === 409, 'accepted once');
    assert.equal(await exists(path.join(workspace, 'docs')), false, 'nothing outside ideas/');
    assert.deepEqual((await readdir(workspace)).sort(), ['.explore', 'ideas']);
    assert.equal(content(await store.get(map.id)), before, 'ideas, questions, links and growth unchanged');
  } finally { await app.close(); }
});

test('choices and results are checked: 1–40 saved answers or explored findings, refs from what was read, sections within limits', async () => {
  const ctx = await setup(), { app, store, map, act, questions } = ctx;
  try {
    const suggestion = (await act({ type: 'suggest', nodeId: map.rootId, title: 'Storage', body: 'Limits.' })).nodes.at(-1);
    for (const [selection, message] of [[[], /Choose 1 to 40/], [Array.from({ length: 41 }, () => ({ nodeId: map.rootId })), /Choose 1 to 40/], [[{ nodeId: suggestion.id }], /not a saved answer or an explored idea/],
      [[{ nodeId: map.rootId, questionId: 'q-nope' }], /not a saved answer/], [[{ nodeId: map.rootId }, { nodeId: map.rootId }], /chosen twice/]]) {
      await assert.rejects(act({ type: 'request-map-job', jobType: ADR_DRAFT, selection }), message, message.source);
    }
    await act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: ctx.selection });
    const packet = await store.claim('agent', map.id), good = draftOf(questions, map);
    for (const [bad, message] of [[{ ...good, decision: undefined }, /Decision is required/], [{ ...good, title: 'x'.repeat(121) }, /at most 120/], [{ ...good, context: 'x'.repeat(6001) }, /at most 6000/],
      [{ ...good, refs: [{ nodeId: suggestion.id }] }, /not read for this draft/], [{ ...good, refs: [good.refs[0], good.refs[0]] }, /repeats/], [{ ...good, refs: [] }, /at least one/], [{ ...good, status: 'Accepted' }, /remove status/]]) {
      await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
    }
  } finally { await app.close(); }
});

test('the save preview suggests the next number and the exact bytes; only the ADR route writes, only an accepted draft, never over a file', async () => {
  const ctx = await setup(), { app, store, workspace, map, act, http } = ctx;
  try {
    const { proposal, item } = await drafted(ctx);
    const route = `/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`;
    assert.equal((await http(route)).status, 409, 'accept first');
    const early = await http('/maps/'+map.id+'/adr-file', { proposalId: proposal.id, itemId: item.id, path: 'docs/adr/0001-x.md', sha256: 'x', expectedRevision: (await store.get(map.id)).revision });
    assert.equal(early.status, 409); assert.match(early.body.error, /Accept the draft before saving/); assert.equal(await exists(path.join(workspace, 'docs')), false, 'nothing created');
    await act({ type: 'adr-accept', proposalId: proposal.id, itemId: item.id, text: item.text.replace('Status: Proposed', 'Status: Accepted') });
    let preview = (await http(route)).body;
    assert.equal(preview.path, `docs/adr/0001-${adrSlug(item.title)}.md`, 'a missing folder starts at 0001'); assert.equal(preview.free, true);
    assert.match(preview.text, /^# .+\n\nStatus: Proposed\nDate: \d{4}-\d{2}-\d{2}\n/, 'always Proposed, dated when saved'); assert.equal(preview.sha256, sha(preview.text));
    assert.equal(await exists(path.join(workspace, 'docs')), false, 'a preview creates nothing');
    await mkdir(path.join(workspace, 'docs', 'adr'), { recursive: true });
    assert.equal((await http(route)).body.path.slice(9, 13), '0001', 'an empty folder starts at 0001 too');
    await writeFile(path.join(workspace, 'docs', 'adr', '0002-older.md'), 'Older.'); await writeFile(path.join(workspace, 'docs', 'adr', '0007-oldest.md'), 'Kept.'); await writeFile(path.join(workspace, 'docs', 'adr', 'notes.txt'), 'x');
    preview = (await http(route)).body;
    assert.equal(preview.path.slice(0, 14), 'docs/adr/0008-', 'one more than the highest prefix');
    // The action route can never write: an agent's act has no workspace.
    await assert.rejects(act({ type: 'adr-save', proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256 }), error => error.status === 403);
    const save = async extra => http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await store.get(map.id)).revision, ...extra });
    // An occupied path: 409, and the file there is untouched.
    let answer = await save({ path: 'docs/adr/0007-oldest.md' });
    assert.equal(answer.status, 409); assert.match(answer.body.error, /already at docs\/adr\/0007-oldest\.md; nothing was written/); assert.equal(await readFile(path.join(workspace, 'docs', 'adr', '0007-oldest.md'), 'utf8'), 'Kept.');
    answer = await save({ sha256: sha('something else') });
    assert.equal(answer.status, 409); assert.match(answer.body.error, /changed since you previewed/); assert.equal(await exists(path.join(workspace, preview.path)), false, 'nothing written');
    for (const bad of ['docs/0008-x.md', '/tmp/0008-x.md', 'C:/0008-x.md', 'docs/adr/../0008-x.md', 'docs/adr/0008-x.txt', 'docs/adr/8-x.md', 'docs/adr/0008-X.md', 'docs/adr/sub/0008-x.md']) {
      answer = await save({ path: bad });
      assert.equal(answer.status, 400, bad); assert.match(answer.body.error, /NNNN-name\.md/);
    }
    answer = await save();
    assert.equal(answer.status, 200);
    const written = await readFile(path.join(workspace, preview.path), 'utf8');
    assert.equal(written, preview.text, 'exactly the previewed bytes'); assert.match(written, /^Status: Proposed$/m); assert.match(written, new RegExp(`\\(${map.id}, ${map.rootId}`));
    const recorded = answer.body.proposals.at(-1).items[0].file;
    assert.deepEqual([recorded.path, recorded.sha256], [preview.path, preview.sha256]); assert.ok(recorded.savedAt);
    answer = await save({ path: 'docs/adr/0009-again.md' });
    assert.equal(answer.status, 409, 'saved once'); assert.equal(await exists(path.join(workspace, 'docs', 'adr', '0009-again.md')), false);
  } finally { await app.close(); }
});

test('a linked docs/adr/ folder is refused, and saving leaves ideas, questions, links and growth unchanged', async () => {
  const ctx = await setup(), { app, store, workspace, map, act, http } = ctx;
  try {
    const before = content(await store.get(map.id));
    const { proposal, item } = await drafted(ctx);
    await act({ type: 'adr-accept', proposalId: proposal.id, itemId: item.id });
    const elsewhere = await mkdtemp(path.join(path.resolve('.test-output'), 'adr-elsewhere-'));
    await mkdir(path.join(workspace, 'docs'), { recursive: true });
    await symlink(elsewhere, path.join(workspace, 'docs', 'adr'), 'junction');
    const route = `/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`;
    assert.match((await http(route)).body.error, /plain folder in this workspace, not a link/);
    const answer = await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: 'docs/adr/0001-x.md', sha256: 'x', expectedRevision: (await store.get(map.id)).revision });
    assert.equal(answer.status, 400); assert.deepEqual(await readdir(elsewhere), [], 'nothing written through the link');
    await rm(path.join(workspace, 'docs', 'adr'));
    const preview = (await http(route)).body;
    await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await store.get(map.id)).revision });
    assert.equal(await exists(path.join(workspace, preview.path)), true);
    assert.equal(content(await store.get(map.id)), before, 'drafting, accepting and saving change no idea, question, link or growth');
  } finally { await app.close(); }
});

test('a draft whose records changed is marked; Status and Date are set whatever the edits did', async () => {
  const ctx = await setup(), { app, store, map, act } = ctx;
  try {
    // An answer on an unfinished idea, which can still change.
    const child = (await act({ type: 'suggest', nodeId: map.rootId, title: 'Phones', body: 'Which phones.' })).nodes.at(-1);
    await act({ type: 'activate', nodeId: child.id });
    const run = await store.claim('agent', map.id);
    let saved = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Depends.', body: 'Older phones.', questions: ['Which phones?', 'Which OS?'] });
    const [phones] = saved.nodes.find(node => node.id === child.id).questions;
    await act({ type: 'answer', nodeId: child.id, questionId: phones.id, answer: 'Older Android phones.' });
    const { proposal } = await drafted({ ...ctx, selection: [{ nodeId: child.id, questionId: phones.id }] }, { title: 'Support older phones', context: 'C', decision: 'D', consequences: 'E', refs: [{ nodeId: child.id, questionId: phones.id }] });
    assert.notEqual(store.view(await store.get(map.id)).proposals.at(-1).stale, true);
    await act({ type: 'change-answer', nodeId: child.id, questionId: phones.id, answer: 'Any Android phone.' });
    assert.equal(store.view(await store.get(map.id)).proposals.find(item => item.id === proposal.id).stale, true, 'a record it read changed');
  } finally { await app.close(); }
  assert.equal(adrFileText('# T\nStatus: Accepted\nDate: yesterday\n\nBody.\n', '2026-11-28'), '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nBody.\n');
  assert.equal(adrFileText('No title.\n', '2026-11-28'), 'Status: Proposed\nDate: 2026-11-28\nNo title.\n');
  assert.equal(adrSlug('Store notes — on the device!'), 'store-notes-on-the-device'); assert.equal(adrSlug('!!!'), 'decision');
});

// The dialog: markup, and its wiring with a small fake DOM.
const fixtureMap = () => {
  const map = { id: 'map-1', revision: 3, rootId: 'root', nodes: [{ id: 'root', title: 'Root <a>', status: 'explored', summary: 'S', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }] }], jobs: [], proposals: [] };
  const draft = { title: 'Sync <daily>', context: 'C', decision: 'D', consequences: 'E', refs: [{ nodeId: 'root', questionId: 'q-1' }] };
  map.proposals.push({ id: 'proposal-1', type: ADR_DRAFT, items: [{ id: 'item-1', title: draft.title, refs: draft.refs, text: renderAdr(map, draft), review: 'unreviewed' }] });
  return map;
};

test('the dialog shows the draft to edit, accepted records to save, the exact file, and the choices; history is read-only', () => {
  const map = fixtureMap();
  let html = adrDialogHtml({ map, esc, listening: false });
  assert.match(html, /Draft for review: Sync &lt;daily&gt;/); assert.match(html, /<textarea id="adr-text" class="adr-text" rows="16" data-adr-text="item-1"># Sync &lt;daily&gt;/);
  assert.match(html, /data-adr-accept="item-1" data-proposal="proposal-1">Accept/); assert.doesNotMatch(html, /Draft a new record/, 'one draft at a time');
  assert.match(adrDialogHtml({ map, esc, listening: false, edits: { 'item-1': 'Mine <b>.' } }), />Mine &lt;b&gt;\.<\/textarea>/, 'edits survive a redraw');
  map.proposals[0].items[0].review = 'accepted';
  html = adrDialogHtml({ map, esc, listening: false });
  assert.match(html, /data-adr-save="item-1" data-proposal="proposal-1">Save to docs\/adr\/<\/button>/); assert.match(html, /<input type="checkbox" data-adr-node="root"> Its findings/); assert.match(html, /data-adr-question="q-1"> Who &lt;edits&gt;\?/);
  assert.match(html, /data-adr-preview="" disabled>/, 'nothing chosen yet');
  html = adrDialogHtml({ map, esc, listening: false, save: { itemId: 'item-1', proposalId: 'proposal-1', number: '0003', slug: 'sync-daily', free: true, text: '# Sync <daily>\n', sha256: 'h' } });
  assert.match(html, /Path: docs\/adr\/0003-sync-daily\.md/); assert.match(html, /<pre class="adr-file" tabindex="0"># Sync &lt;daily&gt;\n<\/pre>/); assert.match(html, /data-adr-write="item-1" data-proposal="proposal-1">Save file/);
  assert.match(adrDialogHtml({ map, esc, listening: false, save: { itemId: 'item-1', proposalId: 'proposal-1', number: '0003', slug: 'sync-daily', free: false, text: '', sha256: 'h' } }), /a file is already there[\s\S]*data-adr-write="item-1" data-proposal="proposal-1" disabled/);
  map.proposals[0].items[0].file = { path: 'docs/adr/0003-sync-daily.md' };
  assert.match(adrDialogHtml({ map, esc, listening: false }), /Saved to <code>docs\/adr\/0003-sync-daily\.md<\/code>/);
  const history = adrDialogHtml({ map: fixtureMap(), esc, listening: false, live: false });
  assert.match(history, /return to the live map/); assert.doesNotMatch(history, /data-adr-(accept|preview|save|send)/);
  const failed = { ...fixtureMap(), proposals: [], jobs: [{ id: 'job-1', type: ADR_DRAFT, status: 'failed', error: 'Too <long>.' }] };
  assert.match(adrDialogHtml({ map: failed, esc, listening: false }), /Your agent could not draft this record\. Too &lt;long&gt;\./);
});

function fakeDialog({ map, act, api, refresh = async () => {} }) {
  const elements = new Map(), focused = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false, addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); }, contains: () => false,
        querySelector(selector) {
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1)}"`) : this.innerHTML.includes(selector.slice(1, -1).replace(/^([\w-]+)$/, '$1='));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, value: '', textContent: '', focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), activeElement: null };
  const dialog = adrDialog({ map, act, api, refresh, esc, toast: message => toasts.push(message), live: () => true, listening: () => false });
  const body = element('adr-body');
  const click = dataset => body.fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  return { element, body, dialog, click, focused, toasts };
}

test('the dialog previews, queues, accepts with edits and saves the previewed bytes, keeping focus inside', async () => {
  let map = { ...fixtureMap(), proposals: [] };
  const calls = [], routes = [];
  // As the Store would: an accepted draft is accepted on the next redraw.
  const act = async (...args) => { calls.push(args); if (args[1] === 'adr-accept') { map = fixtureMap(); map.proposals[0].items[0].review = 'accepted'; } return true; };
  const api = async (route, body) => { routes.push([route, body]); if (route.includes('job-preview')) return { records: [{ questionId: 'q-1' }, {}], mapRevision: map.revision }; if (route.includes('adr-file?')) return { path: 'docs/adr/0004-sync-daily.md', free: true, text: '# Sync\n', sha256: 'abc' }; return {}; };
  const io = fakeDialog({ map: () => map, act, api });
  try {
    await io.element('adr-open').fire('click');
    assert.equal(io.element('adr-dialog').open, true); assert.equal(io.focused.at(-1), '[data-adr-node]');
    await io.body.fire('change', { target: { closest: () => ({ dataset: { adrNode: 'root', adrQuestion: 'q-1' }, checked: true }) } });
    await io.body.fire('change', { target: { closest: () => ({ dataset: { adrNode: 'root' }, checked: true }) } });
    await io.click({ adrPreview: '' });
    assert.equal(routes.at(-1)[0], `/maps/map-1/job-preview?type=adr-draft&selection=${encodeURIComponent(JSON.stringify([{ nodeId: 'root', questionId: 'q-1' }, { nodeId: 'root' }]))}`);
    assert.match(io.body.innerHTML, /Your agent will read 1 answer and the findings of 1 idea/); assert.equal(io.focused.at(-1), '[data-adr-send]');
    io.body.querySelector('#adr-title-hint').value = 'Sync daily';
    await io.click({ adrSend: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: ADR_DRAFT, selection: [{ nodeId: 'root', questionId: 'q-1' }, { nodeId: 'root' }], titleHint: 'Sync daily' }]);
    map = fixtureMap(); io.dialog.mapChanged();
    await io.body.fire('input', { target: { dataset: { adrText: 'item-1' }, value: '# Mine' } });
    map = { ...fixtureMap(), revision: 4 }; io.dialog.mapChanged();
    assert.match(io.body.innerHTML, /># Mine<\/textarea>/, 'a poll keeps the edit');
    await io.click({ adrAccept: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual(calls.at(-1), [null, 'adr-accept', { proposalId: 'proposal-1', itemId: 'item-1', text: '# Mine' }]); assert.equal(io.focused.at(-1), '[data-adr-save="item-1"]');
    await io.click({ adrSave: 'item-1', proposal: 'proposal-1' });
    assert.match(routes.at(-1)[0], /\/maps\/map-1\/adr-file\?proposal=proposal-1&item=item-1$/); assert.match(io.body.innerHTML, /Path: docs\/adr\/0004-sync-daily\.md/); assert.equal(io.focused.at(-1), '#adr-number');
    await io.body.fire('input', { target: { id: 'adr-slug', dataset: {}, value: 'sync-every-day' } });
    assert.match(io.body.querySelector('#adr-path').textContent, /docs\/adr\/0004-sync-every-day\.md/, 'the path follows the name');
    await io.click({ adrWrite: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual(routes.find(([route, body]) => body && route === '/maps/map-1/adr-file')?.[1], { proposalId: 'proposal-1', itemId: 'item-1', path: 'docs/adr/0004-sync-every-day.md', sha256: 'abc', expectedRevision: 3 });
    assert.equal(io.toasts.at(-1), 'Saved to docs/adr/0004-sync-every-day.md.');
  } finally { delete globalThis.document; }
});
