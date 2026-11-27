import { execFile } from 'node:child_process';

// Read-only Git. Every Git command Explore runs goes through `git()`: literal arguments and no shell, no
// optional locks (so the index is never rewritten), fsmonitor off, a timeout and an output cap, messages in
// English, and none of the inherited variables that point Git at another repository, index or object store
// (what `git rev-parse --local-env-vars` lists, plus inline config). The user's own config still applies.
// Explore never stages, commits, fetches or changes refs.
const maxOutput = 64 * 1024;
const repositoryVariables = new Set(['GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR']);
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !repositoryVariables.has(name.toUpperCase()) && !/^GIT_CONFIG_(KEY|VALUE)_d+$/i.test(name))), LC_ALL: 'C', LANGUAGE: 'C' });

// Resolves, and never rejects, with one of:
//   { outcome: 'ok', stdout }            Git succeeded.
//   { outcome: 'exit', code, stderr }    Git ran and exited with an error. stderr is for the caller's own
//                                        decisions and is never shown or returned to a client.
//   { outcome: 'missing' }               Git is not installed. `cwd` must exist; every caller checks it.
//   { outcome: 'failed' }                A timeout, the output cap, or any other failure to run.
export function git(args, { cwd, input, binary = 'git', timeout = 5000, maxBuffer = maxOutput } = {}) {
  return new Promise(resolve => {
    const child = execFile(binary, ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, env: environment(), timeout, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => resolve(!error ? { outcome: 'ok', stdout }
        : error.code === 'ENOENT' ? { outcome: 'missing' }
        : typeof error.code === 'number' && !error.killed ? { outcome: 'exit', code: error.code, stderr }
        : { outcome: 'failed' }));
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); } // Git may exit before reading it all.
  });
}

// Whether Git already has these bytes as the `map.json` in `folder`, applying the repository's line-ending
// and attribute rules, so a Windows checkout's CRLF copy of committed work counts as already in Git.
export async function hasContent(folder, bytes) {
  const hashing = await git(['hash-object', '--path=map.json', '--stdin'], { cwd: folder, input: bytes });
  return hashing.outcome === 'ok' && (await git(['cat-file', '-e', hashing.stdout.trim()], { cwd: folder })).outcome === 'ok';
}

// Parses `git status --porcelain=v2 --branch -z` output for one path. `file` is that path's state, or null
// when Git lists nothing for it. `where` is { branch } or { detached: true }, plus `upstream` when one is set:
// { ahead, behind }, or { gone: true } when its branch no longer exists (Git then omits `branch.ab`).
export function parseStatus(stdout) {
  const where = {}, fields = stdout.split('\0');
  let entry = null;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.startsWith('# branch.head ')) { const head = field.slice(14); if (head === '(detached)') where.detached = true; else where.branch = head; }
    else if (field.startsWith('# branch.upstream ')) where.upstream = { gone: true }; // Until branch.ab gives the distance.
    else if (field.startsWith('# branch.ab ')) {
      const [ahead, behind] = field.slice(12).split(' ').map(part => Math.abs(Number(part)));
      if (where.upstream && Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)) where.upstream = { ahead, behind };
    }
    else if (/^[12u?!] /.test(field)) { entry = field; if (field.startsWith('2 ')) i++; } // A rename carries its old path next.
  }
  return { file: entry && fileState(entry), where };
}
function fileState(entry) {
  if (entry.startsWith('u ')) return { state: 'conflict' };
  if (entry.startsWith('? ')) return { state: 'not-committed', untracked: true };
  if (entry.startsWith('! ')) return { state: 'ignored' };
  const [staged, unstaged] = entry.split(' ')[1];
  return { state: 'not-committed', staged: staged !== '.', unstaged: unstaged !== '.' };
}

// Where the map.json in `folder` stands in Git, as plain facts only: never paths or Git's own output.
// `folder` must exist. Ahead and behind compare local refs; Explore does not fetch, so the remote may be newer.
export async function mapGitStatus(folder, { binary, timeout } = {}) {
  const status = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching', '--', 'map.json'], { cwd: folder, binary, timeout });
  if (status.outcome === 'exit' && /not a git repository/i.test(status.stderr)) return { state: 'no-repository' };
  if (status.outcome !== 'ok') return { state: 'unknown' };
  const { file, where } = parseStatus(status.stdout);
  if (file) return { ...file, ...where };
  const tracked = await git(['ls-files', '--error-unmatch', '--', 'map.json'], { cwd: folder, binary, timeout });
  return tracked.outcome === 'ok' ? { state: 'committed', ...where } : { state: 'unknown' };
}
