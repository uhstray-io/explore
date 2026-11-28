import path from 'node:path';
import { mapFolderPattern } from './map-validation.mjs';
import { packageVersion } from './package-version.mjs';
import { runtimePath, inspectLock } from './server-lock.mjs';
import { toSupportReport, countUnreadableMaps, unreadableMaps, writeSupportReport, leftOut, maxReportBytes } from './support-report.mjs';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat, access } from 'node:fs/promises';

const skillDirectory = fileURLToPath(new URL('../', import.meta.url));

// Never send the local bearer token to an address supplied by an unchecked file.
export async function readConnection(workspace) {
  let value;
  try { value = JSON.parse(await readFile(path.join(runtimePath(workspace), 'connection.json'), 'utf8')); }
  catch (error) {
    const problem = new Error(error.code === 'ENOENT' ? 'No connection for this workspace. Run doctor, then start server.mjs with this --workspace.' : 'Cannot read this workspace connection file. Run doctor for recovery guidance.');
    problem.code = error.code === 'ENOENT' ? 'missing' : 'invalid';
    throw problem;
  }
  let address;
  try { address = new URL(value.address); } catch { /* The safe validation error below replaces raw input. */ }
  if (!address || address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.username || address.password || address.search || address.hash || address.pathname !== '/' || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace)) {
    throw Object.assign(new Error('Invalid local connection settings. Run doctor; connection credentials were not sent.'), { code: 'invalid' });
  }
  const recordedWorkspace = path.resolve(value.workspace);
  const currentWorkspace = path.resolve(workspace);
  const sameWorkspace = process.platform === 'win32' ? recordedWorkspace.toLowerCase() === currentWorkspace.toLowerCase() : recordedWorkspace === currentWorkspace;
  if (!sameWorkspace) throw Object.assign(new Error('This connection belongs to another workspace location. Start the server from the current workspace; copied runtime files cannot reconnect it.'), { code: 'workspace-mismatch' });
  return { ...value, address: address.origin };
}

// The package files every installed copy needs; the support report lists missing ones by these names only.
export const packageFiles = ['SKILL.md', 'scripts/server.mjs', 'scripts/store.mjs', 'scripts/job-types.mjs', 'scripts/contributor.mjs', 'scripts/files.mjs', 'scripts/versions.mjs', 'scripts/options.mjs', 'scripts/map-jobs.mjs', 'scripts/question-actions.mjs', 'scripts/restart.mjs', 'scripts/map-validation.mjs', 'scripts/validate.mjs', 'scripts/package-version.mjs', 'scripts/install.mjs', 'scripts/server-lock.mjs', 'scripts/support-report.mjs', 'scripts/git.mjs', 'scripts/library.mjs', 'scripts/search.mjs', 'scripts/links.mjs', 'scripts/reuse.mjs', 'scripts/storage.mjs', 'scripts/listeners.mjs', 'scripts/neighbourhood.mjs', 'scripts/fields.mjs', 'scripts/result-checks.mjs', 'scripts/transfer.mjs', 'version.json', 'scripts/context.mjs', 'scripts/brief.mjs', 'scripts/cli.mjs', 'scripts/doctor.mjs', 'references/bridge.md', 'references/exploration.md', 'references/format.md', 'references/topics/general.md', 'references/topics/software-versions.md', 'references/topics/products-services.md', 'references/topics/concepts-tradeoffs.md', 'assets/index.html', 'assets/app.js', 'assets/graph.js', 'assets/history.js', 'assets/workspace-view.js', 'assets/questions.js', 'assets/rail.js', 'assets/storage-dialog.js', 'assets/history-limits.js', 'assets/alerts.js', 'assets/since-visit.js', 'assets/more-filters.js', 'assets/next-question.js', 'assets/question-clicks.js', 'assets/listening.js', 'scripts/research-model.mjs', 'assets/agent-dialog.js', 'assets/style.css', 'assets/constellation.css', 'scripts/changes.mjs', 'assets/changes-dialog.js', 'assets/brief-dialog.js', 'assets/import-dialog.js', 'assets/export-formats.js', 'assets/export-dialog.js', 'assets/branch-restore.js', 'scripts/branch-restore.mjs', 'assets/viewer-picker.js', 'assets/viewer-page.js', 'assets/viewer.css', 'scripts/viewer.mjs', 'assets/usage-dialog.js', 'scripts/stats.mjs', 'assets/recover-dialog.js', 'assets/done-when.js', 'scripts/done-when.mjs', 'scripts/glossary.mjs', 'scripts/folds.mjs', 'assets/glossary.js', 'assets/adr.js', 'assets/adr-dialog.js', 'scripts/adr.mjs', 'assets/inbox.js', 'assets/inbox-dialog.js', 'assets/dialog-focus.js', 'scripts/inbox.mjs', 'scripts/directions.mjs', 'scripts/completion.mjs', 'assets/criteria.js', 'assets/criteria-dialog.js', 'scripts/reconsider.mjs', 'assets/hypothesis.js', 'scripts/hypotheses.mjs', 'assets/answer-file.js', 'assets/answers-dialog.js', 'scripts/answers.mjs', 'assets/assumptions.js', 'assets/assumptions-dialog.js', 'scripts/assumptions.mjs', 'assets/sources.js', 'assets/stance.js', 'assets/sources-dialog.js', 'assets/glossary-dialog.js', 'assets/limitations.js', 'scripts/limitations.mjs', 'assets/claims.js', 'scripts/claims.mjs', 'assets/pinned-answers.js', 'scripts/pinned-answers.mjs', 'assets/command-palette.js', 'assets/impact.js', 'assets/minimap.js', 'assets/outline.js', 'assets/folds.js', 'scripts/guidance.mjs', 'assets/guidance.js', 'scripts/challenge.mjs', 'assets/challenge.js', 'assets/challenge-dialog.js', 'assets/tools-dialog.js', 'scripts/record-drafts.mjs', 'scripts/handoff.mjs', 'assets/handoff.js', 'assets/handoff-dialog.js', 'assets/record-drafts.js'];
async function missingPackageFiles() {
  const missing = [];
  for (const file of packageFiles) try { await access(path.join(skillDirectory, file)); } catch { missing.push(file); }
  return missing;
}

async function inspect({ workspace = process.cwd(), timeout = 2500 } = {}) {
  workspace = path.resolve(workspace);
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 20;
  add('node', nodeSupported ? 'ok' : 'error', `Node ${process.versions.node}; Node 20+ is required.`);
  let workspaceExists = false;
  try { workspaceExists = (await stat(workspace)).isDirectory(); } catch { /* Report missing/inaccessible without raw errors. */ }
  add('workspace', workspaceExists ? 'ok' : 'error', workspaceExists ? 'Workspace directory is accessible.' : 'Use an existing, accessible workspace directory.');
  const missing = await missingPackageFiles();
  add('package', missing.length ? 'error' : 'ok', missing.length ? `Restore the complete skill package; missing: ${missing.join(', ')}.` : 'Skill scripts, references, and browser assets are accessible.');
  let savedMaps = 0;
  try { savedMaps = (await readdir(path.join(workspace, 'ideas'), { withFileTypes: true })).filter(entry => entry.isDirectory() && mapFolderPattern.test(entry.name)).length; }
  catch (error) { if (error.code !== 'ENOENT') add('maps', 'warning', 'Saved-map directory could not be inspected.'); }
  // Maps that cannot be opened, by ID (J2): each can still be recovered from its saved versions in the app.
  const found = await unreadableMaps(workspace), damagedMaps = Array.isArray(found) && found.length ? found : null;
  if (damagedMaps) add('damaged-maps', 'warning', `These maps cannot be opened: ${damagedMaps.map(map => `${map.id} (${map.problem})`).join(', ')}. In Explore, choose one under Maps to copy an earlier version out as a new map.`);
  const lock = await inspectLock(workspace);
  const version = await packageVersion();
  const result = { ready: false, state: 'not-started', version: version ?? 'unversioned', workspace, skillDirectory, savedMaps, ...(damagedMaps ? { damagedMaps } : {}), lock, checks,
    start: { executable: process.execPath, args: [path.join(skillDirectory, 'scripts/server.mjs'), '--workspace', workspace, '--port', '0'] },
    note: 'Read-only diagnostics. No server was started, files changed, or model/provider connection tested.' };
  let connection;
  try { connection = await readConnection(workspace); }
  catch (error) {
    result.state = error.code === 'missing' ? 'not-started' : error.code;
    add('connection', error.code === 'missing' ? 'info' : 'error', error.message);
    result.nextStep = error.code === 'missing' ? 'Start the server with the start arguments in a persistent process, then rerun doctor.' : 'Use the current workspace path. If its runtime files were copied or became invalid, stop the owning workspace server and resolve those local runtime files before restarting; saved ideas do not need replacement.';
  }
  if (connection) {
    result.address = connection.address; result.serverVersion = connection.version ?? 'unversioned';
    if (result.serverVersion !== result.version) add('version', 'warning', 'The running server is from a different Explore version. Restart it to use the installed one.');
    try {
      const response = await fetch(`${connection.address}/api/maps`, { headers: { Authorization: `Bearer ${connection.token}` }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (response.status === 401 || response.status === 403) {
        result.state = 'unauthorized';
        add('connection', 'error', 'The running server rejected the saved connection. Credentials were not printed.');
        result.nextStep = 'Restart the workspace server through its owning session, then rerun doctor.';
      } else if (!response.ok) {
        result.state = 'server-error';
        add('connection', 'error', `The local server returned HTTP ${response.status}.`);
        result.nextStep = 'Inspect the owning server terminal, resolve the reported failure, and rerun doctor.';
      } else {
        const value = await response.json();
        if (!Array.isArray(value.maps) || !value.bridge || typeof value.bridge.listening !== 'boolean') throw new Error('Unexpected server response.');
        result.state = 'ready';
        result.ready = nodeSupported && workspaceExists && !missing.length;
        result.savedMaps = value.maps.length;
        result.bridge = { listening: value.bridge.listening, ...(Array.isArray(value.bridge.scopes) ? { scopes: value.bridge.scopes } : {}) };
        add('connection', 'ok', 'The authenticated local bridge responds.');
        result.nextStep = value.bridge.listening ? 'Open the address or select a saved map with the maps command.' : 'Open the address, select a saved map if needed, and use next to listen for activated work.';
      }
    } catch {
      result.state = 'unreachable';
      add('connection', 'error', 'The saved local server did not return a valid bridge response.');
      result.nextStep = 'Check the owning server process. If it has stopped, start it with this workspace and rerun doctor; do not kill an unrelated process based only on a reused PID.';
    }
  }
  if (lock.state === 'invalid' || (!result.ready && ['process-present', 'unknown'].includes(lock.state))) {
    add('lock', 'warning', 'A local lock needs inspection before another server starts. Doctor does not remove locks or stop processes.');
  }
  if (!nodeSupported || !workspaceExists || missing.length) result.nextStep = 'Resolve the node, workspace, or package errors above before starting or resuming.';
  return { diagnosis: result, missing, version };
}
export async function diagnose(options) { return (await inspect(options)).diagnosis; }

// Both doctor entry points run through here: the diagnosis, or the support report printed or written to a
// new file. Returns what to print on stdout and stderr.
export async function runDoctor({ workspace = process.cwd(), support = false, out } = {}) {
  workspace = path.resolve(workspace);
  const { diagnosis, missing, version } = await inspect({ workspace });
  if (!support) return { stdout: JSON.stringify(diagnosis, null, 2) };
  const legacy = await access(path.join(workspace, '.grill-my-mind')).then(() => true, () => false);
  const text = JSON.stringify(toSupportReport(diagnosis, { version, missing, unreadable: await countUnreadableMaps(workspace), legacy }), null, 2);
  if (Buffer.byteLength(text) > maxReportBytes) throw new Error('The support report grew past 4 KiB.');
  if (!out) return { stdout: text };
  await writeSupportReport(text + '\n', path.resolve(out));
  return { stdout: '', stderr: leftOut };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} requires a value.`); return args[i + 1]; };
  try {
    const { stdout, stderr } = await runDoctor({ workspace: value('--workspace') ?? process.cwd(), support: args.includes('--support'), out: value('--out') });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
