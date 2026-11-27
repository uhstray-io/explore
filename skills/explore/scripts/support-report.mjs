import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapFolderPattern, readMapFile, maxMapBytes } from './map-validation.mjs';
import { isVersion } from './package-version.mjs';

// A support report (J3): a small JSON file that is safe to attach to a public bug report. doctor gathers the
// facts; this module projects them field by field onto fixed sets, never by copying the diagnosis and
// removing fields, so the report can only contain what is listed here. It leaves out ideas and answers, map
// titles and IDs, paths, names, tokens, process IDs, ports and error text.
export const leftOut = 'Left out: ideas and answers, map titles and IDs, paths, names, tokens, process IDs and error text.';
export const maxReportBytes = 4096;
const states = new Set(['not-started', 'ready', 'invalid', 'workspace-mismatch', 'unauthorized', 'server-error', 'unreachable']);
const checkNames = new Set(['node', 'workspace', 'package', 'maps', 'connection', 'lock', 'version']);
const statuses = new Set(['ok', 'info', 'warning', 'error']);
const lockStates = new Set(['absent', 'invalid', 'process-present', 'process-absent', 'unknown']);
const pick = (value, allowed) => allowed.has(value) ? value : 'unknown';

// Map files the server could not open, by the server's own read rule. Counted, never quoted; any failure
// other than a missing map.json counts, so a broken map is never reported as fine.
export async function countUnreadableMaps(workspace) {
  let entries;
  try { entries = await readdir(path.join(workspace, 'ideas'), { withFileTypes: true }); }
  catch (error) { return error.code === 'ENOENT' ? 0 : 'unknown'; }
  let count = 0;
  for (const entry of entries.filter(item => item.isDirectory() && mapFolderPattern.test(item.name))) {
    const file = path.join(workspace, 'ideas', entry.name, 'map.json');
    try { if ((await stat(file)).size > maxMapBytes || readMapFile(await readFile(file), entry.name).problem) count++; }
    catch (error) { if (error.code !== 'ENOENT') count++; }
  }
  return count;
}

export function toSupportReport(diagnosis, { version, missing, unreadable, legacy, generatedAt = new Date().toISOString() }) {
  return {
    format: 'explore-support', version: 1, generatedAt,
    skillVersion: isVersion(version) ? version : 'unknown',
    node: /^\d+\.\d+\.\d+$/.test(process.versions.node) ? process.versions.node : 'unknown',
    platform: process.platform, arch: process.arch,
    state: pick(diagnosis.state, states), ready: diagnosis.ready === true,
    checks: diagnosis.checks.map(check => ({ name: pick(check.name, checkNames), status: pick(check.status, statuses) })),
    missingPackageFiles: Array.isArray(missing) && missing.every(file => typeof file === 'string' && /^[\w./-]+$/.test(file)) ? missing : 'unknown',
    lock: { state: pick(diagnosis.lock?.state, lockStates) },
    savedMaps: Number.isSafeInteger(diagnosis.savedMaps) ? diagnosis.savedMaps : 'unknown',
    unreadableMaps: Number.isSafeInteger(unreadable) ? unreadable : 'unknown',
    // With no server started nothing can be listening; otherwise only a server that answered can say.
    bridge: diagnosis.bridge ? { listening: diagnosis.bridge.listening === true, scopeCount: Array.isArray(diagnosis.bridge.scopes) ? diagnosis.bridge.scopes.length : 0 }
      : diagnosis.state === 'not-started' ? { listening: false, scopeCount: 0 } : 'unknown',
    legacyRuntimeFolder: legacy === true,
  };
}

// Writes the report to a new file; an existing file is never replaced. A failure names only its code, never
// the path, which would reveal the user's name and folders.
export async function writeSupportReport(text, file) {
  try { await writeFile(file, text, { flag: 'wx' }); }
  catch (error) { throw new Error(error.code === 'EEXIST' ? 'That file already exists. Choose a new --out path.' : `The report could not be written (${error.code ?? 'unknown error'}).`); }
}
