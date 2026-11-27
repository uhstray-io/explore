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
// What check.mjs reports when version.json is missing, malformed, or differs from the root package.json.
export function versionProblems({ packageJson, versionJson }) {
  if (!versionJson || typeof versionJson !== 'object') return ['skills/explore/version.json is missing or not valid JSON.'];
  const problems = [];
  if (versionJson.name !== 'explore') problems.push('skills/explore/version.json name must be "explore".');
  if (!isVersion(versionJson.version)) problems.push('skills/explore/version.json version must look like 1.2.3.');
  else if (versionJson.version !== packageJson?.version) problems.push(`skills/explore/version.json version ${versionJson.version} differs from package.json version ${packageJson?.version}. Bump both together.`);
  return problems;
}
