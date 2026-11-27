import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The skill package's version (J4). version.json sits beside SKILL.md and is always read as data, never
// imported, so a damaged file can be reported instead of stopping a script.
const skillDirectory = fileURLToPath(new URL('../', import.meta.url));
export const isVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

export async function readVersionFile(directory = skillDirectory) {
  try { return JSON.parse(await readFile(path.join(directory, 'version.json'), 'utf8')); } catch { return null; }
}
// The version of the package in `directory`, or null when it has none (an "unversioned" copy).
export async function packageVersion(directory = skillDirectory) {
  const file = await readVersionFile(directory);
  return isVersion(file?.version) ? file.version : null;
}
// Numeric comparison of X.Y.Z; an unversioned copy (null) is older than any version.
export function compareVersions(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
