import { readdir, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersionFile } from '../skills/explore/scripts/package-version.mjs';
import { versionProblems } from './version-check.mjs';
import { brokenReferenceLinks } from './reference-links.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}
const files = (await Promise.all(['scripts', 'tests', 'skills/explore'].map(dir => walk(path.join(root, dir))))).flat();
for (const file of files.filter(file => /\.(mjs|js)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const skillFile = path.join(root, 'skills/explore/SKILL.md');
const skill = await readFile(skillFile, 'utf8');
if (!/^---\r?\nname: explore\r?\ndescription: [^\r\n]+\r?\n---/.test(skill)) throw new Error('Skill requires the supported plain name and description frontmatter.');
// Links in SKILL.md and inside references/ (topic profiles included) must all resolve.
const broken = await brokenReferenceLinks(path.dirname(skillFile));
if (broken.length) throw new Error(`Broken reference links: ${broken.join('; ')}`);
const versionErrors = versionProblems({ packageJson: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')), versionJson: await readVersionFile(path.join(root, 'skills/explore')) });
if (versionErrors.length) throw new Error(versionErrors.join(' '));
console.log('JavaScript syntax, skill metadata, package version, and entrypoint reference paths passed.');
