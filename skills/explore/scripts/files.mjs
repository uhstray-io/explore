import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Windows briefly refuses to rename a file that another process, such as an antivirus scan or the search
// indexer, has just opened. A few short retries ride that out; a refusal that persists is a real error.
const transient = new Set(process.platform === 'win32' ? ['EPERM', 'EACCES', 'EBUSY'] : ['EBUSY']);
export async function renameWithRetry(from, to, { attempts = 6, move = rename } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      if (!transient.has(error.code) || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 * 2 ** attempt));
    }
  }
}

// Write to a synced temporary file, then rename it into place: readers see the old or the new file,
// never half of one. `beforeRename` runs once the new contents are synced; if it throws, the old file
// stays untouched.
export async function atomicWrite(file, contents, beforeRename) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  try { if (beforeRename) await beforeRename(); await renameWithRetry(temp, file); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function atomicJson(file, value) { await atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
