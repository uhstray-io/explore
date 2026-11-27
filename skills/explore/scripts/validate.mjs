import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMapFile } from './map-validation.mjs';

// Checks Explore map files without starting the server, for example in CI before a pull request merges.
// Read-only: it writes nothing, creates no .explore/ folder and never prints map content.
const usage = 'Usage: node validate.mjs [--workspace PATH] [--json] [--strict] [MAP_FOLDER_OR_FILE ...]\n'
  + 'Checks Explore maps (by default every ideas/map-*/map.json) without starting the server.\n'
  + 'Exit 0 when all are valid, 1 when any is invalid (or has warnings, with --strict), 2 for usage errors.';
const mapFolder = /^map-[a-f0-9]{8}$/;

async function mapFiles(workspace, paths, cwd) {
  if (paths.length) return paths.map(item => { const full = path.resolve(cwd, item); return full.endsWith('.json') ? full : path.join(full, 'map.json'); });
  let entries = [];
  try { entries = await readdir(path.join(workspace, 'ideas'), { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return entries.filter(entry => entry.isDirectory() && mapFolder.test(entry.name)).map(entry => path.join(workspace, 'ideas', entry.name, 'map.json')).sort();
}

// Generated Markdown names the revision it was made from; a different one means it is out of date.
async function viewWarnings(file, map) {
  let readme;
  try { readme = await readFile(path.join(path.dirname(file), 'README.md'), 'utf8'); }
  catch { return [{ code: 'missing-view', at: 'README.md', message: 'The generated overview is missing. Opening the map in Explore regenerates it.' }]; }
  const revision = Number(readme.match(/Generated view of map revision (\d+)\./)?.[1]);
  return revision === map.revision ? [] : [{ code: 'stale-view', at: 'README.md', message: `The generated overview is from revision ${revision || 'unknown'}, not ${map.revision}. Opening the map in Explore regenerates it.` }];
}

export async function validateWorkspace({ workspace, paths = [], cwd = process.cwd() }) {
  const maps = [];
  for (const file of await mapFiles(workspace, paths, cwd)) {
    const folder = path.basename(path.dirname(file)), shown = path.relative(workspace, file);
    let bytes;
    try { bytes = await readFile(file); }
    catch { maps.push({ path: shown, errors: [{ code: 'unreadable', at: 'map.json', message: 'The map file could not be read.' }], warnings: [] }); continue; }
    const { map, errors, warnings } = checkMapFile(bytes, { folderId: mapFolder.test(folder) ? folder : undefined });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = { json: false, strict: false, paths: [], workspace: process.cwd() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') { console.log(usage); process.exit(0); }
    else if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--workspace' && args[i + 1] && !args[i + 1].startsWith('--')) options.workspace = path.resolve(args[++i]);
    else if (arg.startsWith('--')) { console.error(`Unknown option ${arg}.\n${usage}`); process.exit(2); }
    else options.paths.push(arg);
  }
  try {
    const result = await validateWorkspace(options);
    console.log(options.json ? JSON.stringify(result, null, 2) : report(result));
    process.exitCode = !result.ok || (options.strict && result.maps.some(item => item.warnings.length)) ? 1 : 0;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
