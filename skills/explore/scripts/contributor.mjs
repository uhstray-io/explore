import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Contributions are attributed by each person's Git name: the same name that appears on the
// commits that share the map. Only user.name is read, never the email or any other Git setting.
export function cleanName(value) {
  const name = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60).trim();
  return name || null;
}

// Returns a function resolving to { name } or null. Git is asked at most once a minute.
export function gitContributor(workspace, { ttl = 60000 } = {}) {
  let cache = { at: -Infinity, value: null };
  return async function contributor() {
    if (Date.now() - cache.at < ttl) return cache.value;
    let name = null;
    try { name = cleanName((await run('git', ['-C', workspace, 'config', '--get', 'user.name'], { timeout: 2000, windowsHide: true })).stdout); }
    catch {} // No Git, no repository or no name: contributions stay unattributed.
    cache = { at: Date.now(), value: name ? { name } : null };
    return cache.value;
  };
}
