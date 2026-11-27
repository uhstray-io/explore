import { execFile } from 'node:child_process';

// Read-only Git (H9). Every call uses literal arguments and no shell, takes no optional locks (so the index
// is never rewritten), ignores fsmonitor, has a timeout and an output cap, and drops inherited variables that
// could point Git at another repository. Explore never stages, commits, fetches or changes refs.
const maxOutput = 64 * 1024;
const environment = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return env;
};
// Resolves { ok, stdout } (ok is false when Git exits with an error) or { missing: true } when Git is not
// installed. Never rejects, and never returns Git's error text.
export function git(args, { cwd, input, binary = 'git', timeout = 5000 } = {}) {
  return new Promise(resolve => {
    const child = execFile(binary, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, env: environment(), timeout, maxBuffer: maxOutput, windowsHide: true },
      (error, stdout) => resolve(error?.code === 'ENOENT' ? { missing: true } : { ok: !error, stdout: error ? '' : stdout }));
    if (input !== undefined) child.stdin.end(input);
  });
}

// Where the map.json in `folder` stands in Git, as plain facts only: never paths or Git's own output.
// Ahead and behind compare local refs; Explore does not fetch, so the remote may be newer.
export async function mapGitStatus(folder, { binary } = {}) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: folder, binary });
  if (top.missing) return { state: 'unknown' };
  if (!top.ok) return { state: 'no-repository' };
  const status = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching', '--', 'map.json'], { cwd: folder, binary });
  if (!status.ok) return { state: 'unknown' };
  const branch = {}, fields = status.stdout.split('\0');
  let entry = null;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.head ')) branch.branch = field.slice(14) === '(detached)' ? 'detached' : field.slice(14);
    else if (field.startsWith('# branch.upstream ')) branch.upstream = true;
    else if (field.startsWith('# branch.ab ')) { const [ahead, behind] = field.slice(12).split(' ').map(part => Math.abs(Number(part))); Object.assign(branch, { ahead, behind }); }
    else if (/^[12u?!] /.test(field)) { entry = field; if (field.startsWith('2 ')) i++; } // A rename carries its old path next.
  }
  const where = { branch: branch.branch ?? 'unknown', upstream: Boolean(branch.upstream), ...(branch.upstream && Number.isSafeInteger(branch.ahead) ? { ahead: branch.ahead, behind: branch.behind } : {}) };
  if (!entry) {
    const tracked = await git(['ls-files', '--error-unmatch', '--', 'map.json'], { cwd: folder, binary });
    return tracked.ok ? { state: 'committed', ...where } : { state: 'unknown' };
  }
  if (entry.startsWith('u ')) return { state: 'conflict', ...where };
  if (entry.startsWith('? ')) return { state: 'not-committed', untracked: true, ...where };
  if (entry.startsWith('! ')) return { state: 'ignored', ...where };
  const [staged, unstaged] = entry.split(' ')[1];
  return { state: 'not-committed', staged: staged !== '.', unstaged: unstaged !== '.', ...where };
}
