import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { listenStatus, listenChoices } from '../skills/explore/assets/listening.js';

// How long the agent keeps listening (K1, #49). Illustrative fixtures under .test-output, never ideas/.
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'listen-'));
  const app = await startServer({ workspace, port: 0 });
  const { token } = await (await fetch(`${app.address}/api/session`)).json();
  const call = async (route, body) => {
    const response = await fetch(`${app.address}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  // A map whose first exploration is already done, so a listener on it stays idle.
  const quietMap = async title => {
    const map = await app.store.create({ title, idea: `${title} idea.` });
    const job = await app.store.claim('setup', map.id);
    return app.store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Explored.' });
  };
  return { app, workspace, call, quietMap };
}

test('the window is 2, 10, 30 or 60 minutes, and keeps listening until a full window passes idle', () => {
  assert.deepEqual(listenChoices, [2, 10, 30, 60]);
  assert.deepEqual(listenStatus({ windowMinutes: 2, lastActivity: 0, now: 119_900 }), { windowMinutes: 2, idleSeconds: 119, keepListening: true });
  assert.deepEqual(listenStatus({ windowMinutes: 2, lastActivity: 0, now: 120_000 }), { windowMinutes: 2, idleSeconds: 120, keepListening: false });
});

test('idle responses report the shared window, and a change in the browser applies at the next poll', async () => {
  const { app, workspace, call, quietMap } = await fixture();
  try {
    const map = await quietMap('Field notebook');
    let idle = (await call(`/next?map=${map.id}&worker=agent`)).body;
    assert.equal(idle.idle, true); assert.deepEqual(idle.listen, { windowMinutes: 2, idleSeconds: 0, keepListening: true });
    assert.equal((await call('/settings')).body.listenMinutes, 2);
    assert.equal((await call('/settings', { expectedRevision: 0, listenMinutes: 7 })).status, 400);
    const saved = await call('/settings', { expectedRevision: 0, listenMinutes: 10 });
    assert.equal(saved.status, 200); assert.equal(saved.body.listenMinutes, 10);
    assert.equal((await call('/settings', { expectedRevision: 0, listenMinutes: 30 })).status, 409, 'a stale revision is refused');
    idle = (await call(`/next?map=${map.id}&worker=agent`)).body;
    assert.equal(idle.listen.windowMinutes, 10);
    // Shared in the repo, never in a map file or the runtime folder.
    assert.equal(JSON.parse(await readFile(path.join(workspace, 'ideas', 'settings.json'), 'utf8')).listenMinutes, 10);
    assert.doesNotMatch(await readFile(app.store.file(map.id), 'utf8'), /listenMinutes/);
    assert.ok(!(await readdir(path.join(workspace, '.explore'))).includes('settings.json'));
  } finally { await app.close(); }
  const restarted = await startServer({ workspace, port: 0 });
  try { assert.equal((await restarted.store.getSettings()).listenMinutes, 10, 'it survives a restart'); }
  finally { await restarted.close(); }
});

test('a saved change on a map resets the idle time of listeners covering it, and only theirs', async () => {
  const { app, call, quietMap } = await fixture();
  try {
    const a = await quietMap('Map A'), b = await quietMap('Map B');
    await call(`/next?map=${a.id}&worker=one`); await call(`/next?map=${b.id}&worker=two`); await call('/next?worker=all');
    await pause(1100);
    const saved = await call(`/maps/${a.id}/action`, { expectedRevision: a.revision, nodeId: a.rootId, type: 'suggest', title: 'Offline maps', body: 'A direction.' });
    assert.equal(saved.status, 200);
    const idle = async query => (await call(`/next?${query}`)).body.listen.idleSeconds;
    assert.equal(await idle(`map=${a.id}&worker=one`), 0, 'the listener on the changed map');
    assert.equal(await idle('worker=all'), 0, 'a listener on every map');
    assert.ok(await idle(`map=${b.id}&worker=two`) >= 1, 'a listener on another map keeps counting');
  } finally { await app.close(); }
});

test('handing out a job resets the listener, packets carry no listening window, and idle output stays compact', async () => {
  const { app, workspace, call } = await fixture();
  try {
    const map = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
    const packet = (await call(`/next?map=${map.id}&worker=agent`)).body;
    assert.equal(packet.jobType, 'investigate'); assert.equal(packet.listen, undefined);
    await pause(1100);
    const idle = (await call(`/next?map=${map.id}&worker=agent`)).body;
    assert.ok(idle.listen.idleSeconds >= 1, 'counting from when the job was handed out');
    const cli = JSON.parse((await exec(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), 'next', '--wait', '0', '--map', map.id, '--worker', 'agent', '--workspace', workspace])).stdout);
    assert.equal(cli.listen.windowMinutes, 2); assert.ok(JSON.stringify(cli).length < 200);
  } finally { await app.close(); }
});
