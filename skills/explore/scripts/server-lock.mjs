import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The workspace's runtime folder, .explore/: the connection, the server lock and the CLI's claim copies.
// None of it belongs in a repository, so the folder ignores itself in Git.
export const runtimePath = workspace => path.join(path.resolve(workspace), '.explore');
export async function ensureRuntime(workspace) {
  const runtime = runtimePath(workspace);
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return runtime;
}

// Who holds the server lock: absent, invalid, process-present, process-absent, or unknown when the
// process check itself failed (for example, a server started with other permissions).
export async function inspectLock(workspace) {
  try {
    const lock = JSON.parse(await readFile(path.join(runtimePath(workspace), 'server.lock'), 'utf8'));
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) return { state: 'invalid' };
    try { process.kill(lock.pid, 0); return { state: 'process-present', pid: lock.pid }; }
    catch (error) { return { state: error.code === 'ESRCH' ? 'process-absent' : 'unknown', pid: lock.pid }; }
  } catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'invalid' }; }
}
// Only a missing lock, or one whose process is gone, means no server can be using the workspace.
export const lockIsFree = lock => lock.state === 'absent' || lock.state === 'process-absent';
