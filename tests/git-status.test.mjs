import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mapGitStatus, parseStatus, git as runGit } from '../skills/explore/scripts/git.mjs';
import { gitStatusLabel, gitStatusDetail, gitCheckDelay } from '../skills/explore/assets/workspace-view.js';
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
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', untracked: true, branch: 'main' });
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-q', '-m', 'first');
  assert.deepEqual(await mapGitStatus(folder), { state: 'committed', branch: 'main' });
  await writeFile(path.join(folder, 'map.json'), '{"v":2}\n');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: false, unstaged: true, branch: 'main' });
  await git(dir, 'add', 'ideas/map-0000abcd/map.json');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: true, unstaged: false, branch: 'main' });
  await writeFile(path.join(folder, 'map.json'), '{"v":3}\n');
  assert.deepEqual(await mapGitStatus(folder), { state: 'not-committed', staged: true, unstaged: true, branch: 'main' });
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
  assert.deepEqual(await mapGitStatus(folder), { state: 'committed', detached: true });
  await git(dir, 'checkout', '-q', 'main');
  await git(dir, 'branch', '-q', '--set-upstream-to=other');
  assert.deepEqual((await mapGitStatus(folder)).upstream, { ahead: 1, behind: 1 });
  // An upstream whose branch was deleted is gone, not in sync.
  await git(dir, 'branch', '-q', '-D', 'other');
  assert.deepEqual((await mapGitStatus(folder)).upstream, { gone: true });
  // A branch really named "detached" keeps its name.
  await git(dir, 'checkout', '-q', '-b', 'detached');
  assert.deepEqual(await mapGitStatus(folder), { state: 'committed', branch: 'detached' });
});

test('the status parser reads renames, a deleted upstream, detached heads and real branch names', () => {
  const entry = path => `1 .M N... 100644 100644 100644 abc abc ${path}`;
  assert.deepEqual(parseStatus(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3', entry('map.json'), ''].join('\0')),
    { file: { state: 'not-committed', staged: false, unstaged: true }, where: { branch: 'main', upstream: { ahead: 2, behind: 3 } } });
  assert.deepEqual(parseStatus(['# branch.head main', '# branch.upstream origin/gone', ''].join('\0')), { file: null, where: { branch: 'main', upstream: { gone: true } } });
  assert.deepEqual(parseStatus(['# branch.head (detached)', ''].join('\0')).where, { detached: true });
  assert.deepEqual(parseStatus(['# branch.head detached', ''].join('\0')).where, { branch: 'detached' });
  // A rename is followed by its old path, which is not an entry of its own.
  assert.deepEqual(parseStatus(['# branch.head main', '2 R. N... 100644 100644 100644 abc abc R100 map.json', '? old.json', ''].join('\0')).file, { state: 'not-committed', staged: true, unstaged: false });
  assert.deepEqual(parseStatus('u UU N... 100644 100644 100644 100644 a b c map.json\0').file, { state: 'conflict' });
  assert.deepEqual(parseStatus('! map.json\0').file, { state: 'ignored' });
});

test('outside a repository, without Git, or when Git is too slow, the state says so', async t => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'explore-norepo-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'map.json'), '{}\n');
  assert.deepEqual(await mapGitStatus(outside), { state: 'no-repository' });
  const { folder } = await repo();
  assert.deepEqual(await mapGitStatus(folder, { binary: 'git-that-does-not-exist' }), { state: 'unknown' });
  // A timeout is unknown, never "no repository".
  assert.deepEqual(await mapGitStatus(folder, { timeout: 1 }), { state: 'unknown' });
  assert.equal((await runGit(['status'], { cwd: folder, timeout: 1 })).outcome, 'failed');
  assert.equal((await runGit(['rev-parse', '--verify', '-q', 'no-such-ref'], { cwd: folder })).outcome, 'exit');
  assert.equal((await runGit(['status'], { cwd: folder, binary: 'git-that-does-not-exist' })).outcome, 'missing');
});

test('inherited Git variables cannot point the check at another repository', async t => {
  const { folder } = await repo();
  const other = await repo();
  await git(other.dir, 'add', '-A'); await git(other.dir, 'commit', '-q', '-m', 'other');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other.dir, '.git');
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  assert.equal((await mapGitStatus(folder)).state, 'not-committed', 'its own repository, where the map is new');
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
  assert.equal(gitStatusLabel({ state: 'committed', branch: 'detached' }), 'Saved · committed on detached');
  assert.equal(gitStatusLabel({ state: 'committed', detached: true }), 'Saved · committed');
  assert.equal(gitStatusLabel({ state: 'not-committed' }), 'Saved locally · not committed');
  assert.equal(gitStatusLabel({ state: 'conflict' }), 'Git conflict · merge not finished');
  assert.match(gitStatusDetail({ state: 'conflict', branch: 'main' }), /stage it \(git add\) and finish the merge/);
  assert.equal(gitStatusLabel({ state: 'no-repository' }), 'Saved locally · no Git repository');
  assert.equal(gitStatusLabel({ state: 'ignored' }), 'Saved locally · ignored by Git');
  assert.equal(gitStatusLabel({ state: 'unknown' }), 'Saved in this repo');
  assert.equal(gitStatusLabel(null), 'Saved in this repo');
  const detail = gitStatusDetail({ state: 'committed', branch: 'main', upstream: { ahead: 2, behind: 0 }, checkedAt: '2026-11-27T10:00:00.000Z' });
  assert.match(detail, /Branch main · 2 ahead, 0 behind its upstream/); assert.match(detail, /Checked /); assert.match(detail, /the remote may be newer/);
  assert.match(gitStatusDetail({ state: 'not-committed', staged: true, unstaged: false, branch: 'main', checkedAt: '2026-11-27T10:00:00.000Z' }), /staged, not committed · Branch main · no upstream/i);
  assert.match(gitStatusDetail({ state: 'committed', branch: 'main', upstream: { gone: true } }), /Branch main · its upstream branch is gone/);
  assert.match(gitStatusDetail({ state: 'committed', detached: true }), /Detached HEAD · no upstream/);
  assert.match(gitStatusDetail({ state: 'committed', branch: 'detached' }), /Branch detached/);
  assert.match(gitStatusDetail({ state: 'unknown' }), /could not be checked/);
});

test('Git is asked at once when forced or for another map, otherwise at most every 10 seconds', () => {
  const last = { mapId: 'map-a', at: 1000 };
  assert.equal(gitCheckDelay({ last: null, mapId: 'map-a', now: 1000 }), 0);
  assert.equal(gitCheckDelay({ last, mapId: 'map-a', now: 4000 }), 7000, 'a save soon after a check waits for the end of the window');
  assert.equal(gitCheckDelay({ last, mapId: 'map-a', now: 4000, force: true }), 0);
  assert.equal(gitCheckDelay({ last, mapId: 'map-b', now: 4000 }), 0);
  assert.equal(gitCheckDelay({ last, mapId: 'map-a', now: 20000 }), 0);
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
    const missing = await get('/maps/map-99999999/git-status');
    assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'not-found');
  } finally { await app.close(); }
});
