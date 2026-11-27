import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { validateMap, checkMapFile } from '../skills/explore/scripts/map-validation.mjs';

// Map validation (H1, #30). Fixtures live under .test-output, never ideas/.
const exec = promisify(execFile);
const validator = path.resolve('skills/explore/scripts/validate.mjs');
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'validate-'));
  return { dir, store: new Store(path.join(dir, 'ideas')) };
}
// A map after a full claim, question, answer, result and accept loop.
async function fullMap(store) {
  let map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  let job = await store.claim('agent', map.id);
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends.', body: 'Fixture.', questions: ['Offline for days?'], suggestions: [{ title: 'Sync', body: 'Later.' }] });
  map = await store.action(map.id, { type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Yes.', expectedRevision: map.revision });
  job = await store.claim('agent', map.id);
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Queue every change.', body: 'Fixture.', sources: [{ title: 'Notes', url: 'https://example.org/notes', note: 'Fixture.' }] });
  map = await store.action(map.id, { type: 'accept', nodeId: map.rootId, expectedRevision: map.revision });
  return map;
}
const run = async (args, cwd) => {
  try { const { stdout, stderr } = await exec(process.execPath, [validator, ...args], { cwd }); return { code: 0, stdout, stderr }; }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
};
const codes = result => result.errors.map(e => `${e.code} ${e.at}`);

test('a new map, a fully worked map and a legacy-shaped map are valid', async () => {
  const { store } = await workspace();
  const created = await store.create({ title: 'New', idea: 'Just started.' });
  const worked = await fullMap(store);
  const legacy = structuredClone(worked); delete legacy.growth;
  for (const node of legacy.nodes) delete node.createdAt;
  for (const edge of legacy.edges) delete edge.createdAt;
  for (const map of [created, worked, legacy]) assert.deepEqual(validateMap(map, { folderId: map.id }), { errors: [], warnings: [] });
});

test('each structural problem is reported with a code and where it is', async () => {
  const { store } = await workspace();
  const good = await fullMap(store);
  const [root, child] = good.nodes;
  const broken = (change) => { const map = structuredClone(good); change(map); return codes(validateMap(map, { folderId: good.id })); };
  const cases = [
    [map => { map.schemaVersion = 2; }, 'unsupported-version schemaVersion'],
    [map => { map.id = 'map-00000000'; }, 'id-mismatch id'],
    [map => { delete map.title; }, 'invalid-field title'],
    [map => { map.nodes[1].questions = 'none'; }, 'invalid-field nodes[1].questions'],
    [map => { map.nodes[1].id = root.id; }, 'duplicate-id nodes[1].id'],
    [map => { map.nodes[1].questions = [{ ...map.nodes[0].questions[0] }]; }, 'duplicate-id nodes[1].questions[0].id'],
    [map => { map.jobs[1].id = map.jobs[0].id; }, 'duplicate-id jobs[1].id'],
    [map => { map.rootId = 'node-missing1'; }, 'missing-node rootId'],
    [map => { map.nodes[1].parentId = 'node-missing1'; }, 'missing-node nodes[1].parentId'],
    [map => { map.nodes[0].parentId = child.id; }, 'parent-cycle nodes[0].parentId'],
    [map => { map.nodes[1].kind = 'wish'; }, 'unknown-value nodes[1].kind'],
    [map => { map.nodes[1].status = 'pondering'; }, 'unknown-value nodes[1].status'],
    [map => { map.nodes[1].reviewState = 'liked'; }, 'unknown-value nodes[1].reviewState'],
    [map => { map.edges[0].type = 'loves'; }, 'unknown-value edges[0].type'],
    [map => { map.jobs[0].status = 'paused'; }, 'unknown-value jobs[0].status'],
    [map => { map.edges[0].to = 'node-missing1'; }, 'missing-node edges[0].to'],
    [map => { map.jobs[0].nodeId = 'node-missing1'; }, 'missing-node jobs[0].nodeId'],
    [map => { map.jobs.push({ id: 'job-extra001', nodeId: child.id, status: 'queued' }, { id: 'job-extra002', nodeId: child.id, status: 'running' }); }, 'duplicate-open-job jobs[3]'],
    [map => { map.nodes[0].sources[0].url = 'javascript:alert(1)'; }, 'source-url nodes[0].sources[0].url'],
    [map => { map.growth.version = 9; }, 'invalid-growth growth'],
    [map => { map.growth.batches[0].nodeIds = 'all'; }, 'invalid-growth growth.batches[0]'],
    [map => { map.view.positions[root.id] = { x: 'left', y: 3 }; }, `invalid-position view.positions.${root.id}`],
  ];
  for (const [change, expected] of cases) assert.ok(broken(change).includes(expected), `${expected}: got ${broken(change).join('; ')}`);
});

test('unknown additive fields and unknown job types are accepted', async () => {
  const { store } = await workspace();
  const map = await fullMap(store);
  map.somethingNew = { from: 'a newer Explore' }; map.nodes[0].extra = true;
  map.jobs.push({ id: 'job-newtype1', type: 'future-kind', nodeId: null, status: 'completed' });
  assert.deepEqual(validateMap(map, { folderId: map.id }).errors, []);
});

test('a containment link that disagrees with the parent is a warning', async () => {
  const { store } = await workspace();
  const map = await fullMap(store);
  map.nodes[1].parentId = null;
  const result = validateMap(map, { folderId: map.id });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings.map(w => `${w.code} ${w.at}`), ['contains-parent edges[0]']);
});

test('file problems are reported before parsing, without quoting the file', () => {
  const marked = Buffer.from('{\n<<<<<<< HEAD\n  "title": "Private plan"\n=======\n  "title": "Other plan"\n>>>>>>> branch\n}\n');
  const conflict = checkMapFile(marked, { folderId: 'map-12345678' });
  assert.deepEqual(conflict.errors.map(e => e.code), ['conflict-markers']);
  assert.doesNotMatch(JSON.stringify(conflict), /Private plan/);
  assert.deepEqual(checkMapFile(Buffer.from('{ not json'), {}).errors.map(e => e.code), ['invalid-json']);
  assert.deepEqual(checkMapFile(Buffer.from([0x7b, 0xff, 0x7d]), {}).errors.map(e => e.code), ['invalid-utf8']);
  assert.deepEqual(checkMapFile(Buffer.from('{}'.padEnd(64)), { maxBytes: 10 }).errors.map(e => e.code), ['too-large']);
});

async function snapshot(dir) {
  const files = {};
  const walk = async folder => { for (const entry of await readdir(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) await walk(full); else files[path.relative(dir, full)] = createHash('sha256').update(await readFile(full)).digest('hex'); } };
  await walk(dir); return files;
}

test('the command checks every map, reports problems without content, and changes nothing', async () => {
  const { dir, store } = await workspace();
  const good = await fullMap(store);
  const bad = await store.create({ title: 'Secret strategy', idea: 'Private details here.' });
  const file = store.file(bad.id), raw = await readFile(file, 'utf8');
  await writeFile(file, raw.replace('"title": "Secret strategy"', '<<<<<<< HEAD\n"title": "Secret strategy"\n=======\n"title": "Other"\n>>>>>>> theirs'));
  const before = await snapshot(dir);
  const result = await run(['--workspace', dir], dir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`ideas[\\\\/]${good.id}[\\\\/]map\\.json: valid`));
  assert.match(result.stdout, /conflict-markers/); assert.match(result.stdout, /Git conflict markers/);
  assert.doesNotMatch(result.stdout + result.stderr, /Secret strategy|Private details/);
  assert.match(result.stdout, /2 maps checked/);
  assert.deepEqual(await snapshot(dir), before, 'the workspace is byte-for-byte unchanged');
  await assert.rejects(stat(path.join(dir, '.explore')), 'no runtime folder is created');
  const json = JSON.parse((await run(['--workspace', dir, '--json', path.join('ideas', bad.id)], dir)).stdout);
  assert.equal(json.ok, false); assert.equal(json.maps.length, 1); assert.equal(json.maps[0].errors[0].code, 'conflict-markers');
});

test('stale or missing generated views are warnings, and --strict makes them fail', async () => {
  const { dir, store } = await workspace();
  const map = await fullMap(store);
  const readme = path.join(store.directory, map.id, 'README.md');
  await writeFile(readme, (await readFile(readme, 'utf8')).replace(`map revision ${map.revision}.`, `map revision ${map.revision - 1}.`));
  let result = await run(['--workspace', dir], dir);
  assert.equal(result.code, 0); assert.match(result.stdout, /warning stale-view/);
  result = await run(['--workspace', dir, '--strict'], dir);
  assert.equal(result.code, 1);
});

test('no maps is fine, and unknown options are usage errors', async () => {
  const { dir } = await workspace();
  const empty = await run(['--workspace', dir], dir);
  assert.equal(empty.code, 0); assert.match(empty.stdout, /0 maps checked/);
  const usage = await run(['--workspace', dir, '--fix'], dir);
  assert.equal(usage.code, 2); assert.match(usage.stderr, /Usage/);
});
