import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp, rm, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionProblems, compareVersions } from '../skills/explore/scripts/package-version.mjs';

// Versions and safe updates (J4, #46). Every fixture lives under .test-output.
const exec = promisify(execFile);
const skill = path.resolve('skills/explore');
async function sandbox() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'install-'));
  const project = path.join(dir, 'project'); await mkdir(project);
  return { dir, project };
}
// A copy of the package with its own version, to install from.
async function packageAt(dir, version) {
  const source = path.join(dir, `source-${version ?? 'unversioned'}`, 'explore');
  await cp(skill, source, { recursive: true });
  if (version) await writeFile(path.join(source, 'version.json'), JSON.stringify({ name: 'explore', version }) + '\n');
  else await rm(path.join(source, 'version.json'));
  return source;
}
const install = async (source, project, ...flags) => {
  try { const { stdout, stderr } = await exec(process.execPath, [path.join(source, 'scripts/install.mjs'), '--host', 'codex', '--project', project, ...flags]); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
};
async function tree(dir) {
  const files = {};
  const walk = async folder => { for (const entry of await readdir(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) await walk(full); else files[path.relative(dir, full)] = createHash('sha256').update(await readFile(full)).digest('hex'); } };
  await walk(dir); return files;
}
const installed = project => path.join(project, '.agents/skills/explore');
const installedVersion = async project => JSON.parse(await readFile(path.join(installed(project), 'version.json'), 'utf8')).version;

test('the package version matches the repository and is checked for consistency', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')), version = JSON.parse(await readFile(path.join(skill, 'version.json'), 'utf8'));
  assert.deepEqual(version, { name: 'explore', version: pkg.version });
  assert.deepEqual(versionProblems({ packageJson: pkg, versionJson: version }), []);
  assert.match(versionProblems({ packageJson: pkg, versionJson: { name: 'explore', version: '9.9.9' } }).join(), /version\.json version 9\.9\.9 differs from package\.json version/);
  assert.match(versionProblems({ packageJson: pkg, versionJson: null }).join(), /version\.json is missing or not valid JSON/);
  assert.match(versionProblems({ packageJson: pkg, versionJson: { name: 'other', version: 'x' } }).join(), /version\.json name must be "explore".*version\.json version must look like 1\.2\.3/s);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1); assert.equal(compareVersions(null, '0.1.0'), -1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('installing over a copy still refuses without --update, names both versions and changes nothing', async () => {
  const { dir, project } = await sandbox();
  const old = await packageAt(dir, '0.1.0'), next = await packageAt(dir, '0.2.0');
  assert.equal((await install(old, project)).code, 0);
  const before = await tree(project);
  const refused = await install(next, project);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /0\.1\.0.*0\.2\.0.*--update/s);
  assert.deepEqual(await tree(project), before);
});

test('--update replaces an older or unversioned copy, keeps a complete backup outside discovery, and the result passes doctor', async () => {
  for (const oldVersion of ['0.1.0', null]) {
    const { dir, project } = await sandbox();
    const old = await packageAt(dir, oldVersion), next = await packageAt(dir, '0.2.0');
    await install(old, project);
    await writeFile(path.join(installed(project), 'scripts', 'retired.mjs'), '// only in the old copy\n');
    const oldTree = await tree(installed(project));
    const result = await install(next, project, '--update');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${oldVersion ?? 'unversioned'} to 0\\.2\\.0`)); assert.match(result.stdout, /retired\.mjs/); assert.match(result.stdout, /Restart the server/);
    assert.equal(await installedVersion(project), '0.2.0');
    const [backup] = await readdir(path.join(project, '.explore', 'skill-backups'));
    assert.match(backup, new RegExp(`^codex-${oldVersion ?? 'unversioned'}-`));
    assert.deepEqual(await tree(path.join(project, '.explore', 'skill-backups', backup)), oldTree, 'the backup is the whole old copy');
    assert.deepEqual(await readdir(path.join(project, '.agents', 'skills')), ['explore'], 'nothing else in the discovery folder');
    const diagnosis = JSON.parse((await exec(process.execPath, [path.join(installed(project), 'scripts/cli.mjs'), 'doctor', '--workspace', project])).stdout);
    assert.ok(diagnosis.checks.every(check => check.status !== 'error')); assert.equal(diagnosis.version, '0.2.0');
  }
});

test('--update refuses while the server runs, refuses a downgrade unless allowed, and leaves an identical copy alone', async () => {
  const { dir, project } = await sandbox();
  const newer = await packageAt(dir, '0.3.0'), older = await packageAt(dir, '0.2.0');
  await install(newer, project);
  await mkdir(path.join(project, '.explore'), { recursive: true });
  await writeFile(path.join(project, '.explore', 'server.lock'), JSON.stringify({ pid: process.pid }));
  let result = await install(older, project, '--update', '--allow-downgrade');
  assert.equal(result.code, 1); assert.match(result.stderr, /Stop the Explore server/);
  await rm(path.join(project, '.explore', 'server.lock'));
  result = await install(older, project, '--update');
  assert.equal(result.code, 1); assert.match(result.stderr, /0\.3\.0.*newer.*--allow-downgrade/s);
  assert.equal(await installedVersion(project), '0.3.0');
  result = await install(newer, project, '--update');
  assert.equal(result.code, 0); assert.match(result.stdout, /Already up to date/);
  await assert.rejects(readdir(path.join(project, '.explore', 'skill-backups')), 'no backup for an unchanged copy');
  result = await install(older, project, '--update', '--allow-downgrade');
  assert.equal(result.code, 0); assert.equal(await installedVersion(project), '0.2.0');
});

test('a failure during the final move puts the original installation back', async () => {
  const { dir, project } = await sandbox();
  const old = await packageAt(dir, '0.1.0'), next = await packageAt(dir, '0.2.0');
  await install(old, project);
  const before = await tree(installed(project));
  const { updateInstallation } = await import(pathToFileURL(path.join(next, 'scripts/install.mjs')).href);
  let moves = 0;
  const failingRename = async (from, to) => { if (++moves === 2) throw new Error('disk unplugged'); return rename(from, to); };
  await assert.rejects(updateInstallation({ source: next, project, host: 'codex', rename: failingRename }), /disk unplugged/);
  assert.deepEqual(await tree(installed(project)), before);
  assert.deepEqual(await readdir(path.join(project, '.agents', 'skills')), ['explore']);
});
