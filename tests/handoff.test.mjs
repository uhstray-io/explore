import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { Store } from '../skills/explore/scripts/store.mjs';
import { handoffDialogHtml, handoffFileText, handoffFooter, handoffFilename, HANDOFF } from '../skills/explore/assets/handoff.js';
import { handoffDialog } from '../skills/explore/assets/handoff-dialog.js';

// Implementation handoff (F4, #26). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

// A server on a temporary workspace, with a map that has saved answers and an explored idea.
async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'handoff-'));
  const app = await startServer({ workspace, port: 0 }), { store } = app;
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Store on the device, sync later.', body: 'Phones keep notes locally and sync when online.', questions: ['Who edits notes?', 'How often do teams sync?', 'Which phones?'] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  let saved = await store.get(map.id);
  for (const [i, answer] of ['The field team.', 'Once a day.', 'Older Android phones.'].entries()) saved = await act({ type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[i].id, answer });
  const run = await store.claim('agent', map.id);
  await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Store on the device, sync later.', body: 'Phones keep notes locally and sync once a day.' });
  const { token } = await (await fetch(`${app.address}/api/session`)).json();
  const get = async route => (await fetch(`${app.address}/api${route}`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const questions = (await store.get(map.id)).nodes[0].questions;
  const selection = [{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[1].id }, { nodeId: map.rootId }];
  return { app, store, map, act, get, questions, selection };
}
const content = map => JSON.stringify([map.nodes, map.edges, map.growth]);
const good = (map, questions) => ({ title: 'Offline notes: a plan', markdown: '# Plan\n\n1. Store notes on each phone.\n\n## Open questions\n\nWhich phones: Not recorded.', refs: [{ nodeId: map.rootId, questionId: questions[1].id }, { nodeId: map.rootId }] });
async function written(ctx, format = 'plan', result) {
  await ctx.act({ type: 'request-map-job', jobType: HANDOFF, selection: ctx.selection, options: { format } });
  const packet = await ctx.store.claim('agent', ctx.map.id);
  const saved = await ctx.store.complete(ctx.map.id, packet.jobId, packet.claimKey, result ?? good(ctx.map, ctx.questions));
  const proposal = saved.proposals.at(-1);
  return { packet, proposal, item: proposal.items[0] };
}

test('a handoff needs 1–40 chosen records and a format; the preview is the packet, and an unchosen answer never appears', async () => {
  const ctx = await setup(), { app, store, map, act, get, questions, selection } = ctx;
  try {
    const before = await store.get(map.id);
    for (const [input, message] of [[{ selection, options: { format: 'essay' } }, /Choose what to write/], [{ selection }, /Choose what to write/], [{ selection, options: 'plan' }, /Options must be an object/],
      [{ selection: [], options: { format: 'plan' } }, /Choose 1 to 40/], [{ selection: Array.from({ length: 41 }, () => ({ nodeId: map.rootId })), options: { format: 'plan' } }, /Choose 1 to 40/],
      [{ selection: [selection[0], selection[0]], options: { format: 'plan' } }, /chosen twice/], [{ selection: [{ nodeId: map.rootId, questionId: 'q-nope' }], options: { format: 'plan' } }, /not a saved answer/]]) {
      await assert.rejects(act({ type: 'request-map-job', jobType: HANDOFF, ...input }), message, message.source);
    }
    assert.equal((await store.get(map.id)).revision, before.revision, 'the map is unchanged');
    const preview = await get(`/maps/${map.id}/job-preview?type=${HANDOFF}&selection=${encodeURIComponent(JSON.stringify(selection))}&options=${encodeURIComponent(JSON.stringify({ format: 'spec' }))}`);
    await act({ type: 'request-map-job', jobType: HANDOFF, selection, options: { format: 'spec' } });
    const packet = await store.claim('agent', map.id);
    const strip = ({ jobId, claimKey, mapRevision, contextCharacters, approximateTokens, ...rest }) => rest;
    assert.deepEqual(strip(preview), strip(JSON.parse(JSON.stringify(packet))), 'the preview is what the agent reads, apart from the claim');
    assert.equal(packet.jobType, HANDOFF); assert.equal(packet.format, 'spec'); assert.equal(packet.idea, 'Notes that work offline.');
    assert.deepEqual(packet.records.map(record => record.questionId ?? 'findings'), [questions[0].id, questions[1].id, 'findings']);
    assert.ok(packet.records.every(record => 'reviewState' in record && 'stale' in record));
    assert.equal(JSON.stringify(packet).includes('Older Android phones.'), false, 'an unchosen answer never appears');
    assert.match(packet.instruction, /specification/); assert.match(packet.instruction, /"Not recorded"/); assert.match(packet.instruction, /under "Open questions", never under "Decisions"/);
    assert.match(packet.instruction, /never start implementing, run commands, open issues or send it anywhere/);
  } finally { await app.close(); }
});

test('results are checked: one-line title, at most 24,000 characters, refs from what was read, nothing else', async () => {
  const ctx = await setup(), { app, store, map, act, questions, selection } = ctx;
  try {
    await act({ type: 'request-map-job', jobType: HANDOFF, selection: selection.slice(0, 2), options: { format: 'tasks' } });
    const packet = await store.claim('agent', map.id), ok = { ...good(map, questions), refs: [{ nodeId: map.rootId, questionId: questions[1].id }] }; // Two answers were chosen, no findings.
    for (const [bad, message] of [[{ ...ok, markdown: 'x'.repeat(24001) }, /at most 24000/], [{ ...ok, refs: [{ nodeId: map.rootId }] }, /not read for this draft/],
      [{ ...ok, refs: [{ nodeId: map.rootId, questionId: questions[2].id }] }, /not read for this draft/], [{ ...ok, refs: [] }, /at least one/],
      [{ ...ok, title: 'A\nB' }, /one line/], [{ ...ok, title: 'x'.repeat(121) }, /at most 120/], [{ ...ok, owner: 'Sam' }, /remove owner/]]) {
      await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), message, message.source);
    }
    const saved = await store.complete(map.id, packet.jobId, packet.claimKey, ok);
    const item = saved.proposals.at(-1).items[0];
    assert.deepEqual([item.format, item.review, item.text, item.original], ['tasks', 'unreviewed', ok.markdown, ok.markdown]);
  } finally { await app.close(); }
});

test('accepting saves the user\'s edits beside the agent\'s text, and nothing else in the map changes', async () => {
  const ctx = await setup(), { app, store, map, act } = ctx;
  try {
    const before = content(await store.get(map.id));
    const { proposal, item } = await written(ctx);
    await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'accepted', text: 'x'.repeat(24001) }), /at most 24000/);
    await act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'accepted', text: `${item.text}\n\nMy note.` });
    await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'dismissed' }), error => error.status === 409, 'once');
    const reloaded = (await new Store(store.directory).get(map.id)).proposals.at(-1).items[0];
    assert.deepEqual([reloaded.review, reloaded.editedByUser, reloaded.original], ['accepted', true, item.text], 'the edits survive a reload, the agent\'s text kept apart');
    assert.match(reloaded.text, /My note\.$/);
    const second = await written(ctx, 'brief');
    await act({ type: 'review-proposal', proposalId: second.proposal.id, itemId: second.item.id, decision: 'accepted', text: second.item.text });
    assert.equal((await store.get(map.id)).proposals.at(-1).items[0].editedByUser, false, 'accepted as written');
    const third = await written(ctx, 'prompt');
    await act({ type: 'review-proposal', proposalId: third.proposal.id, itemId: third.item.id, decision: 'dismissed' });
    assert.equal(content(await store.get(map.id)), before, 'writing, accepting and dismissing change no idea, question, link or growth');
  } finally { await app.close(); }
});

test('the copied or downloaded file is the accepted text and Explore\'s footer, which names sources changed since', async () => {
  const ctx = await setup(), { app, store, map, act, questions } = ctx;
  try {
    const { proposal, item } = await written(ctx);
    await act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'accepted', text: `${item.text}\nMine.` });
    let view = store.view(await store.get(map.id)), shown = view.proposals.at(-1), accepted = shown.items[0];
    const text = handoffFileText(view, shown, accepted);
    assert.equal(text, `${accepted.text}\n\n${handoffFooter(view, shown, accepted)}\n`);
    const footer = handoffFooter(view, shown, accepted), day = new Date(accepted.reviewedAt);
    assert.match(footer, new RegExp(`^---\\n\\nExplore map ${map.id}, revision ${view.revision}\\.\\n\\nWritten from:\\n- Field notebook · Who edits notes\\? \\(${map.id}, ${map.rootId}, ${questions[0].id}\\)`));
    assert.match(footer, new RegExp(`- Field notebook \\(findings\\) \\(${map.id}, ${map.rootId}\\)`));
    assert.match(footer, new RegExp(`Drafted by an agent; edited and accepted on ${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}\\.$`));
    assert.doesNotMatch(footer, /Changed since/);
    await act({ type: 'set-answer-state', nodeId: map.rootId, questionId: questions[0].id, answerState: 'assumption' }); // How sure the user is of a source changed.
    view = store.view(await store.get(map.id)); shown = view.proposals.at(-1); accepted = shown.items[0];
    assert.equal(shown.stale, true); assert.deepEqual(shown.changed.map(record => record.questionId), [questions[0].id], 'the server names the changed source');
    assert.match(handoffFooter(view, shown, accepted), /Changed since it was written: Field notebook · Who edits notes\?\. Check them before relying on this\.$/);
    assert.match(handoffDialogHtml({ map: view, esc, listening: false, live: true }), /Changed since it was written: Field notebook · Who edits notes\?\./, 'and the dialog names it too');
    assert.equal(handoffFilename('Offline notes: a plan'), 'Offline notes- a plan-handoff.md');
  } finally { await app.close(); }
});

// The dialog: markup, and its wiring with a small fake page.
const fixture = () => {
  const map = { id: 'map-1', revision: 3, rootId: 'root', nodes: [{ id: 'root', parentId: null, title: 'Root <a>', status: 'explored', summary: 'S', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }] }], jobs: [], proposals: [] };
  map.proposals.push({ id: 'proposal-1', type: HANDOFF, included: [{ nodeId: 'root', questionId: 'q-1' }], items: [{ id: 'item-1', title: 'Plan <one>', format: 'plan', refs: [{ nodeId: 'root', questionId: 'q-1' }], text: '# Plan\n', original: '# Plan\n', review: 'unreviewed' }] });
  return map;
};

test('the dialog keeps Copy and Download disabled until the handoff is accepted, and is read-only in history', () => {
  const map = fixture();
  let html = handoffDialogHtml({ map, esc, listening: false, live: true });
  assert.match(html, /Plan for review: Plan &lt;one&gt;/); assert.match(html, /<textarea id="handoff-text" class="adr-text" rows="16" data-handoff-text="item-1"># Plan\n<\/textarea>/);
  assert.match(html, /data-handoff-accept="item-1" data-proposal="proposal-1">Accept<\/button>/);
  assert.match(html, /<button type="button" class="secondary" disabled>Copy<\/button><button type="button" class="secondary" disabled>Download Markdown<\/button>/);
  assert.doesNotMatch(html, /data-handoff-(copy|download)=/, 'nothing to copy before acceptance'); assert.doesNotMatch(html, /Write a new handoff/, 'one at a time');
  map.proposals[0].items[0] = { ...map.proposals[0].items[0], review: 'accepted', editedByUser: true };
  html = handoffDialogHtml({ map, esc, listening: false, live: true, chosen: [{ nodeId: 'root', questionId: 'q-1' }], format: 'spec' });
  assert.match(html, /<strong>Plan &lt;one&gt;<\/strong> <span class="form-note">Plan, edited by you<\/span>/);
  assert.match(html, /data-handoff-copy="item-1" data-proposal="proposal-1">Copy<\/button><button type="button" class="secondary" data-handoff-download="item-1" data-proposal="proposal-1">Download Markdown/);
  assert.match(html, /<option value="spec" selected>Specification<\/option>/); assert.match(html, /data-handoff-question="q-1" checked>/);
  assert.match(handoffDialogHtml({ map, esc, listening: false, live: true, chosen: [{ nodeId: 'root' }], preview: { format: 'tasks', records: [{ questionId: 'q-1' }, {}] } }), /Your agent will read the original idea, 1 answer and the findings of 1 idea, and write a task list from those alone\. It runs and sends nothing\./);
  const history = handoffDialogHtml({ map: fixture(), esc, listening: false, live: false });
  assert.match(history, /return to the live map/); assert.doesNotMatch(history, /data-handoff-(accept|preview|send)/);
  const failed = { ...fixture(), proposals: [], jobs: [{ id: 'job-1', type: HANDOFF, status: 'failed', error: 'Too <long>.' }] };
  assert.match(handoffDialogHtml({ map: failed, esc, listening: false, live: true }), /Your agent could not write this handoff\. Too &lt;long&gt;\./);
  assert.match(handoffDialogHtml({ map: { ...failed, jobs: [{ id: 'job-2', type: HANDOFF, status: 'running' }] }, esc, listening: false, live: true }), /Your agent is writing the handoff\. <button type="button" class="text-button" data-handoff-stop="job-2">Stop/);
});

function fakeDialog({ map, act, api, downloads }) {
  const elements = new Map(), focused = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false, addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); }, contains: () => false,
        querySelector(selector) {
          const has = (tag, part) => (part.includes('=') ? tag.includes(part) : new RegExp(`\\s${part}[\\s=>]`).test(tag));
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1).split(' ')[0]}"`) : (this.innerHTML.match(/<[^>]+>/g) ?? []).some(tag => selector.match(/\[[^\]]+\]/g).every(part => has(tag, part.slice(1, -1))));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), activeElement: null };
  const dialog = handoffDialog({ map, act, api, esc, toast: message => toasts.push(message), live: () => true, listening: () => false, download: (...args) => downloads.push(args) });
  const body = element('handoff-body');
  const click = dataset => body.fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  return { element, body, dialog, click, focused, toasts };
}

test('the dialog previews the chosen format and records, accepts the user\'s text, and copies or downloads only an accepted handoff', async () => {
  let map = { ...fixture(), proposals: [] };
  const calls = [], routes = [], downloads = [], copied = [];
  const act = async (...args) => { calls.push(args); if (args[1] === 'review-proposal' && args[2].decision === 'accepted') { map = fixture(); Object.assign(map.proposals[0].items[0], { review: 'accepted', text: args[2].text, reviewedAt: '2026-11-28T12:00:00.000Z' }); } return true; };
  const io = fakeDialog({ map: () => map, act, api: async route => { routes.push(route); return { format: 'spec', records: [{ questionId: 'q-1' }], mapRevision: map.revision }; }, downloads });
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => copied.push(text) } }, configurable: true });
  try {
    await io.element('handoff-open').fire('click');
    assert.equal(io.element('handoff-dialog').open, true);
    await io.body.fire('change', { target: { id: 'handoff-format', value: 'spec', closest: () => null } });
    await io.body.fire('change', { target: { closest: () => ({ dataset: { handoffNode: 'root', handoffQuestion: 'q-1' }, checked: true }) } });
    await io.click({ handoffPreview: '' });
    assert.equal(routes.at(-1), `/maps/map-1/job-preview?type=handoff&selection=${encodeURIComponent(JSON.stringify([{ nodeId: 'root', questionId: 'q-1' }]))}&options=${encodeURIComponent(JSON.stringify({ format: 'spec' }))}`);
    assert.match(io.body.innerHTML, /write a specification from those alone/);
    await io.body.fire('change', { target: { id: 'handoff-format', value: 'plan', closest: () => null } });
    assert.doesNotMatch(io.body.innerHTML, /data-handoff-send/, 'a new format needs a new preview');
    await io.click({ handoffPreview: '' }); await io.click({ handoffSend: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: HANDOFF, selection: [{ nodeId: 'root', questionId: 'q-1' }], options: { format: 'plan' } }]);
    map = fixture(); io.dialog.mapChanged();
    await io.click({ handoffCopy: 'item-1', proposal: 'proposal-1' }); await io.click({ handoffDownload: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual([copied, downloads], [[], []], 'nothing leaves before acceptance');
    await io.body.fire('input', { target: { dataset: { handoffText: 'item-1' }, value: '# Mine' } });
    await io.click({ handoffAccept: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'accepted', text: '# Mine' }]);
    assert.equal(io.focused.at(-1), '[data-handoff-copy="item-1"]');
    await io.click({ handoffDownload: 'item-1', proposal: 'proposal-1' });
    const file = handoffFileText(map, map.proposals[0], map.proposals[0].items[0]);
    assert.deepEqual(downloads, [[file, 'text/markdown;charset=utf-8', 'Plan -one--handoff.md']]); assert.match(file, /^# Mine\n\n---\n/);
    await io.click({ handoffCopy: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual(copied, [file]);
  } finally { delete globalThis.document; }
});
