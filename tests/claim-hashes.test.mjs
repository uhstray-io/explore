import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';

// Claim keys never reach a shared map file: only their hash does (H8, #37).
async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'claims-'));
  const store = new Store(path.join(dir, 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  return { store, map };
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const result = { summary: 'Offline first.', body: 'Illustrative fixture.' };

test('a claim stores only the hash of its key, and the key still delivers the result', async () => {
  const { store, map } = await fixture();
  const packet = await store.claim('agent', map.id);
  assert.match(packet.claimKey, /^[0-9a-f-]{36}$/);
  let raw = await readFile(store.file(map.id), 'utf8');
  assert.doesNotMatch(raw, new RegExp(packet.claimKey));
  assert.equal(JSON.parse(raw).jobs[0].claimHash, sha256(packet.claimKey));
  await assert.rejects(store.complete(map.id, packet.jobId, 'not-the-key', result), error => error.status === 409);
  await store.complete(map.id, packet.jobId, packet.claimKey, result);
  raw = await readFile(store.file(map.id), 'utf8');
  assert.doesNotMatch(raw, /claimKey/);
  assert.equal(JSON.parse(raw).nodes[0].summary, 'Offline first.');
});

test('retrying a delivered result is idempotent, even from a new Store', async () => {
  const { store, map } = await fixture();
  const packet = await store.claim('agent', map.id);
  const first = await store.complete(map.id, packet.jobId, packet.claimKey, { ...result, suggestions: [{ title: 'Sync', body: 'Later.' }] });
  const again = await new Store(store.directory).complete(map.id, packet.jobId, packet.claimKey, { ...result, suggestions: [{ title: 'Sync', body: 'Later.' }] });
  assert.equal(again.revision, first.revision);
  assert.equal(again.nodes.length, 2);
});

test('a failure needs the key too', async () => {
  const { store, map } = await fixture();
  const packet = await store.claim('agent', map.id);
  await assert.rejects(store.fail(map.id, packet.jobId, 'not-the-key', 'No.'), error => error.status === 409);
  const saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'Could not finish.');
  assert.equal(saved.jobs[0].status, 'failed');
});

test('a legacy map keeps its key until its next save, and a running legacy job can still deliver', async () => {
  const { store, map } = await fixture();
  const file = store.file(map.id), legacy = JSON.parse(await readFile(file, 'utf8'));
  Object.assign(legacy.jobs[0], { status: 'running', worker: 'agent', claimKey: 'legacy-key', startedAt: legacy.updatedAt });
  legacy.nodes[0].status = 'running';
  await writeFile(file, JSON.stringify(legacy, null, 2) + '\n');
  const before = await readFile(file, 'utf8');
  const fresh = new Store(store.directory);
  await fresh.get(map.id); await fresh.list();
  assert.equal(await readFile(file, 'utf8'), before, 'reading changes nothing');
  await fresh.action(map.id, { type: 'suggest', nodeId: map.rootId, title: 'Sync', body: 'Later.', expectedRevision: legacy.revision });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.jobs[0].claimKey, undefined);
  assert.equal(saved.jobs[0].claimHash, sha256('legacy-key'));
  const done = await fresh.complete(map.id, saved.jobs[0].id, 'legacy-key', result);
  assert.equal(done.jobs[0].status, 'completed');
});

