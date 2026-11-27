import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { cleanName } from '../skills/explore/scripts/contributor.mjs';

const exec = promisify(execFile);
const result = { summary: 'A finding.', body: 'What was found.', questions: ['Who decides?'] };
async function explored(store) {
  const map = await store.create({ title: 'Shared notes', idea: 'Works offline.' });
  const job = await store.claim('test');
  await store.complete(map.id, job.jobId, job.claimKey, result);
  return store.get(map.id);
}
async function workspace(name) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'contributor-'));
  await exec('git', ['init', '-q', dir]);
  // A repository-local value overrides any global one, so tests never depend on this machine's Git name.
  await exec('git', ['-C', dir, 'config', 'user.name', name]);
  await exec('git', ['-C', dir, 'config', 'user.email', 'someone@example.invalid']);
  return dir;
}

test('answers and acceptances record the contributor, and nothing extra without one', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'contributor-store-')), 'ideas'));
  let map = await explored(store);
  map = await store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'The owner.' }, { actor: { name: 'Ana' } });
  assert.deepEqual(map.nodes[0].questions[0].answeredBy, { name: 'Ana' });
  const job = await store.claim('test');
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Done.', body: 'Finished.' });
  map = await store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'accept' }, { actor: { name: 'Ana' } });
  assert.deepEqual(map.nodes[0].acceptedBy, { name: 'Ana' });
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /Answered by Ana/); assert.match(doc, /Accepted by Ana/);

  let other = await explored(store);
  other = await store.action(other.id, { expectedRevision: other.revision, nodeId: other.rootId, type: 'answer', questionId: other.nodes[0].questions[0].id, answer: 'Nobody yet.' });
  assert.equal('answeredBy' in other.nodes[0].questions[0], false, 'no name, no new field');
  const next = await store.claim('test');
  other = await store.complete(other.id, next.jobId, next.claimKey, { summary: 'Done.', body: 'Finished.' });
  other = await store.action(other.id, { expectedRevision: other.revision, nodeId: other.rootId, type: 'accept' });
  assert.equal(other.nodes[0].acceptedBy, 'user', 'the legacy value stays');
});

test('names are cleaned, never contain the email, and render as literal Markdown text', async () => {
  assert.equal(cleanName('  Ana \n'), 'Ana');
  assert.equal(cleanName(''), null); assert.equal(cleanName('\u0007\u0000'), null);
  assert.equal(cleanName('x'.repeat(90)).length, 60);
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'contributor-md-')), 'ideas'));
  const map = await explored(store);
  await store.action(map.id, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'Yes.' }, { actor: { name: '<b>Ana</b>' } });
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /Answered by &lt;b&gt;Ana&lt;\/b&gt;/); assert.doesNotMatch(doc, /<b>Ana/);
});

test('the server attributes edits to the Git name and keeps it out of packets, briefs and the session', async () => {
  const dir = await workspace('Ana Example');
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token, ...session } = await (await fetch(app.address + '/api/session')).json();
    assert.doesNotMatch(JSON.stringify(session), /Ana Example/);
    const call = (route, body) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => r.json());
    assert.deepEqual(await call('/contributor'), { name: 'Ana Example', source: 'git' });
    let map = await explored(app.store);
    map = await call(`/maps/${map.id}/action`, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'The owner.' });
    assert.deepEqual(map.nodes[0].questions[0].answeredBy, { name: 'Ana Example' });
    const packet = await call('/next?worker=test');
    assert.equal(packet.jobType, 'investigate'); assert.doesNotMatch(JSON.stringify(packet), /Ana Example/);
    assert.doesNotMatch(JSON.stringify(await call(`/maps/${map.id}/brief`)), /Ana Example/);
    const saved = JSON.stringify(await app.store.get(map.id));
    assert.doesNotMatch(saved, /someone@example\.invalid/, 'the email is never stored');
    assert.equal((await readdir(path.join(dir, '.explore'))).some(name => /contributor/.test(name)), false, 'no contributor file anywhere');
  } finally { await app.close(); }
});

test('with no Git name the server records nothing and says so', async () => {
  const dir = await workspace('');
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const { token } = await (await fetch(app.address + '/api/session')).json();
    const call = (route, body) => fetch(app.address + '/api' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => r.json());
    assert.deepEqual(await call('/contributor'), { name: null });
    let map = await explored(app.store);
    map = await call(`/maps/${map.id}/action`, { expectedRevision: map.revision, nodeId: map.rootId, type: 'answer', questionId: map.nodes[0].questions[0].id, answer: 'Unattributed.' });
    assert.equal('answeredBy' in map.nodes[0].questions[0], false);
  } finally { await app.close(); }
});
