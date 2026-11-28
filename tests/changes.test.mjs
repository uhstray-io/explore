import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareMaps, changesMarkdown, mapAtCommit } from '../skills/explore/scripts/changes.mjs';
import { textState } from '../skills/explore/assets/changes-dialog.js';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';

// Change summary since a Git commit (E4, #23). Illustrative maps and disposable repositories only.
const exec = promisify(execFile);
const node = (id, extra = {}) => ({ id, title: `Idea ${id}`, kind: 'research', parentId: 'root', prompt: `Premise ${id}.`, body: `Premise ${id}.`, summary: `Premise ${id}.`, status: 'suggested', reviewState: 'unreviewed', stale: false, questions: [], sources: [], ...extra });
const map = (nodes, edges = []) => ({ id: 'map-a', title: 'Field notebook', rootId: 'root', nodes: [node('root', { parentId: null }), ...nodes], edges, jobs: [], history: [] });

test('changes are matched by ID: ideas, premises, answers, questions, links and findings', () => {
  const before = map([
    node('kept', { questions: [{ id: 'q1', text: 'Who edits?', answer: null }, { id: 'q2', text: 'How long?', answer: 'A week.' }, { id: 'q3', text: 'Which phones?', answer: null }] }),
    node('gone'), node('revised'), node('found', { status: 'running' })], [{ from: 'kept', to: 'revised', type: 'depends_on' }]);
  const after = map([
    node('kept', { questions: [{ id: 'q1', text: 'Who edits?', answer: 'Two of us.' }, { id: 'q2', text: 'How long?', answer: 'Two weeks.' }, { id: 'q3', text: 'Which phones?', answer: null, supersededAt: 'x' }, { id: 'q4', text: 'Who pays?', answer: null }] }),
    node('revised', { prompt: 'A different premise.' }), node('found', { status: 'explored', completedAt: 'x', summary: 'Mesh works.', body: 'Mesh works.', reviewState: 'accepted', stale: true }), node('new', { title: 'Batteries' })],
    [{ from: 'new', to: 'kept', type: 'supports', addedBy: 'user', note: 'Power matters.' }]);
  const result = compareMaps(before, after);
  assert.deepEqual(result.ideas.added.map(n => n.id), ['new']); assert.deepEqual(result.ideas.removed.map(n => n.id), ['gone']);
  assert.deepEqual(result.ideas.premiseChanged.map(n => n.id), ['revised'], 'a revised premise is a change, not a removal and an addition');
  assert.deepEqual(result.answers.given.map(a => a.questionId), ['q1']); assert.deepEqual(result.answers.changed.map(a => a.questionId), ['q2']);
  assert.deepEqual(result.questions.opened.map(q => q.questionId), ['q4']); assert.deepEqual(result.questions.closed.map(q => [q.questionId, q.how]), [['q1', 'answered'], ['q3', 'superseded']]);
  assert.deepEqual(result.links.added.map(l => [l.from, l.to, l.type, l.addedBy, l.note]), [['new', 'kept', 'supports', 'user', 'Power matters.']]);
  assert.deepEqual(result.links.removed.map(l => [l.from, l.to, l.type]), [['kept', 'revised', 'depends_on']]);
  assert.deepEqual(result.findings.map(f => [f.id, f.changes]), [['found', ['summary changed', 'completed', 'accepted', 'flagged for review']]]);
});

test('the Markdown names both sides, shows user text literally, and says what it leaves out', () => {
  const before = map([]), after = map(Array.from({ length: 30 }, (_, i) => node(`n${i}`, { title: i === 0 ? '<b>`tick`</b> *bold*' : `Idea ${i}` })));
  const sha = 'abc1234'.padEnd(40, '0');
  const markdown = changesMarkdown(compareMaps(before, after), { before: { sha, ref: 'HEAD~1', existed: true }, after: { revision: 7 }, limit: 10 });
  assert.match(markdown, /^# Changes in Field notebook/m); assert.match(markdown, /Commit `abc1234` \(HEAD\\~1\) → current saved map, revision 7 \(may include uncommitted changes\)/);
  assert.match(changesMarkdown(compareMaps(before, after), { before: { sha, ref: 'ABC12', existed: false }, after: { revision: 7 } }), /Commit `abc1234`, before this map existed →/, 'a hash the user typed is not repeated');
  assert.match(markdown, /\\<b\\>\\`tick\\`\\<\/b\\> \\\*bold\\\*/, 'escaped like the brief');
  assert.match(markdown, /20 more not shown/);
});

async function repo(t) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'changes-'));
  const git = (...args) => exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: dir });
  try { await git('init', '-q'); } catch { t.skip('Git is not available.'); return null; }
  return { dir, git };
}

test('the server compares a committed map with the saved one, read-only, and refuses unsafe refs', async t => {
  const fixture = await repo(t); if (!fixture) return;
  const { dir, git } = fixture;
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    let saved = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
    await git('add', '-A'); await git('commit', '-q', '-m', 'first');
    saved = await app.store.action(saved.id, { expectedRevision: (await app.store.get(saved.id)).revision, nodeId: saved.rootId, type: 'suggest', title: 'Sync', body: 'How notes sync.' });
    await git('add', '-A'); await git('commit', '-q', '-m', 'second');
    const status = (await git('status', '--porcelain')).stdout;
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const get = async since => fetch(`${app.address}/api/maps/${saved.id}/changes?since=${encodeURIComponent(since)}`, { headers: { Authorization: `Bearer ${token}` } });
    const response = await (await get('HEAD~1')).json();
    assert.equal(response.counts.ideasAdded, 1); assert.match(response.markdown, /Sync/);
    assert.match(response.before.sha, /^[0-9a-f]{40}$/); assert.deepEqual([response.before.ref, response.before.existed, typeof response.after.revision], ['HEAD~1', true, 'number'], 'plain fields, not Markdown');
    assert.equal((await git('status', '--porcelain')).stdout, status, 'Git is unchanged');
    for (const ref of ['--output=x', '', 'no-such-ref', 'a b']) assert.equal((await get(ref)).status, 400, ref);
  } finally { await app.close(); }
});

test('the CLI writes the change summary as Markdown', async t => {
  const fixture = await repo(t); if (!fixture) return;
  const { dir, git } = fixture;
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const saved = await app.store.create({ title: 'Field notebook', idea: 'Notes.' });
    await git('add', '-A'); await git('commit', '-q', '-m', 'first');
    await app.store.action(saved.id, { expectedRevision: (await app.store.get(saved.id)).revision, nodeId: saved.rootId, type: 'suggest', title: 'Batteries', body: 'x' });
    const { stdout } = await exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), 'changes', '--map', saved.id, '--since', 'HEAD', '--format', 'markdown', '--workspace', dir]);
    assert.match(stdout, /# Changes in Field notebook/); assert.match(stdout, /Batteries/);
  } finally { await app.close(); }
});

test('a revised premise on unfinished work is a premise change, never a finding', () => {
  const before = map([node('idea')]), after = map([node('idea', { prompt: 'A new premise.', body: 'A new premise.', summary: 'A new premise.' })]);
  const result = compareMaps(before, after);
  assert.deepEqual(result.ideas.premiseChanged.map(n => n.id), ['idea']);
  assert.deepEqual(result.findings, []);
});

test('each question is classified once: an answer set aside and a question saved for later are both reported', () => {
  const before = map([node('idea', { questions: [{ id: 'q5', text: 'Which phones?', answer: 'Android only.' }] })]);
  const after = map([node('idea', { questions: [{ id: 'q5', text: 'Which phones?', answer: 'Android only.', supersededAt: 'x' }, { id: 'q6', text: 'Who pays?', answer: null, deferredAt: 'x' }] })]);
  const result = compareMaps(before, after);
  assert.deepEqual(result.questions.closed.map(q => [q.questionId, q.how]), [['q5', 'superseded']]);
  assert.deepEqual(result.questions.opened, [], 'a question saved for later is not waiting');
  assert.deepEqual(result.questions.savedForLater.map(q => q.questionId), ['q6']);
  assert.match(changesMarkdown(result, { before: { sha: 'f'.repeat(40), ref: 'HEAD', existed: true }, after: { revision: 2 } }), /## Saved for later\n\n- Who pays\?/);
});

test('closed means it was open at the commit, or its answer was set aside since', () => {
  const asked = (id, extra) => ({ id, text: `Question ${id}?`, answer: null, ...extra });
  const before = map([node('idea', { questions: [asked('a', { supersededAt: 'x', answer: 'Old.' }), asked('b', { dismissedAt: 'x' }), asked('c', { answer: 'Yes.' }), asked('d', { deferredAt: 'x' })] })]);
  const after = map([node('idea', { questions: [asked('a', { answer: 'New.' }), asked('b', { answer: 'Later yes.' }), asked('c', { answer: 'Yes.', dismissedAt: 'x' }), asked('d', { answer: 'Done.' })] })]);
  assert.deepEqual(compareMaps(before, after).questions.closed.map(q => [q.questionId, q.how]), [['c', 'dismissed'], ['d', 'answered']]);
});

test('a ref is shown literally, tildes included', () => {
  const markdown = changesMarkdown(compareMaps(map([]), map([])), { before: { sha: 'f'.repeat(40), ref: 'a~1~2', existed: true }, after: { revision: 2 } });
  assert.match(markdown, /\(a\\~1\\~2\)/);
});

test('the Markdown says when nothing changed, and a long summary is cut between lines with a count', () => {
  const sides = { before: { sha: 'f'.repeat(40), ref: 'HEAD', existed: true }, after: { revision: 2 } };
  assert.match(changesMarkdown(compareMaps(map([]), map([])), sides), /Nothing changed in ideas, answers, questions, links or findings\./);
  const many = map(Array.from({ length: 3000 }, (_, i) => node(`n${i}`, { title: `Idea ${i} ${'x'.repeat(80)}` })));
  const markdown = changesMarkdown(compareMaps(map([]), many), { ...sides, limit: 5000 });
  assert.ok(markdown.length < 201000);
  assert.match(markdown, /\n\n_\d+ more lines are not shown: this summary is limited to 200,000 characters\._\n$/);
  assert.match(markdown.split('\n\n_')[0], /\)$/, 'the cut falls between whole lines');
});

test('opening the dialog again makes the text for another map, and marks it out of date only when the map moved on', () => {
  assert.equal(textState(null, 'map-a', 3), 'make');
  assert.equal(textState({ mapId: 'map-a', revision: 3 }, 'map-b', 3), 'make', 'another map never shows this text');
  assert.equal(textState({ mapId: 'map-a', revision: 3 }, 'map-a', 3), 'current');
  assert.equal(textState({ mapId: 'map-a', revision: 4 }, 'map-a', 3), 'current', 'a view a poll behind the server is not a change');
  assert.equal(textState({ mapId: 'map-a', revision: 3 }, 'map-a', 4), 'out-of-date');
});

// A committed map at HEAD in a fresh repository, written by `shape(bytes)`.
async function committed(t, shape = bytes => bytes) {
  const fixture = await repo(t); if (!fixture) return null;
  const store = new Store(path.join(fixture.dir, 'ideas')), saved = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const file = store.file(saved.id), bytes = await readFile(file);
  await writeFile(file, shape(bytes)); await fixture.git('add', '-A'); await fixture.git('commit', '-q', '-m', 'map');
  await writeFile(file, bytes);
  return { ...fixture, store, saved, folder: path.dirname(file) };
}
const json = change => bytes => { const value = JSON.parse(bytes.toString('utf8')); change(value); return JSON.stringify(value); };

test('a map that did not exist at the commit is reported as new, with every idea added', async t => {
  const fixture = await repo(t); if (!fixture) return;
  await writeFile(path.join(fixture.dir, 'README.md'), 'Fixture.\n'); await fixture.git('add', '-A'); await fixture.git('commit', '-q', '-m', 'before the map');
  const app = await startServer({ workspace: fixture.dir, port: 0 });
  try {
    const saved = await app.store.create({ title: 'Field notebook', idea: 'Notes.' });
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const response = await (await fetch(`${app.address}/api/maps/${saved.id}/changes?since=HEAD`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(response.before.existed, false); assert.equal(response.counts.ideasAdded, 1);
    assert.match(response.markdown, /before this map existed/);
  } finally { await app.close(); }
});

test('a folder outside any repository and a missing Git each give a clear error', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'explore-norepo-')), outside = path.join(temporary, 'map-0000000a'); await mkdir(outside);
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const fixture = await repo(t); if (!fixture) return;
  await assert.rejects(mapAtCommit(outside, 'HEAD'), error => error.status === 400 && /not inside a Git repository/.test(error.message));
  await assert.rejects(mapAtCommit(fixture.dir, 'HEAD', { binary: 'explore-no-such-git' }), error => error.status === 503 && /Git is not installed/.test(error.message));
});

test('a committed map is read by the same rules as a saved one', async t => {
  const bom = await committed(t, bytes => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])); if (!bom) return;
  assert.equal((await mapAtCommit(bom.folder, 'HEAD')).map.id, bom.saved.id, 'a byte-order mark is ignored, as the Store ignores it');
  const newer = await committed(t, json(value => { value.schemaVersion = 2; }));
  await assert.rejects(mapAtCommit(newer.folder, 'HEAD'), error => error.status === 422 && /unsupported format version/.test(error.message));
  const broken = await committed(t, json(value => { value.nodes = [null]; }));
  await assert.rejects(mapAtCommit(broken.folder, 'HEAD'), error => error.status === 422 && /missing required parts/.test(error.message));
});

test('a commit whose map Git cannot read is an error, not a map that did not exist yet', async t => {
  const fixture = await committed(t); if (!fixture) return;
  const blob = (await fixture.git('rev-parse', `HEAD:ideas/${fixture.saved.id}/map.json`)).stdout.trim();
  const object = path.join(fixture.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  await chmod(object, 0o666); await rm(object);
  await assert.rejects(mapAtCommit(fixture.folder, 'HEAD'), error => error.status === 503 && /could not read the map/.test(error.message));
});

test('reading a commit never fetches, even in a partial clone', async t => {
  // Git 2.44 added GIT_NO_LAZY_FETCH; older Git ignores it (see bridge.md).
  const version = (await exec('git', ['--version']).catch(() => ({ stdout: '' }))).stdout.match(/(\d+)\.(\d+)/);
  if (!version || Number(version[1]) * 1000 + Number(version[2]) < 2044) { t.skip('Needs Git 2.44 or later.'); return; }
  const source = await committed(t); if (!source) return;
  await source.git('config', 'uploadpack.allowFilter', 'true');
  const clone = await mkdtemp(path.join(path.resolve('.test-output'), 'changes-clone-'));
  await exec('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(source.dir).href, clone]);
  const missing = async () => (await exec('git', ['rev-list', '--objects', '--missing=print', 'HEAD'], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } })).stdout.split('\n').filter(line => line.startsWith('?')).length;
  const before = await missing(); assert.ok(before > 0, 'the clone starts without blobs');
  const folder = path.join(clone, 'ideas', source.saved.id); await mkdir(folder, { recursive: true });
  await assert.rejects(mapAtCommit(folder, 'HEAD'), error => error.status === 503);
  assert.equal(await missing(), before, 'nothing was fetched');
});
