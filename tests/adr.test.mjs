import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm, access, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { adrDialogHtml, adrFileText, adrSlug, adrName, adrToday, renderAdr, ADR_DRAFT } from '../skills/explore/assets/adr.js';
import { adrDialog } from '../skills/explore/assets/adr-dialog.js';
import { controlKey } from '../skills/explore/assets/dialog-focus.js';

// Lightweight ADR (F5, #27). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const exists = file => access(file).then(() => true, () => false); // Files and folders alike.

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
  const raw = async change => { const current = await store.get(map.id); change(current); await store.save(current); };
  return { app, store, workspace, map, act, http, questions, selection, raw };
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
const accept = (ctx, proposal, item, text) => ctx.act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'accepted', ...(text !== undefined ? { text } : {}) });
const content = map => JSON.stringify([map.nodes, map.edges, map.growth]);

test('a draft reads only the chosen answers and findings; delivering, accepting and editing write nothing outside ideas/', async () => {
  const ctx = await setup(), { app, store, workspace, map, act, questions } = ctx;
  try {
    const before = content(await store.get(map.id));
    const { packet, proposal, item } = await drafted(ctx);
    assert.equal(packet.jobType, ADR_DRAFT); assert.equal(packet.titleHint, 'Offline notes');
    assert.deepEqual(packet.records.map(record => [record.questionId ?? 'findings', record.answer ?? record.summary]), [[questions[0].id, 'The field team.'], [questions[1].id, 'Once a day.'], ['findings', 'Store on the device, sync later.']]);
    assert.ok(packet.records.every(record => 'reviewState' in record && 'stale' in record && !record.shortened)); assert.equal(packet.retrieval, undefined, 'nothing shortened, no hint');
    assert.match(packet.instruction, /"Not recorded"; never invent/); assert.match(packet.instruction, /never write the file/);
    assert.equal(proposal.type, ADR_DRAFT); assert.equal(proposal.included.length, 3); assert.equal(item.review, 'unreviewed');
    assert.match(item.text, /^# Store notes on the device and sync once a day\n\nStatus: Proposed\nDate: <date saved>\n\n## Context\n\nField teams work without signal\.\n/);
    assert.match(item.text, /## Alternatives considered\n\nLive sync/); assert.match(item.text, /## Open questions\n\nNot recorded\.\n/, 'the fixed template, an empty section saying so');
    assert.match(item.text, new RegExp(`## Sources from the exploration\\n\\n- How often do teams sync\\?: Once a day\\. \\(${map.id}, ${map.rootId}, ${questions[1].id}\\)\\n- Field notebook \\(findings\\): Store on the device, sync later\\. \\(${map.id}, ${map.rootId}\\)`));
    await assert.rejects(accept(ctx, proposal, item, 'x'.repeat(64 * 1024 + 1)), /at most 65536|64 KiB/, 'at most 64 KiB');
    const saved = await accept(ctx, proposal, item, `${item.text}\nAn edit of mine.`);
    assert.equal(saved.proposals.at(-1).items[0].review, 'accepted'); assert.match(saved.proposals.at(-1).items[0].text, /An edit of mine\.$/);
    await assert.rejects(accept(ctx, proposal, item), error => error.status === 409, 'accepted once');
    await assert.rejects(act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'dismissed' }), error => error.status === 409, 'never dismissed after');
    assert.equal(await exists(path.join(workspace, 'docs')), false, 'nothing outside ideas/');
    assert.deepEqual((await readdir(workspace)).sort(), ['.explore', 'ideas']);
    assert.equal(content(await store.get(map.id)), before, 'ideas, questions, links and growth unchanged');
    const reviews = mapBrief(await store.get(map.id)).sections.find(section => section.id === 'reviews');
    assert.equal(JSON.stringify(reviews).includes('undefined'), false, 'the brief\'s agent reviews are Check answers\' only');
  } finally { await app.close(); }
});

test('choices come from the shared selector and must fit; results are checked; titles are one line', async () => {
  const ctx = await setup(), { app, store, map, act, questions, raw } = ctx;
  try {
    const suggestion = (await act({ type: 'suggest', nodeId: map.rootId, title: 'Storage', body: 'Limits.' })).nodes.at(-1);
    for (const [selection, message] of [[[], /Choose 1 to 40/], [Array.from({ length: 41 }, () => ({ nodeId: map.rootId })), /Choose 1 to 40/], [[{ nodeId: suggestion.id }], /not a saved answer or an explored idea/],
      [[{ nodeId: map.rootId, questionId: 'q-nope' }], /not a saved answer/], [[{ nodeId: map.rootId }, { nodeId: map.rootId }], /chosen twice/]]) {
      await assert.rejects(act({ type: 'request-map-job', jobType: ADR_DRAFT, selection }), message, message.source);
    }
    await assert.rejects(act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: ctx.selection, titleHint: 'Sync\nStatus: Accepted' }), /one line/);
    await act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: ctx.selection });
    const packet = await store.claim('agent', map.id), good = draftOf(questions, map);
    for (const [bad, message] of [[{ ...good, decision: undefined }, /Decision is required/], [{ ...good, title: 'x'.repeat(121) }, /at most 120/], [{ ...good, title: 'Sync\nStatus: Accepted' }, /one line/], [{ ...good, context: 'x'.repeat(6001) }, /at most 6000/],
      [{ ...good, refs: [{ nodeId: suggestion.id }] }, /not read for this draft/], [{ ...good, refs: [good.refs[0], good.refs[0]] }, /repeats/], [{ ...good, refs: [] }, /at least one/], [{ ...good, status: 'Accepted' }, /remove status/]]) {
      await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
    }
    await store.fail(map.id, packet.jobId, packet.claimKey, 'Stopped for the test.');
    // An earlier premise's answer is not offered, so it cannot be chosen.
    await raw(current => { current.nodes[0].questions[0].supersededAt = '2026-01-01T00:00:00.000Z'; });
    await assert.rejects(act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: [{ nodeId: map.rootId, questionId: questions[0].id }] }), /not a saved answer/);
    // Five explored ideas with long findings share the room, shortened and marked; forty long questions cannot fit.
    await raw(current => { for (let i = 0; i < 5; i++) current.nodes.push({ id: `node-long000${i}`, title: `Idea ${i}`, kind: 'research', status: 'explored', reviewState: 'unreviewed', summary: 's'.repeat(700), prompt: 'p', body: 'b'.repeat(4000), parentId: map.rootId, questions: [], sources: [], contentRevision: 1, stale: false, createdAt: '2026-01-01T00:00:00.000Z' }); });
    await act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: Array.from({ length: 5 }, (_, i) => ({ nodeId: `node-long000${i}` })) });
    const long = await store.claim('agent', map.id);
    assert.ok(long.records.every(record => record.shortened)); assert.match(long.retrieval, /--section findings/); assert.ok(long.contextCharacters <= 15500);
    await store.fail(map.id, long.jobId, long.claimKey, 'Stopped for the test.');
    await raw(current => { current.nodes.push({ id: 'node-many0000', title: 'Many', kind: 'research', status: 'explored', reviewState: 'unreviewed', summary: 'S', prompt: 'p', body: 'b', parentId: map.rootId, sources: [], contentRevision: 1, stale: false, createdAt: '2026-01-01T00:00:00.000Z', questions: Array.from({ length: 40 }, (_, i) => ({ id: `q-many${String(i).padStart(4, '0')}`, text: `${i}${'q'.repeat(399)}`, answer: 'a'.repeat(1200) })) }); });
    await assert.rejects(act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: Array.from({ length: 40 }, (_, i) => ({ nodeId: 'node-many0000', questionId: `q-many${String(i).padStart(4, '0')}` })) }), /do not fit in one draft/);
  } finally { await app.close(); }
});

test('the save preview suggests the next number and the exact bytes; only the ADR route writes, only an accepted draft, never over a file', async () => {
  const ctx = await setup(), { app, store, workspace, map, http } = ctx;
  try {
    const { proposal, item } = await drafted(ctx);
    const route = `/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`;
    assert.equal((await http(route)).status, 409, 'accept first');
    const save = async extra => http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: 'docs/adr/0001-x.md', sha256: 'x', expectedRevision: (await store.get(map.id)).revision, ...extra });
    let answer = await save();
    assert.equal(answer.status, 409); assert.match(answer.body.error, /Accept the draft before saving/); assert.equal(await exists(path.join(workspace, 'docs')), false, 'nothing created');
    await accept(ctx, proposal, item, item.text.replace('Status: Proposed', 'Status: Accepted'));
    let preview = (await http(route)).body;
    assert.equal(preview.path, `docs/adr/0001-${adrSlug(item.title)}.md`, 'a missing folder starts at 0001'); assert.equal(preview.free, true);
    assert.match(preview.text, new RegExp(`^# .+\\n\\nStatus: Proposed\\nDate: ${adrToday()}\\n\\n## Context`), 'always Proposed, dated in the user\'s own time zone'); assert.equal(preview.sha256, sha(preview.text));
    // A wrong hash, on a missing folder: refused, and the folder is not created.
    answer = await save({ path: preview.path, sha256: sha('something else') });
    assert.equal(answer.status, 409); assert.match(answer.body.error, /changed since you previewed/); assert.equal(await exists(path.join(workspace, 'docs')), false, 'no folder made for a refused save');
    // The action route can never write, whatever it is given; the ADR route always runs a save.
    const viaAction = await http(`/maps/${map.id}/action`, { type: 'adr-save', proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await store.get(map.id)).revision });
    assert.equal(viaAction.status, 403);
    answer = await save({ type: 'review-proposal', decision: 'dismissed', sha256: 'x' });
    assert.match(answer.body.error, /changed since you previewed/, 'the ADR route only saves'); assert.equal((await store.get(map.id)).proposals.at(-1).items[0].review, 'accepted');
    await mkdir(path.join(workspace, 'docs', 'adr'), { recursive: true });
    assert.equal((await http(route)).body.path.slice(9, 13), '0001', 'an empty folder starts at 0001 too');
    await writeFile(path.join(workspace, 'docs', 'adr', '0002-older.md'), 'Older.'); await writeFile(path.join(workspace, 'docs', 'adr', '0007-oldest.md'), 'Kept.'); await writeFile(path.join(workspace, 'docs', 'adr', 'notes.txt'), 'x');
    preview = (await http(route)).body;
    assert.equal(preview.path.slice(0, 14), 'docs/adr/0008-', 'one more than the highest prefix');
    assert.equal((await http(`${route}&path=docs/adr/0007-oldest.md`)).body.free, false, 'the preview says a taken path is taken');
    answer = await save({ path: 'docs/adr/0007-oldest.md', sha256: preview.sha256 });
    assert.equal(answer.status, 409); assert.match(answer.body.error, /already at docs\/adr\/0007-oldest\.md; nothing was written/); assert.equal(await readFile(path.join(workspace, 'docs', 'adr', '0007-oldest.md'), 'utf8'), 'Kept.');
    for (const bad of ['docs/0008-x.md', '/tmp/0008-x.md', 'C:/0008-x.md', 'docs/adr/../0008-x.md', 'docs/adr/../../x/docs/adr/0008-a.md', 'x/docs/adr/0008-a.md', 'docs/adr/0008-x.txt', 'docs/adr/8-x.md', 'docs/adr/0008-X.md', 'docs/adr/sub/0008-x.md', `docs/adr/0008-${'a'.repeat(61)}.md`]) {
      answer = await save({ path: bad, sha256: preview.sha256 });
      assert.equal(answer.status, 400, bad); assert.match(answer.body.error, /NNNN-name\.md/);
    }
    assert.deepEqual((await readdir(path.join(workspace, 'docs', 'adr'))).sort(), ['0002-older.md', '0007-oldest.md', 'notes.txt'], 'nothing written by a refused save');
    answer = await save({ path: preview.path, sha256: preview.sha256 });
    assert.equal(answer.status, 200);
    const written = await readFile(path.join(workspace, preview.path), 'utf8');
    assert.equal(written, preview.text, 'exactly the previewed bytes'); assert.match(written, /^Status: Proposed$/m); assert.match(written, new RegExp(`\\(${map.id}, ${map.rootId}`));
    const recorded = answer.body.proposals.at(-1).items[0].file;
    assert.deepEqual([recorded.path, recorded.sha256], [preview.path, preview.sha256]); assert.ok(recorded.savedAt);
    answer = await save({ path: 'docs/adr/0009-again.md', sha256: preview.sha256 });
    assert.equal(answer.status, 409, 'saved once'); assert.equal(await exists(path.join(workspace, 'docs', 'adr', '0009-again.md')), false);
    // Numbers stop at 9999: the preview still opens, saying the number is taken.
    await writeFile(path.join(workspace, 'docs', 'adr', '9999-last.md'), 'Last.');
    const { proposal: second, item: next } = await drafted(ctx); await accept(ctx, second, next);
    const capped = (await http(`/maps/${map.id}/adr-file?proposal=${second.id}&item=${next.id}`)).body;
    assert.equal(capped.path.slice(0, 14), 'docs/adr/9999-'); assert.equal(capped.free, true, 'a different name under the last number');
  } finally { await app.close(); }
});

test('a failed map save takes the file back, so a retry writes one file under the same number', async () => {
  const ctx = await setup(), { app, store, workspace, map, http } = ctx;
  try {
    const { proposal, item } = await drafted(ctx);
    await accept(ctx, proposal, item);
    const preview = (await http(`/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`)).body;
    const original = store.save;
    store.save = async () => { store.save = original; throw Object.assign(new Error('The disk is full.'), { status: 507 }); };
    const failed = await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await store.get(map.id)).revision });
    assert.notEqual(failed.status, 200); assert.equal(await exists(path.join(workspace, preview.path)), false, 'the file is taken back');
    assert.equal((await store.get(map.id)).proposals.at(-1).items[0].file, undefined);
    const again = (await http(`/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`)).body;
    assert.equal(again.path, preview.path, 'the same number is free again');
    const saved = await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: again.path, sha256: again.sha256, expectedRevision: (await store.get(map.id)).revision });
    assert.equal(saved.status, 200); assert.deepEqual(await readdir(path.join(workspace, 'docs', 'adr')), [path.basename(preview.path)], 'one file');
  } finally { await app.close(); }
});

// Replaces the exclusive open of a file in docs/adr/, once, with `replacement(realOpen, file, flags)`; every other open is real.
const fsp = createRequire(import.meta.url)('node:fs/promises');
async function withAdrOpen(replacement, run) {
  const real = fsp.open;
  fsp.open = (file, flags, ...rest) => {
    if (flags !== 'wx' || !String(file).includes(`${path.sep}adr${path.sep}`)) return real(file, flags, ...rest);
    fsp.open = real; syncBuiltinESMExports();
    return replacement(real, file, flags);
  };
  syncBuiltinESMExports();
  try { return await run(); } finally { fsp.open = real; syncBuiltinESMExports(); }
}
// A new accepted draft, its save preview, and a save of exactly that.
async function readyToSave(ctx, text) {
  const { proposal, item } = await drafted(ctx);
  await accept(ctx, proposal, item, text);
  const preview = (await ctx.http(`/maps/${ctx.map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`)).body;
  const recorded = async () => (await ctx.store.get(ctx.map.id)).proposals.find(entry => entry.id === proposal.id).items[0].file;
  const save = async () => ctx.http(`/maps/${ctx.map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await ctx.store.get(ctx.map.id)).revision });
  return { preview, save, recorded };
}

test('once the map is saved the file stays with its record, even if a version or the readable views fail to write', async () => {
  const ctx = await setup(), { app, store, workspace } = ctx;
  try {
    let ready = await readyToSave(ctx);
    const project = store.project;
    store.project = async () => { store.project = project; throw new Error('README.md is locked.'); };
    let answer = await ready.save();
    assert.equal(answer.status, 500); assert.match(answer.body.error, /readable views could not be generated/);
    assert.equal(await readFile(path.join(workspace, ready.preview.path), 'utf8'), ready.preview.text, 'the file is kept');
    assert.equal((await ready.recorded()).path, ready.preview.path, 'and recorded');
    answer = await ready.save();
    assert.equal(answer.status, 409); assert.match(answer.body.error, /already saved/);
    ready = await readyToSave(ctx);
    const record = store.versions.record;
    store.versions.record = async () => { store.versions.record = record; throw new Error('No room for versions.'); };
    answer = await ready.save();
    assert.equal(answer.status, 500); assert.match(answer.body.error, /version could not be recorded/);
    assert.equal(await exists(path.join(workspace, ready.preview.path)), true); assert.equal((await ready.recorded()).path, ready.preview.path);
  } finally { await app.close(); }
});

test('a write or open that fails, or a link swapped in before the write, leaves no file and no record', async () => {
  const ctx = await setup(), { app, workspace } = ctx;
  try {
    let ready = await readyToSave(ctx);
    let answer = await withAdrOpen(async (open, file, flags) => {
      const handle = await open(file, flags);
      return { stat: options => handle.stat(options), close: () => handle.close(), writeFile: async () => { throw Object.assign(new Error('The disk is full.'), { code: 'ENOSPC' }); } };
    }, ready.save);
    assert.notEqual(answer.status, 200); assert.equal(await exists(path.join(workspace, ready.preview.path)), false, 'a part-written file is taken back');
    assert.equal(await ready.recorded(), undefined);
    answer = await withAdrOpen(async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, ready.save);
    assert.equal(answer.status, 400); assert.match(answer.body.error, /could not be written \(EACCES\)\. Nothing was saved/);
    // docs/adr/ becomes a link between the check and the write: caught after it, and the file taken back.
    const folder = path.join(workspace, 'docs', 'adr'), elsewhere = await mkdtemp(path.join(path.resolve('.test-output'), 'adr-swap-'));
    answer = await withAdrOpen(async (open, file, flags) => { await rename(folder, `${folder}-moved`); await symlink(elsewhere, folder, 'junction'); return open(file, flags); }, ready.save);
    assert.equal(answer.status, 400); assert.match(answer.body.error, /changed while saving; nothing was saved/);
    assert.deepEqual(await readdir(elsewhere), [], 'nothing left through the link'); assert.equal(await ready.recorded(), undefined);
    await rm(folder); await rename(`${folder}-moved`, folder);
    answer = await ready.save();
    assert.equal(answer.status, 200, 'the same save works once the folder is plain again');
  } finally { await app.close(); }
});

test('an existing Docs folder in another case is used; 64 KiB counts bytes, on accepting and on saving', async () => {
  const ctx = await setup(), { app, workspace, store, map } = ctx;
  try {
    await mkdir(path.join(workspace, 'Docs', 'adr'), { recursive: true });
    let ready = await readyToSave(ctx);
    assert.equal((await ready.save()).status, 200); assert.equal(await exists(path.join(workspace, ready.preview.path)), true);
    const { proposal, item } = await drafted(ctx);
    await assert.rejects(accept(ctx, proposal, item, `# T\n${'€'.repeat(21846)}`), /64 KiB/, '21,850 characters, 65,542 bytes');
    await ctx.act({ type: 'review-proposal', proposalId: proposal.id, itemId: item.id, decision: 'dismissed' });
    ready = await readyToSave(ctx, `# T\n${'€'.repeat(21842)}`); // 65,530 bytes accepted; the file's header makes it larger.
    const answer = await ready.save();
    assert.equal(answer.status, 400); assert.match(answer.body.error, /at most 64 KiB/);
    assert.equal(await exists(path.join(workspace, ready.preview.path)), false); assert.equal(store.view(await store.get(map.id)).proposals.at(-1).items[0].file, undefined);
  } finally { await app.close(); }
});

test('a linked docs/ or docs/adr/ is refused, and saving leaves ideas, questions, links and growth unchanged', async () => {
  const ctx = await setup(), { app, store, workspace, map, http } = ctx;
  try {
    const before = content(await store.get(map.id));
    const { proposal, item } = await drafted(ctx);
    await accept(ctx, proposal, item);
    const route = `/maps/${map.id}/adr-file?proposal=${proposal.id}&item=${item.id}`;
    for (const linked of [['docs'], ['docs', 'adr']]) {
      const elsewhere = await mkdtemp(path.join(path.resolve('.test-output'), 'adr-elsewhere-'));
      if (linked.length === 2) await mkdir(path.join(workspace, 'docs'), { recursive: true });
      await symlink(elsewhere, path.join(workspace, ...linked), 'junction');
      assert.match((await http(route)).body.error, /plain folder in this workspace, not a link/, linked.join('/'));
      const answer = await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: 'docs/adr/0001-x.md', sha256: 'x', expectedRevision: (await store.get(map.id)).revision });
      assert.equal(answer.status, 400); assert.deepEqual(await readdir(elsewhere), [], 'nothing written through the link');
      await rm(path.join(workspace, ...linked)); await rm(path.join(workspace, 'docs'), { recursive: true, force: true });
    }
    const preview = (await http(route)).body;
    await http(`/maps/${map.id}/adr-file`, { proposalId: proposal.id, itemId: item.id, path: preview.path, sha256: preview.sha256, expectedRevision: (await store.get(map.id)).revision });
    assert.equal(await exists(path.join(workspace, preview.path)), true);
    assert.equal(content(await store.get(map.id)), before, 'drafting, accepting and saving change no idea, question, link or growth');
  } finally { await app.close(); }
});

test('a draft whose records changed, before or during the work, is marked; the file keeps the user\'s own lines', async () => {
  const ctx = await setup(), { app, store, map, act, raw } = ctx;
  try {
    const { proposal } = await drafted(ctx);
    assert.notEqual(store.view(await store.get(map.id)).proposals.at(-1).stale, true);
    await raw(current => { current.nodes[0].contentRevision++; });
    assert.equal(store.view(await store.get(map.id)).proposals.find(item => item.id === proposal.id).stale, true, 'a record it read changed');
    await act({ type: 'request-map-job', jobType: ADR_DRAFT, selection: ctx.selection });
    const packet = await store.claim('agent', map.id);
    await raw(current => { current.nodes[0].contentRevision++; }); // While the agent worked.
    const saved = await store.complete(map.id, packet.jobId, packet.claimKey, draftOf(ctx.questions, map));
    assert.equal(saved.proposals.at(-1).stale, true, 'kept, marked stale');
  } finally { await app.close(); }
  assert.equal(adrFileText('# T\nStatus: Accepted\nDate: yesterday\n\nIntro.\n\n## Context\n\nDate: 1 Nov was the last outage.\n\n```\na\n\n\n\nb\n```\n', '2026-11-28'),
    '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nIntro.\n\n## Context\n\nDate: 1 Nov was the last outage.\n\n```\na\n\n\n\nb\n```\n', 'only the header is set; the body is kept as written');
  assert.equal(adrFileText('No title.\n', '2026-11-28'), 'Status: Proposed\nDate: 2026-11-28\n\nNo title.\n');
  // Without a "## " heading, and with paragraphs before the first one, every other line is kept, blank ones included.
  assert.equal(adrFileText('# T\n\nStatus: Proposed\nDate: <date saved>\n\n### Context\n\nDate: the outage was 1 November.\n\nPara one.\n\nPara two.\n', '2026-11-28'),
    '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\n### Context\n\nDate: the outage was 1 November.\n\nPara one.\n\nPara two.\n');
  assert.equal(adrFileText('# T\r\n\r\nStatus: Proposed\r\nDate: x\r\n\r\nIntro one.\r\n\r\nIntro two.\r\n\r\n## Context\r\n', '2026-11-28'), '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nIntro one.\n\nIntro two.\n\n## Context\n');
  assert.equal(adrFileText('# T\nStatus: P\nDate: x\n\nDate: the outage.\n', '2026-11-28'), '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nDate: the outage.\n', 'only the first Date line is the header\'s');
  assert.equal(adrFileText('# T\nStatus: P\nDate: x\nDate: the outage.\n', '2026-11-28'), '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nDate: the outage.\n', 'even directly under it');
  assert.equal(adrFileText('# T\nBody.\n', '2026-11-28'), '# T\n\nStatus: Proposed\nDate: 2026-11-28\n\nBody.\n', 'a header the user removed comes back');
  assert.equal(adrSlug('Store notes — on the device!'), 'store-notes-on-the-device'); assert.equal(adrSlug('!!!'), 'decision');
  assert.deepEqual([adrName('docs/adr/0001-a.md'), adrName('docs/adr/../0001-a.md'), adrName(`docs/adr/0001-${'a'.repeat(61)}.md`)], ['0001-a.md', null, null]);
  assert.equal(adrToday(new Date(2026, 10, 28, 23, 30)), '2026-11-28', 'the local date, even late in the evening');
});

test('Map tools keeps Answer in a file\'s status under its own section', async () => {
  const html = await readFile(path.resolve('skills/explore/assets/index.html'), 'utf8');
  assert.ok(html.indexOf('id="answers-import"') < html.indexOf('id="answers-status"') && html.indexOf('id="answers-status"') < html.indexOf('Decision record</h3>'));
});

// The dialog: markup, and its wiring with a small fake DOM.
const fixtureMap = () => {
  const map = { id: 'map-1', revision: 3, rootId: 'root', nodes: [{ id: 'root', parentId: null, title: 'Root <a>', status: 'explored', summary: 'S', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }] }], jobs: [], proposals: [] };
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
  html = adrDialogHtml({ map, esc, listening: false, hint: 'Sync <daily>' });
  assert.match(html, /data-adr-save="item-1" data-proposal="proposal-1">Save to docs\/adr\/<\/button>/); assert.match(html, /<input type="checkbox" data-adr-node="root"> Its findings/); assert.match(html, /data-adr-question="q-1"> Who &lt;edits&gt;\?/);
  assert.match(html, /data-adr-preview="" disabled>/, 'nothing chosen yet'); assert.match(html, /<input id="adr-title-hint" maxlength="120" value="Sync &lt;daily&gt;">/, 'the title typed survives a redraw');
  html = adrDialogHtml({ map, esc, listening: false, save: { itemId: 'item-1', proposalId: 'proposal-1', number: '0003', slug: 'sync-daily', free: true, text: '# Sync <daily>\n', sha256: 'h' } });
  assert.match(html, /Path: docs\/adr\/0003-sync-daily\.md/); assert.match(html, /<pre class="adr-file" tabindex="0" aria-label="The exact file"># Sync &lt;daily&gt;\n<\/pre>/); assert.match(html, /data-adr-write="item-1" data-proposal="proposal-1">Save file/);
  assert.match(adrDialogHtml({ map, esc, listening: false, save: { itemId: 'item-1', proposalId: 'proposal-1', number: '0003', slug: 'sync-daily', free: false, text: '', sha256: 'h' } }), /a file is already there[\s\S]*data-adr-write="item-1" data-proposal="proposal-1" disabled/);
  map.proposals[0].items[0].file = { path: 'docs/adr/0003-sync-daily.md' };
  assert.match(adrDialogHtml({ map, esc, listening: false }), /Saved to <code>docs\/adr\/0003-sync-daily\.md<\/code>/);
  const history = adrDialogHtml({ map: fixtureMap(), esc, listening: false, live: false });
  assert.match(history, /return to the live map/); assert.doesNotMatch(history, /data-adr-(accept|preview|save|send)/);
  const failed = { ...fixtureMap(), proposals: [], jobs: [{ id: 'job-1', type: ADR_DRAFT, status: 'failed', error: 'Too <long>.' }] };
  assert.match(adrDialogHtml({ map: failed, esc, listening: false }), /Your agent could not draft this record\. Too &lt;long&gt;\./);
});

function fakeDialog({ map, act, api }) {
  const elements = new Map(), focused = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false, addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); }, contains: () => false,
        querySelector(selector) {
          // An element's tag must carry every attribute the selector names, as `[a="x"][b="y"]` does.
          const has = (tag, part) => (part.includes('=') ? tag.includes(part) : new RegExp(`\\s${part}[\\s=>]`).test(tag));
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1).split(' ')[0]}"`)
            : (this.innerHTML.match(/<[^>]+>/g) ?? []).some(tag => selector.match(/\[[^\]]+\]/g).every(part => has(tag, part.slice(1, -1))));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, value: '', textContent: '', focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), activeElement: null };
  const dialog = adrDialog({ map, act, api, esc, toast: message => toasts.push(message), live: () => true, listening: () => false });
  const body = element('adr-body');
  const click = dataset => body.fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  return { element, body, dialog, click, focused, toasts };
}

test('the dialog keeps the title and edits, accepts through review-proposal, and saves through the app\'s act on the ADR route', async () => {
  let map = { ...fixtureMap(), proposals: [] };
  const calls = [], routes = [];
  const act = async (...args) => { calls.push(args); if (args[1] === 'review-proposal' && args[2].decision === 'accepted') { map = fixtureMap(); map.proposals[0].items[0].review = 'accepted'; } return true; };
  const api = async route => { routes.push(route); if (route.includes('job-preview')) return { records: [{ questionId: 'q-1' }, {}], mapRevision: map.revision }; if (route.includes('adr-file?')) return { path: 'docs/adr/0004-sync-daily.md', free: true, text: '# Sync\n', sha256: 'abc' }; return {}; };
  const io = fakeDialog({ map: () => map, act, api });
  try {
    await io.element('adr-open').fire('click');
    assert.equal(io.element('adr-dialog').open, true); assert.equal(io.focused.at(-1), '[data-adr-node]');
    await io.body.fire('input', { target: { id: 'adr-title-hint', dataset: {}, value: 'Sync daily' } }); // Typed before Preview.
    await io.body.fire('change', { target: { closest: () => ({ dataset: { adrNode: 'root', adrQuestion: 'q-1' }, checked: true }) } });
    await io.body.fire('change', { target: { closest: () => ({ dataset: { adrNode: 'root' }, checked: true }) } });
    await io.click({ adrPreview: '' });
    assert.equal(routes.at(-1), `/maps/map-1/job-preview?type=adr-draft&selection=${encodeURIComponent(JSON.stringify([{ nodeId: 'root', questionId: 'q-1' }, { nodeId: 'root' }]))}`);
    assert.match(io.body.innerHTML, /Your agent will read 1 answer and the findings of 1 idea/); assert.match(io.body.innerHTML, /value="Sync daily"/, 'the title survives the preview');
    await io.click({ adrSend: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: ADR_DRAFT, selection: [{ nodeId: 'root', questionId: 'q-1' }, { nodeId: 'root' }], titleHint: 'Sync daily' }]);
    map = fixtureMap(); io.dialog.mapChanged();
    await io.body.fire('input', { target: { dataset: { adrText: 'item-1' }, value: '# Mine' } });
    // A poll while the user types never redraws.
    const typing = io.body.innerHTML;
    globalThis.document.activeElement = { closest: () => ({}) }; io.body.contains = () => true;
    map = { ...fixtureMap(), revision: 9, jobs: [{ id: 'job-2', type: ADR_DRAFT, status: 'queued' }] }; io.dialog.mapChanged();
    assert.equal(io.body.innerHTML, typing, 'no redraw while typing');
    globalThis.document.activeElement = null; io.body.contains = () => false;
    map = { ...fixtureMap(), revision: 4 }; io.dialog.mapChanged();
    assert.match(io.body.innerHTML, /># Mine<\/textarea>/, 'a poll keeps the edit');
    await io.click({ adrAccept: 'item-1', proposal: 'proposal-1' });
    assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'accepted', text: '# Mine' }]); assert.equal(io.focused.at(-1), '[data-adr-save="item-1"]');
    await io.click({ adrSave: 'item-1', proposal: 'proposal-1' });
    assert.match(routes.at(-1), /\/maps\/map-1\/adr-file\?proposal=proposal-1&item=item-1$/); assert.match(io.body.innerHTML, /Path: docs\/adr\/0004-sync-daily\.md/); assert.equal(io.focused.at(-1), '#adr-number');
    await io.body.fire('input', { target: { id: 'adr-slug', dataset: {}, value: 'sync-every-day' } });
    assert.match(io.body.querySelector('#adr-path').textContent, /docs\/adr\/0004-sync-every-day\.md/, 'the path follows the name');
    await io.click({ adrWrite: 'item-1', proposal: 'proposal-1' });
    const [nodeId, type, input, options] = calls.at(-1);
    assert.deepEqual([nodeId, type, input, options.route], [null, 'adr-save', { proposalId: 'proposal-1', itemId: 'item-1', path: 'docs/adr/0004-sync-every-day.md', sha256: 'abc' }, 'adr-file'], 'through act, on the ADR route');
    assert.equal(io.toasts.at(-1), 'Saved to docs/adr/0004-sync-every-day.md.');
    // Copy gives the file as it would be saved, dated today.
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => copied.push(text) } }, configurable: true });
    await io.click({ adrCopy: 'item-1' });
    assert.match(copied[0], new RegExp(`^# Sync <daily>\\n\\nStatus: Proposed\\nDate: ${adrToday()}\\n`)); assert.doesNotMatch(copied[0], /<date saved>/);
  } finally { delete globalThis.document; }
});

test('a redraw keeps focus on the same answer\'s box, and a saved record copies with the day it was saved', async () => {
  assert.equal(controlKey({ id: '', dataset: { adrNode: 'root', adrQuestion: 'q-2' } }), '[data-adr-node="root"][data-adr-question="q-2"]');
  assert.notEqual(controlKey({ dataset: { adrNode: 'root', adrQuestion: 'q-1' } }), controlKey({ dataset: { adrNode: 'root', adrQuestion: 'q-2' } }));
  assert.equal(controlKey({ id: 'adr-number', dataset: { adrNode: 'root' } }), '#adr-number'); assert.equal(controlKey({ dataset: {} }), null);
  let map = fixtureMap();
  map.proposals[0].items[0].review = 'accepted';
  map.nodes[0].questions.push({ id: 'q-2', text: 'How often?', answer: 'Daily.' });
  const io = fakeDialog({ map: () => map, act: async () => true, api: async () => ({}) });
  try {
    await io.element('adr-open').fire('click');
    globalThis.document.activeElement = { id: '', dataset: { adrNode: 'root', adrQuestion: 'q-2' }, closest: () => null }; io.body.contains = element => !!element;
    // A poll brings another change (the first answer reworded) while the second answer's box has focus.
    map = { ...map, revision: 4, nodes: [{ ...map.nodes[0], questions: [{ ...map.nodes[0].questions[0], text: 'Who edits now?' }, map.nodes[0].questions[1]] }] }; io.dialog.mapChanged();
    assert.match(io.body.innerHTML, /Who edits now\?/, 'redrawn');
    assert.equal(io.focused.at(-1), '[data-adr-node="root"][data-adr-question="q-2"]');
    globalThis.document.activeElement = null; io.body.contains = () => false;
    map.proposals[0].items[0].file = { path: 'docs/adr/0001-sync-daily.md', savedAt: new Date(2026, 0, 2, 12).toISOString() };
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => copied.push(text) } }, configurable: true });
    await io.click({ adrCopy: 'item-1' });
    assert.match(copied[0], /\nDate: 2026-01-02\n/, 'the file as saved, not re-dated today');
  } finally { delete globalThis.document; }
});
