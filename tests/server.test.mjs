import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { Problem } from '../skills/explore/scripts/store.mjs';
import { createRegistry } from '../skills/explore/scripts/job-types.mjs';

test('HTTP workspace runs the complete queue/question/result/restart loop', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'http-'));
  let app = await startServer({ workspace, port: 0 });
  try {
    const html = await (await fetch(app.address)).text(); assert.match(html, /constellation\.css/);
    assert.match(await (await fetch(app.address + '/graph.js')).text(), /export function constellationLayout/);
    assert.equal(await (await fetch(app.address + '/?variant=paths')).text(), html);
    assert.equal((await fetch(app.address + '/prototype.js')).status, 404);
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const request = async (route, body) => {
      const res = await fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.ok(res.ok, await res.clone().text()); return res.json();
    };
    let map = await request('/maps', { title: 'User-created idea', idea: 'A library of shared recipes.' });
    const first = await request('/next?worker=integration');
    assert.equal(first.selected.id, map.rootId); assert.equal(first.jobType, 'investigate');
    map = await request(`/maps/${map.id}`);
    map = await request(`/maps/${map.id}/action`, { expectedRevision: map.revision, nodeId: map.rootId, type: 'position', x: -48.5, y: 212 });
    const publicState = await request(`/maps/${map.id}`); assert.equal(publicState.jobs[0].claimKey, undefined); assert.equal(publicState.jobs[0].claimHash, undefined);
    map = await request(`/maps/${map.id}/result`, { jobId: first.jobId, claimKey: first.claimKey, result: { summary: 'We need to understand the audience.', body: 'The target users shape recipe organization.', questions: ['Who is this for?'], suggestions: [{ title: 'Import recipes', body: 'Explore where existing recipes live.' }] } });
    assert.equal(map.nodes[1].status, 'suggested');
    assert.equal(map.jobs[0].stale, false, 'moving a node must not invalidate the running investigation');
    map = await request(`/maps/${map.id}/action`, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'My family.' });
    const next = await request('/next?worker=integration'); assert.equal(next.selected.questions[0].answer, 'My family.');
    map = await request(`/maps/${map.id}/result`, { jobId: next.jobId, claimKey: next.claimKey, result: { summary: 'A family recipe library.', body: 'Prioritize easy sharing and inherited recipes.' } });
    await app.close(); app = await startServer({ workspace, port: 0 });
    const saved = await app.store.get(map.id); assert.equal(saved.nodes[0].questions[0].answer, 'My family.');
    assert.deepEqual(saved.view.positions[map.rootId], { x: -48.5, y: 212 });
    assert.equal(saved.nodes[1].status, 'suggested');
    assert.match(await readFile(path.join(workspace, 'ideas', map.id, 'nodes', `${map.rootId}.md`), 'utf8'), /My family/);
  } finally { await app.close(); }
});

test('one server owns a workspace at a time', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'ownership-')); const app = await startServer({ workspace, port: 0 });
  try { await assert.rejects(startServer({ workspace, port: 0 }), /already owns/); }
  finally { await app.close(); }
});

test('brief is authenticated, read-only, scoped, and does not expose worker claims', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'brief-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const map = await app.store.create({ title: 'Plan a community workshop', idea: 'Compare a hands-on workshop with a discussion group.' });
    const packet = await app.store.claim('test', map.id);
    await app.store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Choose the audience before the format.', body: 'The desired outcome shapes the format.',
      questions: ['Who should be able to participate?'], suggestions: [{ title: 'Accessible venue', body: 'Check transport and access requirements.', kind: 'risk' }] });
    const before = await app.store.get(map.id);
    const route = `${app.address}/api/maps/${map.id}/brief`;
    assert.equal((await fetch(route)).status, 401);
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const headers = { Authorization: `Bearer ${token}` };
    const brief = await (await fetch(route, { headers })).json();
    assert.equal(brief.counts.awaitingAnswer, 1);
    assert.equal(brief.sections.find(s => s.id === 'directions').total, 1);
    assert.doesNotMatch(JSON.stringify(brief), new RegExp(packet.claimKey));
    assert.equal((await fetch(route, { headers: { ...headers, Origin: 'https://external.invalid' } })).status, 403);
    const child = before.nodes[1];
    const scoped = await (await fetch(route + `?node=${child.id}`, { headers })).json();
    assert.equal(scoped.counts.nodes, 1);
    assert.equal((await fetch(route + '?node=missing', { headers })).status, 404);
    assert.deepEqual(await app.store.get(map.id), before);
  } finally { await app.close(); }
});

test('shared settings are authenticated, validated, revision-checked and saved beside the maps', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'settings-http-'));
  const registry = createRegistry({ settings: { 'test-minutes': { default: 2, validate: value => { if (![2, 10].includes(value)) throw new Problem('Choose 2 or 10 minutes.'); return value; } } } });
  const app = await startServer({ workspace, port: 0, registry });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = (body, authorized = true) => fetch(app.address + '/api/settings', { method: body ? 'POST' : 'GET',
      headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call(undefined, false)).status, 401);
    assert.equal((await call({ expectedRevision: 0, 'test-minutes': 10 }, false)).status, 401);
    assert.deepEqual(await (await call()).json(), { version: 1, revision: 0, listenMinutes: 2, 'test-minutes': 2 });
    assert.equal((await call({ expectedRevision: 0, 'test-minutes': 7 })).status, 400);
    assert.equal((await call({ expectedRevision: 0, colour: 'blue' })).status, 400);
    const saved = await (await call({ expectedRevision: 0, 'test-minutes': 10 })).json();
    assert.deepEqual(saved, { version: 1, revision: 1, listenMinutes: 2, 'test-minutes': 10 });
    assert.equal((await call({ expectedRevision: 0, 'test-minutes': 2 })).status, 409);
    assert.equal(JSON.parse(await readFile(path.join(workspace, 'ideas', 'settings.json'), 'utf8'))['test-minutes'], 10);
    assert.deepEqual((await readdir(path.join(workspace, '.explore'))).filter(name => /settings|preferences/.test(name)), []);
  } finally { await app.close(); }
});

test('a conflicted map no longer stops the server; it is listed as unreadable and the rest open', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'conflict-http-'));
  let app = await startServer({ workspace, port: 0 });
  const good = await app.store.create({ title: 'Still fine', idea: 'Opens normally.' });
  const bad = await app.store.create({ title: 'Private idea title', idea: 'Secret details.' });
  await app.close();
  const file = path.join(workspace, 'ideas', bad.id, 'map.json');
  const raw = await readFile(file, 'utf8');
  await writeFile(file, `<<<<<<< HEAD\n${raw}=======\n${raw}>>>>>>> teammate\n`);
  app = await startServer({ workspace, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const get = route => fetch(app.address + '/api' + route, { headers: { Authorization: `Bearer ${token}` } });
    const { maps } = await (await get('/maps')).json();
    assert.deepEqual(maps.find(m => m.id === bad.id), { id: bad.id, unreadable: true, problem: 'conflict-markers' });
    assert.equal(maps.find(m => m.id === good.id).title, 'Still fine');
    const response = await get(`/maps/${bad.id}`);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, 'conflict-markers'); assert.doesNotMatch(JSON.stringify(body), /Private idea|Secret/);
    assert.equal((await get(`/maps/${good.id}`)).status, 200);
  } finally { await app.close(); }
});

test('map responses name their version and report a pull; edits from the old view are refused', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'outside-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = (route, body) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const created = await (await call('/maps', { title: 'Shared notes', idea: 'Works offline.' })).json();
    assert.match(created.fingerprint, /^[a-f0-9]{64}$/); assert.equal(created.outsideChange, null);
    const listed = (await (await call('/maps')).json()).maps.find(m => m.id === created.id);
    assert.equal(listed.fingerprint, created.fingerprint);
    const file = path.join(workspace, 'ideas', created.id, 'map.json');
    const pulled = JSON.parse(await readFile(file, 'utf8')); pulled.title = 'Renamed by a teammate';
    await writeFile(file, JSON.stringify(pulled, null, 2) + '\n');
    const refused = await call(`/maps/${created.id}/action`, { expectedRevision: created.revision, expectedFingerprint: created.fingerprint, nodeId: created.rootId, type: 'suggest', title: 'Mine', body: 'From the old view.' });
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'changed-outside');
    const adopted = await (await call(`/maps/${created.id}`)).json();
    assert.equal(adopted.title, 'Renamed by a teammate'); assert.ok(adopted.outsideChange.at);
    assert.notEqual(adopted.fingerprint, created.fingerprint);
    const saved = await call(`/maps/${created.id}/action`, { expectedRevision: adopted.revision, expectedFingerprint: adopted.fingerprint, nodeId: created.rootId, type: 'suggest', title: 'Mine', body: 'From the new view.' });
    assert.equal(saved.status, 200);
  } finally { await app.close(); }
});

test('HTTP saves preserve UTF-8 characters split across request chunks', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'unicode-http-'));
  const app = await startServer({ workspace, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const idea = 'Keep the café notes 🧠 intact.';
    const bytes = Buffer.from(JSON.stringify({ title: 'Unicode notes', idea }));
    const boundaries = [0, bytes.indexOf(Buffer.from('é')) + 1, bytes.indexOf(Buffer.from('🧠')) + 2, bytes.length];
    const response = await new Promise((resolve, reject) => {
      const request = http.request(app.address + '/api/maps', { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': bytes.length,
      } }, response => {
        response.setEncoding('utf8'); let raw = '';
        response.on('data', chunk => { raw += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(raw) }));
        response.on('error', reject);
      });
      request.on('error', reject);
      (async () => {
        for (let index = 0; index < boundaries.length - 1; index++) {
          request.write(bytes.subarray(boundaries[index], boundaries[index + 1]));
          await delay(25);
        }
        request.end();
      })().catch(reject);
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.originalIdea, idea);
    assert.equal((await app.store.get(response.body.id)).nodes[0].prompt, idea);
  } finally { await app.close(); }
});

test('the server serves every module the browser app imports', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const app = await startServer({ workspace: await mkdtemp(path.join(root, 'assets-')), port: 0 });
  try {
    const assets = path.resolve('skills/explore/assets'), seen = new Set(), queue = ['app.js'];
    while (queue.length) {
      const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
      const response = await fetch(`${app.address}/${file}`);
      assert.equal(response.status, 200, `${file} is served`);
      for (const [, imported] of (await readFile(path.join(assets, file), 'utf8')).matchAll(/from '\.\/([\w-]+\.js)'/g)) queue.push(imported);
    }
    assert.ok(seen.has('question-clicks.js'));
  } finally { await app.close(); }
});
