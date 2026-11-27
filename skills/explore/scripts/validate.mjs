import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMapFile, mapFolderPattern, validId, generatedRevision } from './map-validation.mjs';

// Checks Explore map files without starting the server, for example in CI before a pull request merges.
// Read-only: it writes nothing and creates no .explore/ folder. Output names codes, locations and file
// paths, never values from a map.
const usage = 'Usage: node validate.mjs [--workspace PATH] [--json] [--strict] [MAP_FOLDER_OR_FILE ...]\n'
  + 'Checks Explore maps (by default every ideas/map-*/map.json) without starting the server.\n'
  + 'Exit 0 when all are valid, 1 when any is invalid (or has warnings, with --strict), 2 for usage errors.';

class UsageError extends Error {}
const isDirectory = async target => { try { return (await stat(target)).isDirectory(); } catch { return false; } };
const isFile = async target => { try { return (await stat(target)).isFile(); } catch { return false; } };
// A map file, a map folder, or a folder of map folders such as ideas/. A missing path is reported as unreadable.
async function mapFiles(target) {
  if (!await isDirectory(target)) return [target];
  if (await isFile(path.join(target, 'map.json'))) return [path.join(target, 'map.json')];
  const entries = await readdir(target, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && mapFolderPattern.test(entry.name)).map(entry => path.join(target, entry.name, 'map.json')).sort();
}

// Every generated view names the revision it came from; a missing or different one is out of date.
async function viewWarnings(file, map) {
  const folder = path.dirname(file), missing = [], stale = [];
  const views = ['README.md', ...map.nodes.filter(node => validId(node.id)).map(node => `nodes/${node.id}.md`)];
  for (const view of views) {
    let content;
    try { content = await readFile(path.join(folder, view), 'utf8'); } catch { missing.push(view); continue; }
    if (generatedRevision(content) !== map.revision) stale.push(view);
  }
  const warn = (code, list, what) => list.length ? [{ code, at: list[0], message: `${list.length} generated ${list.length === 1 ? 'view is' : 'views are'} ${what}. Opening the map in Explore regenerates them.` }] : [];
  return [...warn('missing-view', missing, 'missing'), ...warn('stale-view', stale, 'from another revision')];
}

export async function validateWorkspace({ workspace, paths = [], cwd = process.cwd() }) {
  if (!await isDirectory(workspace)) throw new UsageError('The workspace is not a folder.');
  const targets = paths.length ? paths.map(item => path.resolve(cwd, item)) : [path.join(workspace, 'ideas')];
  const files = paths.length || await isDirectory(targets[0]) ? (await Promise.all(targets.map(mapFiles))).flat() : [];
  if (paths.length && !files.length) throw new UsageError('No maps were found in the paths given.');
  const maps = [];
  for (const file of files) {
    const folder = path.basename(path.dirname(file)), shown = path.relative(workspace, file);
    let bytes;
    try { bytes = await readFile(file); }
    catch { maps.push({ path: shown, errors: [{ code: 'unreadable', at: 'map.json', message: 'The map file could not be read.' }], warnings: [] }); continue; }
    const { map, errors, warnings } = checkMapFile(bytes, { folderId: mapFolderPattern.test(folder) ? folder : undefined });
    maps.push({ path: shown, errors, warnings: [...warnings, ...(map && !errors.length ? await viewWarnings(file, map) : [])] });
  }
  return { maps, ok: maps.every(item => !item.errors.length) };
}

function report({ maps }) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [];
  for (const item of maps) {
    lines.push(`${item.path}: ${item.errors.length ? plural(item.errors.length, 'error') : 'valid'}${item.warnings.length ? `, ${plural(item.warnings.length, 'warning')}` : ''}`);
    for (const [kind, list] of [['error', item.errors], ['warning', item.warnings]]) for (const problem of list) lines.push(`  ${kind} ${problem.code} at ${problem.at}: ${problem.message}`);
  }
  const invalid = maps.filter(item => item.errors.length).length, warnings = maps.reduce((n, item) => n + item.warnings.length, 0);
  lines.push(`${plural(maps.length, 'map')} checked: ${maps.length - invalid} valid, ${invalid} invalid, ${plural(warnings, 'warning')}.`);
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { json: false, strict: false, help: false, paths: [], workspace: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--workspace') { if (!args[i + 1] || args[i + 1].startsWith('-')) throw new UsageError('The --workspace option needs a path.'); options.workspace = path.resolve(args[++i]); }
    else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}.`);
    else options.paths.push(arg);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage);
    else {
      const result = await validateWorkspace(options);
      console.log(options.json ? JSON.stringify(result, null, 2) : report(result));
      process.exitCode = !result.ok || (options.strict && result.maps.some(item => item.warnings.length)) ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof UsageError) { console.error(`${error.message}\n${usage}`); process.exitCode = 2; }
    else { console.error(error.message); process.exitCode = 1; }
  }
}
