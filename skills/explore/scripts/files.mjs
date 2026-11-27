import { mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Write to a synced temporary file, then rename it into place: readers see the old or the new file,
// never half of one. `beforeRename` runs once the new contents are synced; if it throws, the old file
// stays untouched.
export async function atomicWrite(file, contents, beforeRename) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  try { if (beforeRename) await beforeRename(); await rename(temp, file); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
export async function atomicJson(file, value) { await atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
