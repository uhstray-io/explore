import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, open, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Store, Problem, atomicJson, publicMap } from './store.mjs';
import { contextExcerpt } from './context.mjs';
import { gitContributor } from './contributor.mjs';
import { mapBrief } from './brief.mjs';
import { exportMap } from './transfer.mjs';
import { createListeners } from './listeners.mjs';
import { defaultListenMinutes } from '../assets/listening.js';
import { previewRestart } from './restart.mjs';
import { packageVersion } from './package-version.mjs';
import { ensureRuntime, inspectLock, lockIsFree } from './server-lock.mjs';

const assets = fileURLToPath(new URL('../assets/', import.meta.url));
export async function startServer({ workspace = process.cwd(), port = 4317, dataDirectory, registry } = {}) {
  workspace = path.resolve(workspace);
  const runtime = await ensureRuntime(workspace);
  const lockPath = path.join(runtime, 'server.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await inspectLock(workspace);
    if (existing.state === 'invalid') throw new Error('Invalid server lock. Inspect .explore/server.lock before starting another server.');
    if (!lockIsFree(existing)) throw new Error('A server already owns this workspace. Use the existing URL shown by the CLI status command.');
    await unlink(lockPath).catch(() => {}); // The recorded process no longer exists.
    lock = await open(lockPath, 'wx');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.close();
  const connectionPath = path.join(runtime, 'connection.json');
  const token = randomBytes(32).toString('hex');
  const listeners = createListeners();
  const store = new Store(dataDirectory || path.join(workspace, 'ideas'), { ...(registry ? { registry } : {}), onSaved: map => listeners.noteActivity(map.id) });
  const contributor = gitContributor(workspace), version = await packageVersion();
  let address, worker = '', closing = false;
  const bridgeStatus = () => ({ ...listeners.status(), worker });
  try { await store.recover(); } catch (error) { await unlink(lockPath); throw error; }
  const send = (res, status, data) => {
    if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(address).host) throw new Problem('Unexpected host.', 403);
      if (req.headers.origin && req.headers.origin !== address) throw new Problem('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new Problem('Cross-site requests are not allowed.', 403);
      const url = new URL(req.url, address);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { token, version, workspace: path.basename(workspace), workspacePath: workspace, skillPath: fileURLToPath(new URL('../SKILL.md', import.meta.url)), dataDirectory: store.directory });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers.authorization !== `Bearer ${token}`) throw new Problem('Open the workspace again to reconnect.', 401);
        if (req.method === 'GET' && url.pathname === '/api/maps') return send(res, 200, { maps: await store.list(), bridge: bridgeStatus() });
        if (req.method === 'GET' && url.pathname === '/api/settings') return send(res, 200, await store.getSettings());
        if (req.method === 'GET' && url.pathname === '/api/contributor') { const actor = await contributor(); return send(res, 200, actor ? { name: actor.name, source: 'git' } : { name: null }); }
        const briefRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/brief$/);
        if (req.method === 'GET' && briefRoute) return send(res, 200, mapBrief(await store.get(briefRoute[1]), url.searchParams.get('node')));
        const previewRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/job-preview$/);
        if (req.method === 'GET' && previewRoute) {
          let selection;
          try { selection = url.searchParams.get('selection') ? JSON.parse(url.searchParams.get('selection')) : undefined; } catch { throw new Problem('The selection is not valid JSON.'); }
          return send(res, 200, await store.previewMapJob(previewRoute[1], url.searchParams.get('type'), selection));
        }
        // Version history: listing and previewing never write anything.
        const versionsRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/versions(?:\/([A-Za-z0-9-]+))?$/);
        if (req.method === 'GET' && versionsRoute && !versionsRoute[2]) { await store.get(versionsRoute[1]); return send(res, 200, await store.versions.list(versionsRoute[1])); }
        if (req.method === 'GET' && versionsRoute) {
          const preview = await store.versions.preview(versionsRoute[1], versionsRoute[2]);
          return send(res, 200, { ...preview, map: publicMap(preview.map) });
        }
        // Restart preview (Z2): what restarting a finished branch would delete and flag. It writes nothing.
        const restartRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/restart-preview$/);
        if (req.method === 'GET' && restartRoute) {
          const q = url.searchParams;
          return send(res, 200, await previewRestart(store, restartRoute[1], { nodeId: q.get('node'), questionId: q.get('question'), offset: q.get('offset'), limit: q.get('limit') }));
        }
        // Git status of a map's file (H9): read-only, and available even for a map that cannot be opened.
        const gitRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/git-status$/);
        if (req.method === 'GET' && gitRoute) return send(res, 200, await store.gitStatus(gitRoute[1]));
        const exportRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/export$/);
        if (req.method === 'GET' && exportRoute) return send(res, 200, await exportMap(store, exportRoute[1]));
        const contextRoute = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)\/context$/);
        if (req.method === 'GET' && contextRoute) return send(res, 200, contextExcerpt(await store.get(contextRoute[1]), url.searchParams.get('node'), Object.fromEntries(url.searchParams)));
        const match = url.pathname.match(/^\/api\/maps\/([a-z0-9-]+)(?:\/(action|result|fail))?$/);
        if (req.method === 'GET' && match && !match[2]) return send(res, 200, store.view(await store.get(match[1])));
        if (req.method === 'GET' && url.pathname === '/api/next') {
          const workerName = (url.searchParams.get('worker') || 'agent').slice(0, 100);
          const mapId = url.searchParams.get('map') || null;
          const wait = Math.max(0, Math.min(25, Number(url.searchParams.get('wait')) || 0));
          const deadline = Date.now() + wait * 1000;
          // Claiming a job saves the map, which restarts this listener's window like any other saved change.
          // Read on every poll, so a change in the browser applies at the next one. An unreadable settings file
          // falls back to the default rather than failing the poll.
          const windowMinutes = await store.getSettings().then(settings => settings.listenMinutes, () => defaultListenMinutes);
          const listener = listeners.seen(mapId, workerName, windowMinutes);
          do {
            if (res.destroyed || closing) return;
            const packet = await store.claim(workerName, mapId || undefined);
            worker = workerName; listeners.waiting(listener);
            if (packet) return send(res, 200, packet);
            if (Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          } while (!closing);
          return send(res, 200, { idle: true, message: 'No activated branches. Do not analyze the map again while waiting.', listen: listeners.listen(listener, windowMinutes) });
        }
        if (req.method !== 'POST') throw new Problem('Route not found.', 404);
        if (!req.headers['content-type']?.startsWith('application/json')) throw new Problem('Use application/json.', 415);
        const chunks = []; let bytes = 0;
        // A whole map may be imported; every other request stays small.
        const limit = url.pathname === '/api/import' ? 8 * 1024 * 1024 : 180000;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Problem('Request is too large.', 413); chunks.push(chunk); }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body; try { body = JSON.parse(raw); } catch { throw new Problem('Invalid JSON.'); }
        if (url.pathname === '/api/maps') return send(res, 201, store.view(await store.create(body)));
        if (url.pathname === '/api/demo') return send(res, 201, store.view(await store.demo()));
        if (url.pathname === '/api/settings') return send(res, 200, await store.updateSettings(body));
        if (url.pathname === '/api/import') return send(res, 200, await store.importMap(body.data, { asCopy: body.asCopy === true }));
        if (match?.[2] === 'action') return send(res, 200, store.view(await store.action(match[1], body, { actor: await contributor() })));
        if (match?.[2] === 'result') {
          if (body.check === true) return send(res, 200, await store.checkResult(match[1], body.jobId, body.claimKey, body.result));
          const { map, warnings } = await store.deliver(match[1], body.jobId, body.claimKey, body.result);
          return send(res, 200, { ...store.view(map), warnings });
        }
        if (match?.[2] === 'fail') return send(res, 200, store.view(await store.fail(match[1], body.jobId, body.claimKey, body.reason)));
        throw new Problem('Route not found.', 404);
      }
      const names = { '/': 'index.html', '/app.js': 'app.js', '/graph.js': 'graph.js', '/history.js': 'history.js', '/workspace-view.js': 'workspace-view.js', '/questions.js': 'questions.js', '/listening.js': 'listening.js', '/agent-dialog.js': 'agent-dialog.js', '/style.css': 'style.css', '/constellation.css': 'constellation.css', '/favicon.svg': 'favicon.svg' };
      if (req.method !== 'GET' || !names[url.pathname]) throw new Problem('Page not found.', 404);
      const file = names[url.pathname];
      const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': `${types[file.split('.').pop()]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      res.end(await readFile(path.join(assets, file)));
    } catch (error) { send(res, error.status || 500, { error: error.message, ...(error instanceof Problem ? { code: error.code, errors: error.errors } : {}) }); }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    address = `http://127.0.0.1:${server.address().port}`;
    await atomicJson(connectionPath, { address, token, pid: process.pid, workspace, dataDirectory: store.directory, version });
  } catch (error) { server.close(); await unlink(lockPath); throw error; }
  async function close() {
    if (closing) return; closing = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await store.tail;
    await unlink(connectionPath); await unlink(lockPath);
  }
  return { address, store, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (args.includes('--help')) {
    console.log('node server.mjs [--workspace PATH] [--port 4317]\nStarts a local workspace. Keep this process running.');
  } else {
    try {
      const app = await startServer({ workspace: option('--workspace', process.cwd()), port: Number(option('--port', 4317)) });
      console.log(`Explore is ready at ${app.address}\nSaved maps: ${app.store.directory}\nAgent bridge: waiting for the invoking agent. No model runs automatically.`);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
