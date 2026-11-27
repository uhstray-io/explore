import { readFile, readdir, stat, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnose, missingPackageFiles } from './doctor.mjs';
import { packageVersion } from './package-version.mjs';
import { decodeMap, readProblem, mapFolderPattern } from './map-validation.mjs';

// A support report (J3): a small JSON file that is safe to attach to a public bug report. It is built field
// by field from fixed sets, never by copying the diagnosis and removing fields, so it can only contain what
// is listed here. It leaves out ideas and answers, map titles and IDs, paths, names, tokens, process IDs,
// ports and error text.
export const leftOut = 'Left out: ideas and answers, map titles and IDs, paths, names, tokens, process IDs and error text.';
const states = new Set(['not-started', 'ready', 'invalid', 'workspace-mismatch', 'unauthorized', 'server-error', 'unreachable']);
const checkNames = new Set(['node', 'workspace', 'package', 'maps', 'connection', 'lock', 'version']);
const statuses = new Set(['ok', 'info', 'warning', 'error']);
const lockStates = new Set(['absent', 'invalid', 'process-present', 'process-absent', 'unknown']);
const pick = (value, allowed) => allowed.has(value) ? value : 'unknown';
const maxMapBytes = 64 * 1024 * 1024;

// Map files the server would refuse to open, read with a size limit and counted, never quoted.
async function unreadableMaps(workspace) {
  let entries = [];
  try { entries = await readdir(path.join(workspace, 'ideas'), { withFileTypes: true }); } catch { return 0; }
  let count = 0;
  for (const entry of entries.filter(item => item.isDirectory() && mapFolderPattern.test(item.name))) {
    const file = path.join(workspace, 'ideas', entry.name, 'map.json');
    try {
      if ((await stat(file)).size > maxMapBytes) { count++; continue; }
      const decoded = decodeMap(await readFile(file));
      if (decoded.problem || readProblem(decoded.map, entry.name)) count++;
    } catch { /* A folder without map.json is not a map. */ }
  }
  return count;
}

export async function supportReport({ workspace = process.cwd() } = {}) {
  workspace = path.resolve(workspace);
  const [diagnosis, version, missing, unreadable] = await Promise.all([diagnose({ workspace }), packageVersion(), missingPackageFiles(), unreadableMaps(workspace)]);
  const legacy = await access(path.join(workspace, '.grill-my-mind')).then(() => true, () => false);
  const report = {
    format: 'explore-support', version: 1, generatedAt: new Date().toISOString(),
    skillVersion: version ?? 'unknown',
    node: /^\d+\.\d+\.\d+$/.test(process.versions.node) ? process.versions.node : 'unknown',
    platform: process.platform, arch: process.arch,
    state: pick(diagnosis.state, states), ready: diagnosis.ready === true,
    checks: diagnosis.checks.slice(0, 20).map(check => ({ name: pick(check.name, checkNames), status: pick(check.status, statuses) })),
    missingPackageFiles: missing,
    lock: { state: pick(diagnosis.lock?.state, lockStates) },
    savedMaps: Number.isSafeInteger(diagnosis.savedMaps) ? diagnosis.savedMaps : 'unknown',
    unreadableMaps: unreadable,
    bridge: diagnosis.bridge ? { listening: diagnosis.bridge.listening === true, scopeCount: Array.isArray(diagnosis.bridge.scopes) ? diagnosis.bridge.scopes.length : 0 } : 'unknown',
    legacyRuntimeFolder: legacy,
  };
  if (JSON.stringify(report).length > 4096) throw new Error('The support report grew past 4 KiB.');
  return report;
}

// Writes the report to a new file; an existing file is never replaced.
export async function writeSupportReport(report, file) {
  try { await writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('That file already exists. Choose a new --out path.'); throw error; }
}
