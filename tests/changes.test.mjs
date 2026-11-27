import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareMaps, changesMarkdown } from '../skills/explore/scripts/changes.mjs';
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
  const markdown = changesMarkdown(compareMaps(before, after), { before: 'Commit `abc1234`', after: 'current saved map, revision 7 (may include uncommitted changes)', limit: 10 });
  assert.match(markdown, /^# Changes in Field notebook/m); assert.match(markdown, /Commit `abc1234` → current saved map, revision 7/);
  assert.match(markdown, /\\<b\\>\\`tick\\`\\<\/b\\> \\\*bold\\\*/, 'escaped like the brief');
  assert.match(markdown, /20 more not shown/);
});

async function repo() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'changes-'));
  const git = (...args) => exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: dir });
  await git('init', '-q');
  return { dir, git };
}

test('the server compares a committed map with the saved one, read-only, and refuses unsafe refs', async () => {
  const { dir, git } = await repo();
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
    assert.equal(response.counts.ideasAdded, 1); assert.match(response.markdown, /Sync/); assert.match(response.before, /^Commit `[0-9a-f]{7}`/);
    assert.equal((await git('status', '--porcelain')).stdout, status, 'Git is unchanged');
    for (const ref of ['--output=x', '', 'no-such-ref', 'a b']) assert.equal((await get(ref)).status, 400, ref);
    const missing = await (await get(`${(await git('rev-list', '--max-parents=0', 'HEAD')).stdout.trim()}`)).json();
    assert.ok(missing.counts, 'the first commit still compares');
  } finally { await app.close(); }
});

test('the CLI writes the change summary as Markdown', async () => {
  const { dir, git } = await repo();
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const saved = await app.store.create({ title: 'Field notebook', idea: 'Notes.' });
    await git('add', '-A'); await git('commit', '-q', '-m', 'first');
    await app.store.action(saved.id, { expectedRevision: (await app.store.get(saved.id)).revision, nodeId: saved.rootId, type: 'suggest', title: 'Batteries', body: 'x' });
    const { stdout } = await exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), 'changes', '--map', saved.id, '--since', 'HEAD', '--format', 'markdown', '--workspace', dir]);
    assert.match(stdout, /# Changes in Field notebook/); assert.match(stdout, /Batteries/);
  } finally { await app.close(); }
});
