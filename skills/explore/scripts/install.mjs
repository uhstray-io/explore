import { cp, access, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { packageVersion, compareVersions } from './package-version.mjs';
import { ensureRuntime, inspectLock, lockIsFree } from './server-lock.mjs';
import { renameWithRetry } from './files.mjs';

const hosts = { codex: '.agents/skills', claude: '.claude/skills', copilot: '.github/skills' };
const thisPackage = fileURLToPath(new URL('../', import.meta.url));
const usage = 'node install.mjs --host codex|claude|copilot --project PATH [--update] [--allow-downgrade]\n'
  + 'Copies this complete skill to a project discovery folder. An existing installation is replaced only with\n'
  + '--update, which first keeps the old copy in .explore/skill-backups/.';
const shown = version => version ?? 'unversioned';
const exists = async target => { try { await access(target); return true; } catch { return false; } };
const fail = (message, cause) => { throw new Error(message, cause ? { cause } : undefined); };

// Every file in a folder, by relative path.
async function files(dir, prefix = '') {
  const found = new Map();
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) for (const [key, bytes] of await files(dir, relative)) found.set(key, bytes);
    else found.set(relative, await readFile(path.join(dir, relative)));
  }
  return found;
}
const sameFiles = (a, b) => a.size === b.size && [...a].every(([file, bytes]) => b.get(file)?.equals(bytes));

// Installs or updates the package in a project's discovery folder. The new copy is always staged in the
// project's .explore/ first and then moved into place, so a host never sees a half-copied skill; an existing
// copy is moved to .explore/skill-backups/ and put back if the final move fails. `rename` is replaceable
// for tests. Returns { action: 'installed' | 'up-to-date' | 'updated', … }.
export async function install({ source = thisPackage, project, host, update = false, allowDowngrade = false, rename = renameWithRetry }) {
  if (!hosts[host] || !project) fail('Provide --host codex|claude|copilot and --project PATH.');
  const target = path.resolve(project, hosts[host], 'explore'), from = path.resolve(source);
  if (target === from || target.startsWith(from + path.sep)) fail('The installation destination cannot be inside the source skill.');
  const installed = await exists(target), newVersion = await packageVersion(source), oldVersion = installed ? await packageVersion(target) : null;
  if (installed) {
    if (!update) fail(`An installation already exists at ${target} (version ${shown(oldVersion)}; this package is ${shown(newVersion)}). Run again with --update to replace it; the current copy is backed up first.`);
    if (!lockIsFree(await inspectLock(project))) fail('Stop the Explore server for this project first; it may be using the installed copy.');
    if (compareVersions(oldVersion, newVersion) > 0 && !allowDowngrade) fail(`The installed copy (${shown(oldVersion)}) is newer than this package (${shown(newVersion)}). Add --allow-downgrade to replace it anyway.`);
  }
  const before = installed ? await files(target) : null, after = installed ? await files(source) : null;
  if (installed && sameFiles(before, after)) return { action: 'up-to-date', target, version: newVersion };

  const runtime = await ensureRuntime(project), staging = path.join(runtime, `install-staging-${randomBytes(4).toString('hex')}`);
  const discard = () => rm(staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  // A discovery folder linked to another drive cannot be renamed into; copy there instead.
  const place = async (from, to) => {
    try { await rename(from, to); }
    catch (error) { if (error.code !== 'EXDEV') throw error; await cp(from, to, { recursive: true, errorOnExist: true, force: false }); await rm(from, { recursive: true, force: true, maxRetries: 5 }).catch(() => {}); }
  };
  try { await cp(source, staging, { recursive: true, errorOnExist: true, force: false }); }
  catch (error) { await discard(); fail(`The new copy could not be prepared, so nothing was changed: ${error.message}`, error); }
  if (!installed) {
    try { await mkdir(path.dirname(target), { recursive: true }); await place(staging, target); }
    catch (error) { await discard(); fail(`The new copy could not be moved into place, so nothing was installed: ${error.message}`, error); }
    return { action: 'installed', target, version: newVersion };
  }
  const backups = path.join(runtime, 'skill-backups'), backup = path.join(backups, `${host}-${shown(oldVersion)}-${new Date().toISOString().replace(/[-:.]/g, '')}`);
  await mkdir(backups, { recursive: true });
  try { await place(target, backup); }
  catch (error) { await discard(); await rmdir(backups).catch(() => {}); fail(`The installed copy could not be moved aside, so it was not changed: ${error.message}`, error); }
  try { await place(staging, target); }
  catch (error) {
    try { await place(backup, target); }
    catch { fail(`The update failed and the previous copy could not be put back. It is safe at ${backup}; the new copy is at ${staging}. Move the backup to ${target} to restore it.`, error); }
    await discard();
    fail(`The new copy could not be moved into place, so the previous copy was put back: ${error.message}`, error);
  }
  return { action: 'updated', target, oldVersion, newVersion, backup, onlyInOld: [...before.keys()].filter(file => !after.has(file)).sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  try {
    if (args.includes('--help')) console.log(usage);
    else {
      const host = option('host'), result = await install({ project: option('project'), host, update: args.includes('--update'), allowDowngrade: args.includes('--allow-downgrade') });
      console.log({
        installed: () => `Installed Explore ${shown(result.version)} for ${host}: ${result.target}\nReload your agent's skill discovery if necessary. Requires Node.js 20+.`,
        'up-to-date': () => `Already up to date: Explore ${shown(result.version)} at ${result.target}.`,
        updated: () => [`Updated Explore for ${host} from ${shown(result.oldVersion)} to ${shown(result.newVersion)}: ${result.target}`,
          `The previous copy is kept at ${result.backup}.`,
          ...(result.onlyInOld.length ? [`Only in the previous copy (kept in the backup): ${result.onlyInOld.join(', ')}`] : []),
          "Restart the server and reload your agent's skill discovery."].join('\n'),
      }[result.action]());
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
