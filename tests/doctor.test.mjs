import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { packageFiles } from '../skills/explore/scripts/doctor.mjs';

const exec = promisify(execFile);
const cli = path.resolve('skills/explore/scripts/cli.mjs');
const run = (workspace, args = ['doctor']) => exec(process.execPath, [cli, ...args, '--workspace', workspace]);
const temporary = async prefix => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, prefix));
};
const saveConnection = async (workspace, connection) => {
  await mkdir(path.join(workspace, '.explore'), { recursive: true });
  await writeFile(path.join(workspace, '.explore/connection.json'), JSON.stringify(connection));
};

test('doctor and usage work in a fresh path with spaces without creating runtime files', async () => {
  const workspace = await temporary('fresh workspace ü-');
  const result = JSON.parse((await run(workspace)).stdout);
  assert.equal(result.state, 'not-started'); assert.equal(result.ready, false);
  assert.equal(result.workspace, workspace); assert.equal(result.savedMaps, 0);
  assert.ok(result.checks.every(check => check.status !== 'error'));
  assert.deepEqual(result.start.args.slice(-4), ['--workspace', workspace, '--port', '0']);
  assert.equal(JSON.parse((await run(workspace, ['usage'])).stdout).commands, 0);
  assert.deepEqual(await readdir(workspace), []);
});

test('doctor reconnects to a live bridge and diagnoses a stopped bridge without exposing secrets', async () => {
  const workspace = await temporary('doctor-live-');
  const app = await startServer({ workspace, port: 0 });
  let connection;
  try {
    connection = JSON.parse(await readFile(path.join(workspace, '.explore/connection.json'), 'utf8'));
    const response = await run(workspace);
    const result = JSON.parse(response.stdout);
    assert.equal(result.ready, true); assert.equal(result.state, 'ready'); assert.equal(result.bridge.listening, false);
    assert.ok(!response.stdout.includes(connection.token)); assert.ok(!response.stdout.includes('"token"'));
    assert.deepEqual((await readdir(path.join(workspace, '.explore'))).sort(), ['.gitignore', 'connection.json', 'server.lock']);
    assert.equal(await readFile(path.join(workspace, '.explore/.gitignore'), 'utf8'), '*\n', 'the runtime folder ignores itself in Git');
  } finally { await app.close(); }
  await saveConnection(workspace, connection);
  const result = JSON.parse((await run(workspace)).stdout);
  assert.equal(result.ready, false); assert.equal(result.state, 'unreachable');
  assert.ok((await readFile(path.join(workspace, '.explore/connection.json'), 'utf8')).includes(connection.token));
  assert.equal(JSON.parse((await run(workspace, ['usage'])).stdout).commands, 0);
});

test('doctor and CLI reject copied or remote connection settings before authenticating', async () => {
  const workspace = await temporary('doctor-invalid-');
  const token = 'c'.repeat(64);
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end('{}'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    await saveConnection(workspace, { address, token, workspace: path.join(workspace, 'former-location') });
    const copied = JSON.parse((await run(workspace)).stdout);
    assert.equal(copied.state, 'workspace-mismatch');
    await assert.rejects(run(workspace, ['status']), /another workspace location/);
    assert.equal(requests, 0);
    for (const invalidAddress of ['https://example.com', `${address}/?token=${token}`, `http://user:${token}@127.0.0.1:${server.address().port}`]) {
      await saveConnection(workspace, { address: invalidAddress, token, workspace });
      const response = await run(workspace);
      assert.equal(JSON.parse(response.stdout).state, 'invalid');
      assert.ok(!response.stdout.includes(token));
      await assert.rejects(run(workspace, ['status']), /Invalid local connection/);
    }
    assert.equal(requests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('doctor never follows an authenticated redirect or echoes a rejected credential', async () => {
  const workspace = await temporary('doctor-auth-');
  const token = 'e'.repeat(64);
  let mode = 'unauthorized', destinationRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/destination') { destinationRequests++; res.end('{}'); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/destination' }); res.end(); return; }
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Rejected ${token}` }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await saveConnection(workspace, { address: `http://127.0.0.1:${server.address().port}`, token, workspace });
    const rejected = await run(workspace);
    assert.equal(JSON.parse(rejected.stdout).state, 'unauthorized'); assert.ok(!rejected.stdout.includes(token));
    await assert.rejects(run(workspace, ['status']), error => !error.stderr.includes(token) && error.stderr.includes('[redacted]'));
    mode = 'redirect';
    assert.equal(JSON.parse((await run(workspace)).stdout).state, 'unreachable');
    await assert.rejects(run(workspace, ['status']));
    assert.equal(destinationRequests, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the app and doctor name the package version, and doctor warns about a server from another version', async () => {
  const workspace = await temporary('doctor-version-');
  const app = await startServer({ workspace, port: 0 });
  try {
    const { version } = JSON.parse(await readFile(path.resolve('skills/explore/version.json'), 'utf8'));
    assert.equal((await (await fetch(app.address + '/api/session')).json()).version, version);
    let result = JSON.parse((await run(workspace)).stdout);
    assert.equal(result.version, version); assert.equal(result.serverVersion, version);
    assert.ok(!result.checks.some(check => check.name === 'version'));
    const file = path.join(workspace, '.explore/connection.json'), connection = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...connection, version: '0.0.1' }));
    result = JSON.parse((await run(workspace)).stdout);
    assert.equal(result.serverVersion, '0.0.1');
    assert.match(result.checks.find(check => check.name === 'version').message, /different Explore version\. Restart it/);
  } finally { await app.close(); }
});

// Support report (J3, #45).
const support = (workspace, ...extra) => exec(process.execPath, [cli, 'doctor', '--support', ...extra, '--workspace', workspace]);

test('the support report has exactly its version 1 fields and leaks nothing private', async () => {
  const workspace = await temporary('doctor-support-CANARYPATH-');
  const app = await startServer({ workspace, port: 0 });
  try {
    const map = await app.store.create({ title: 'CANARYTITLE plan', idea: 'CANARYIDEA details.' });
    const { token } = JSON.parse(await readFile(path.join(workspace, '.explore/connection.json'), 'utf8'));
    await fetch(`${app.address}/api/next?worker=CANARYWORKER&wait=0`, { headers: { Authorization: `Bearer ${token}` } });
    // One map the server cannot read, with private words in it.
    await mkdir(path.join(workspace, 'ideas', 'map-00000bad'), { recursive: true });
    await writeFile(path.join(workspace, 'ideas', 'map-00000bad', 'map.json'), '{\n<<<<<<< HEAD\n"title": "CANARYCONFLICT"\n=======\n>>>>>>> theirs\n}\n');
    const { stdout } = await support(workspace);
    const report = JSON.parse(stdout);
    assert.deepEqual(Object.keys(report).sort(), ['arch', 'bridge', 'checks', 'format', 'generatedAt', 'legacyRuntimeFolder', 'lock', 'missingPackageFiles', 'node', 'platform', 'ready', 'savedMaps', 'skillVersion', 'state', 'unreadableMaps', 'version']);
    assert.equal(report.format, 'explore-support'); assert.equal(report.version, 1);
    assert.equal(report.state, 'ready'); assert.deepEqual(report.bridge, { listening: true, scopeCount: 1 });
    assert.equal(report.unreadableMaps, 1); assert.equal(report.savedMaps, 2); assert.deepEqual(report.missingPackageFiles, []);
    assert.deepEqual(Object.keys(report.lock), ['state']);
    assert.ok(report.checks.every(check => Object.keys(check).sort().join() === 'name,status'));
    for (const secret of ['CANARY', token, workspace, map.id, String(new URL(app.address).port), String(process.pid), 'map-00000bad']) assert.ok(!stdout.includes(secret), secret);
    assert.ok(stdout.length <= 4096);
  } finally { await app.close(); }
});

test('--support writes nothing unless --out names a new file', async () => {
  const workspace = await temporary('doctor-support-out-');
  assert.equal(JSON.parse((await support(workspace)).stdout).state, 'not-started');
  await assert.rejects(readdir(path.join(workspace, '.explore')), 'no runtime files');
  const file = path.join(workspace, 'report.json');
  const written = await support(workspace, '--out', file);
  assert.match(written.stderr, /Left out: ideas and answers, map titles and IDs, paths, names, tokens, process IDs and error text/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'explore-support');
  await writeFile(file, 'keep me');
  await assert.rejects(support(workspace, '--out', file), /already exists/);
  assert.equal(await readFile(file, 'utf8'), 'keep me');
});

test('doctor.mjs runs the support report itself, and a write error names only its code', async () => {
  const workspace = await temporary('doctor-support-direct-');
  const doctor = path.resolve('skills/explore/scripts/doctor.mjs');
  const { stdout } = await exec(process.execPath, [doctor, '--support', '--workspace', workspace], { timeout: 20000 });
  assert.equal(JSON.parse(stdout).format, 'explore-support');
  assert.ok(!stdout.includes('"unknown"'), 'every field is known for a plain workspace');
  const missingFolder = path.join(workspace, 'no-such-folder', 'report.json');
  await assert.rejects(exec(process.execPath, [doctor, '--support', '--out', missingFolder, '--workspace', workspace], { timeout: 20000 }),
    error => /could not be written \(ENOENT\)/.test(error.stderr) && !error.stderr.includes('no-such-folder'));
  await assert.rejects(exec(process.execPath, [doctor, '--support', '--out'], { timeout: 20000 }), error => /--out requires a value/.test(error.stderr));
});

test('the projection keeps nothing from the diagnosis but the listed facts', async () => {
  const { toSupportReport } = await import('../skills/explore/scripts/support-report.mjs');
  const diagnosis = { ready: true, state: 'ready', workspace: '/home/CANARYUSER/notes', skillDirectory: '/CANARYSKILL', address: 'http://127.0.0.1:5555', nextStep: 'CANARYSTEP',
    checks: [{ name: 'node', status: 'ok', message: 'CANARYMESSAGE' }, { name: 'CANARYNAME', status: 'CANARYSTATUS', message: 'x' }],
    lock: { state: 'process-present', pid: 4242 }, savedMaps: 3, bridge: { listening: true, scopes: [{ mapId: 'map-CANARY', worker: 'CANARYWORKER', listening: true }] },
    start: { executable: '/CANARYNODE', args: ['/CANARYARG'] } };
  const text = JSON.stringify(toSupportReport(diagnosis, { version: '0.2.0', missing: [], unreadable: 0, legacy: false }));
  for (const secret of ['CANARY', '4242', '5555']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /"name":"unknown","status":"unknown"/, 'an unexpected check becomes unknown');
});

test('a map is never saved larger than the server will open', async () => {
  const workspace = await temporary('doctor-size-');
  const { Store } = await import('../skills/explore/scripts/store.mjs');
  const store = new Store(path.join(workspace, 'ideas'));
  const map = await store.create({ title: 'Big', idea: 'Grows.' });
  const before = await readFile(store.file(map.id), 'utf8');
  const loaded = await store.get(map.id);
  loaded.nodes[0].body = 'x'.repeat(65 * 1024 * 1024);
  await assert.rejects(store.save(loaded), error => error.status === 413 && /too large to save/.test(error.message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('the doctor checks every script and reference the skill ships, including the result checks and topic profiles', async () => {
  const scripts = (await readdir(path.resolve('skills/explore/scripts'))).filter(name => name.endsWith('.mjs')).map(name => `scripts/${name}`);
  assert.deepEqual(scripts.filter(file => !packageFiles.includes(file)), []);
  const references = (await readdir(path.resolve('skills/explore/references'), { recursive: true })).filter(name => name.endsWith('.md')).map(name => `references/${name.split(path.sep).join('/')}`);
  assert.deepEqual(references.filter(file => !packageFiles.includes(file)), []);
});
