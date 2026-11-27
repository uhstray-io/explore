import { git } from './git.mjs';

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
    // No Git, no repository or no name: contributions stay unattributed.
    const result = await git(['config', '--get', 'user.name'], { cwd: workspace, timeout: 2000 });
    const name = result.outcome === 'ok' ? cleanName(result.stdout) : null;
    cache = { at: Date.now(), value: name ? { name } : null };
    return cache.value;
  };
}
