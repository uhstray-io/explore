import { cp, access, mkdir, readdir, readFile, rename as move, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { packageVersion, compareVersions } from './package-version.mjs';
import { inspectLock } from './doctor.mjs';

const hosts = { codex: '.agents/skills', claude: '.claude/skills', copilot: '.github/skills' };
const thisPackage = fileURLToPath(new URL('../', import.meta.url));
const usage = 'node install.mjs --host codex|claude|copilot --project PATH [--update] [--allow-downgrade]\n'
  + 'Copies this complete skill to a project discovery folder. An existing installation is replaced only with\n'
  + '--update, which first keeps the old copy in .explore/skill-backups/.';
const shown = version => version ?? 'unversioned';
const exists = async target => { try { await access(target); return true; } catch { return false; } };

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

// Replaces an existing installation: stage the new copy, move the old one to a backup, then move the staged
// copy into place, moving the backup back if that fails. Staging and backups live in the project's .explore/,
// outside every discovery folder, so a host never finds two copies. `rename` is replaceable for tests.
export async function updateInstallation({ source = thisPackage, project, host, allowDowngrade = false, rename = move }) {
  const target = path.resolve(project, hosts[host], 'explore'), runtime = path.resolve(project, '.explore');
  if ((await inspectLock(project)).state === 'process-present') throw new Error('Stop the Explore server for this project first; it is using the installed copy.');
  const [oldVersion, newVersion] = await Promise.all([packageVersion(target), packageVersion(source)]);
  if (compareVersions(oldVersion, newVersion) > 0 && !allowDowngrade) throw new Error(`The installed copy (${shown(oldVersion)}) is newer than this package (${shown(newVersion)}). Add --allow-downgrade to replace it anyway.`);
  const [before, after] = await Promise.all([files(target), files(source)]);
  if (oldVersion === newVersion && sameFiles(before, after)) return { upToDate: true, version: newVersion };
  const staging = path.join(runtime, `install-staging-${randomBytes(4).toString('hex')}`);
  const backup = path.join(runtime, 'skill-backups', `${host}-${shown(oldVersion)}-${new Date().toISOString().replace(/[-:.]/g, '')}`);
  await mkdir(path.dirname(backup), { recursive: true });
  await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  await rename(target, backup);
  try { await rename(staging, target); }
  catch (error) { await rename(backup, target); await rm(staging, { recursive: true, force: true }); throw error; }
  return { oldVersion, newVersion, backup, onlyInOld: [...before.keys()].filter(file => !after.has(file)).sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  try {
    if (args.includes('--help')) console.log(usage);
    else {
      const host = option('host'), project = option('project');
      if (!hosts[host] || !project) throw new Error('Provide --host codex|claude|copilot and --project PATH.');
      const target = path.resolve(project, hosts[host], 'explore'), version = await packageVersion();
      if (target === path.resolve(thisPackage) || target.startsWith(path.resolve(thisPackage) + path.sep)) throw new Error('The installation destination cannot be inside the source skill.');
      if (!await exists(target)) {
        await mkdir(path.dirname(target), { recursive: true });
        await cp(thisPackage, target, { recursive: true, errorOnExist: true, force: false });
        console.log(`Installed Explore ${shown(version)} for ${host}: ${target}\nReload your agent's skill discovery if necessary. Requires Node.js 20+.`);
      } else if (!args.includes('--update')) {
        throw new Error(`An installation already exists at ${target} (version ${shown(await packageVersion(target))}; this package is ${shown(version)}). Run again with --update to replace it; the current copy is backed up first.`);
      } else {
        const result = await updateInstallation({ project, host, allowDowngrade: args.includes('--allow-downgrade') });
        console.log(result.upToDate ? `Already up to date: Explore ${shown(result.version)} at ${target}.` : [
          `Updated Explore for ${host} from ${shown(result.oldVersion)} to ${shown(result.newVersion)}: ${target}`,
          `The previous copy is kept at ${result.backup}.`,
          ...(result.onlyInOld.length ? [`Only in the previous copy (kept in the backup): ${result.onlyInOld.join(', ')}`] : []),
          "Restart the server and reload your agent's skill discovery."].join('\n'));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
