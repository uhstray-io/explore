import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';

// Relative links in the skill's SKILL.md and in every Markdown file under references/ that do not resolve, as
// "file → target" (forward slashes). Web links and in-page anchors are not files and are skipped.
export async function brokenReferenceLinks(skillDirectory) {
  const walk = async folder => (await Promise.all((await readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))).flat();
  const files = [path.join(skillDirectory, 'SKILL.md'), ...(await walk(path.join(skillDirectory, 'references'))).filter(file => file.endsWith('.md'))];
  const broken = [];
  for (const file of files) {
    for (const match of (await readFile(file, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      try { await access(path.resolve(path.dirname(file), target)); }
      catch { broken.push(`${path.relative(skillDirectory, file).split(path.sep).join('/')} → ${target}`); }
    }
  }
  return broken;
}
