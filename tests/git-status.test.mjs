import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mapGitStatus } from '../skills/explore/scripts/git.mjs';
import { gitStatusLabel, gitStatusDetail } from '../skills/explore/assets/workspace-view.js';
import { startServer } from '../skills/explore/scripts/server.mjs';

// Git status for a map (H9, #38). Disposable repositories under .test-output; the no-repository case
// lives in the system temp folder, outside any repository.
const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd });
async function repo() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'git-'));
  await git(dir, 'init', '-q');
  const folder = path.join(dir, 'ideas', 'map-0000abcd');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'map.json'), '{"v":1}\n');
  return { dir, folder };
}
const commitAll = (dir, message = 'save') => git(dir, 'commit', '-q', '-am', message).catch(() => git(dir, 'add', '-A').then(() => git(dir, 'commit', '-q', '-m', message)));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');

test('a map file is new, committed, modified, staged or both', async () => {
  const { dir, folder } = await repo();
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', untracked: true, branch: 'main', upstream: false });
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', 'first');
  assert.deepEqual(await mapGitStatus(folder), { state: 'committed', branch: 'main', upstream: false });
  await writeFile(path.join(folder, 'map.json'), '{"v":2}\n');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: false, unstaged: true, branch: 'main', upstream: false });
  await git(dir, 'add', 'ideas/map-0000abcd/map.json');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: true, unstaged: false, branch: 'main', upstream: false });
  await writeFile(path.join(folder, 'map.json'), '{"v":3}\n');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: true, unstaged: true, branch: 'main', upstream: false });
});

test('ignored maps, conflicts, detached heads and upstreams are reported as such', async () => {
  const { dir, folder } = await repo();
  await writeFile(path.join(dir, '.gitignore'), 'ideas/\n');
  assert.equal((await mapGitStatus(folder)).state, 'ignored');
  await writeFile(path.join(dir, '.gitignore'), '');
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', 'first');
  // Two branches change the map; merging them leaves it unmerged.
  await git(dir, 'checkout', '-q', '-b', 'other'); await writeFile(path.join(folder, 'map.json'), '{"v":"other"}\n'); await commitAll(dir, 'other');
  await git(dir, 'checkout', '-q', 'main'); await writeFile(path.join(folder, 'map.json'), '{"v":"main"}\n'); await commitAll(dir, 'main');
  await git(dir, 'merge', '-q', 'other').catch(() => {});
  assert.equal((await mapGitStatus(folder)).state, 'conflict');
  await git(dir, 'merge', '--abort');
  await git(dir, 'checkout', '-q', '--detach');
  assert.equal((await mapGitStatus(folder)).branch, 'detached');
  await git(dir, 'checkout', '-q', 'main');
  await git(dir, 'branch', '-q', '--set-upstream-to=other');
  const tracked = await mapGitStatus(folder);
  assert.equal(tracked.upstream, true); assert.equal(tracked.ahead, 1); assert.equal(tracked.behind, 1);
});

test('outside a repository, or without Git, the state says so', async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'explore-norepo-'));
  await writeFile(path.join(outside, 'map.json'), '{}\n');
  assert.deepEqual(await mapGitStatus(outside), { state: 'no-repository' });
  const { folder } = await repo();
  assert.deepEqual(await mapGitStatus(folder, { binary: 'git-that-does-not-exist' }), { state: 'unknown' });
});

test('checking changes nothing in the repository', async () => {
  const { dir, folder } = await repo();
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', 'first');
  await writeFile(path.join(folder, 'map.json'), '{"v":2}\n');
  const index = await hash(path.join(dir, '.git', 'index')), refs = (await git(dir, 'show-ref')).stdout, log = (await git(dir, 'log', '--oneline')).stdout;
  for (let i = 0; i < 3; i++) await mapGitStatus(folder);
  assert.equal(await hash(path.join(dir, '.git', 'index')), index);
  assert.equal((await git(dir, 'show-ref')).stdout, refs); assert.equal((await git(dir, 'log', '--oneline')).stdout, log);
  await assert.rejects(git(dir, 'rev-parse', '--verify', '-q', 'refs/stash'));
});

test('the label and its details say where the map stands, in plain words', () => {
  assert.equal(gitStatusLabel({ state: 'committed', branch: 'main' }), 'Saved · committed on main');
  assert.equal(gitStatusLabel({ state: 'committed', branch: 'detached' }), 'Saved · committed');
  assert.equal(gitStatusLabel({ state: 'not-committed' }), 'Saved locally · not committed');
  assert.equal(gitStatusLabel({ state: 'conflict' }), 'Git conflict · resolve before editing');
  assert.equal(gitStatusLabel({ state: 'no-repository' }), 'Saved locally · no Git repository');
  assert.equal(gitStatusLabel({ state: 'ignored' }), 'Saved locally · ignored by Git');
  assert.equal(gitStatusLabel({ state: 'unknown' }), 'Saved in this repo');
  assert.equal(gitStatusLabel(null), 'Saved in this repo');
  const detail = gitStatusDetail({ state: 'committed', branch: 'main', upstream: true, ahead: 2, behind: 0, checkedAt: '2026-11-27T10:00:00.000Z' });
  assert.match(detail, /Branch main · 2 ahead, 0 behind its upstream/); assert.match(detail, /Checked /); assert.match(detail, /the remote may be newer/);
  assert.match(gitStatusDetail({ state: 'not-committed', staged: true, unstaged: false, branch: 'main', upstream: false, checkedAt: '2026-11-27T10:00:00.000Z' }), /staged, not committed · Branch main · no upstream/i);
});

test('the server reports a map\'s status without paths or raw Git output, even for a map it cannot open', async () => {
  const { dir } = await repo();
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const get = route => fetch(app.address + '/api' + route, { headers: { Authorization: `Bearer ${token}` } });
    const map = await app.store.create({ title: 'Field notebook', idea: 'Offline notes.' });
    const status = await (await get(`/maps/${map.id}/git-status`)).json();
    assert.equal(status.state, 'not-committed'); assert.match(status.checkedAt, /^\d{4}-/);
    assert.ok(!JSON.stringify(status).includes(dir) && !JSON.stringify(status).includes('\\\\'));
    // The fixture folder holds a map.json the server cannot open; its status still comes back.
    assert.equal((await (await get('/maps/map-0000abcd/git-status')).json()).state, 'not-committed');
    assert.equal((await get('/maps/map-99999999/git-status')).status, 404);
  } finally { await app.close(); }
});
