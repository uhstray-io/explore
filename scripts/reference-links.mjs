import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Relative links in the skill's SKILL.md and in every Markdown file under references/ that would not work in an
// installed copy, as "file → target" (forward slashes). A link must stay inside the skill folder and match each
// name's letter case exactly, as it would on a case-sensitive system. Web links and in-page anchors are not files,
// and links inside code (fenced or inline) are examples, not links.
export async function brokenReferenceLinks(skillDirectory) {
  const root = path.resolve(skillDirectory);
  const walk = async folder => (await Promise.all((await readdir(folder, { withFileTypes: true })).map(entry => entry.isDirectory() ? walk(path.join(folder, entry.name)) : [path.join(folder, entry.name)]))).flat();
  const files = [path.join(root, 'SKILL.md'), ...(await walk(path.join(root, 'references'))).filter(file => file.endsWith('.md'))];
  const broken = [];
  for (const file of files) {
    const prose = (await readFile(file, 'utf8')).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '').replace(/`[^`\n]*`/g, '');
    for (const match of prose.matchAll(/\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) {
      const target = decodeURIComponent((match[1] ?? match[2]).split('#')[0]);
      if (!target || /^[a-z][a-z0-9+.-]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) continue; // A web link or an in-page anchor.
      const shown = `${path.relative(root, file).split(path.sep).join('/')} → ${match[1] ?? match[2]}`;
      if (path.isAbsolute(target) || /^[a-z]:/i.test(target)) { broken.push(shown); continue; }
      const resolved = path.resolve(path.dirname(file), target);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) { broken.push(shown); continue; }
      if (!await existsExactly(root, resolved)) broken.push(shown);
    }
  }
  return broken;
}
// Whether `file` exists with every part of its path spelled exactly as written below `root`.
async function existsExactly(root, file) {
  let folder = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    let names;
    try { names = await readdir(folder); } catch { return false; }
    if (!names.includes(part)) return false;
    folder = path.join(folder, part);
  }
  return stat(file).then(() => true, () => false);
}
