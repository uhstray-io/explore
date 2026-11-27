import { isVersion } from '../skills/explore/scripts/package-version.mjs';

// The skill package and the repository release together: version.json must match the root package.json.
export function versionProblems({ packageJson, versionJson }) {
  if (!versionJson || typeof versionJson !== 'object') return ['skills/explore/version.json is missing or not valid JSON.'];
  const problems = [];
  if (versionJson.name !== 'explore') problems.push('skills/explore/version.json name must be "explore".');
  if (!isVersion(versionJson.version)) problems.push('skills/explore/version.json version must look like 1.2.3.');
  else if (versionJson.version !== packageJson?.version) problems.push(`skills/explore/version.json version ${versionJson.version} differs from package.json version ${packageJson?.version}. Bump both together.`);
  return problems;
}
