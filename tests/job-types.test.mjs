import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Store, Problem, isCompleted, publicMap } from '../skills/explore/scripts/store.mjs';
import { createRegistry } from '../skills/explore/scripts/job-types.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';

// Test-only types: no user-visible job type exists yet. Feature issues register their own.
const registry = createRegistry({
  jobTypes: {
    'test-helper': { label: 'Test helper', target: 'node',
      packet: ({ node }) => ({ node: { id: node.id, title: node.title }, instruction: 'Return a short note about this idea.' }),
      validate: result => ({ note: String(result.note) }) },
    'test-map-check': { label: 'Test map check', target: 'map',
      packet: ({ map }) => ({ ideas: map.nodes.length, instruction: 'Count the ideas.' }),
      validate: result => ({ count: Number(result.count) }) },
    'test-async': { label: 'Test async', target: 'node',
      packet: async ({ node }) => ({ node: node.id, instruction: 'Built asynchronously.' }),
      validate: async result => ({ note: String(result.note) }) },
    'test-huge': { label: 'Test huge', target: 'map',
      packet: () => ({ instruction: 'Too long. '.repeat(2000) }),
      validate: result => result },
  },
  actions: {
    'request-helper': { target: 'node', apply: ({ map, node, input, store }) => { store.enqueueJob(map, { type: 'test-helper', nodeId: node.id, subjectId: input.questionId, reason: 'User asked for help.' }); } },
    'request-map-check': { target: 'map', apply: ({ map, store }) => { store.enqueueJob(map, { type: 'test-map-check', reason: 'User asked for a map check.' }); } },
    'request-async': { target: 'node', apply: ({ map, node, store }) => { store.enqueueJob(map, { type: 'test-async', nodeId: node.id, reason: 'Async test.' }); } },
    'request-huge': { target: 'map', apply: ({ map, store }) => { store.enqueueJob(map, { type: 'test-huge', reason: 'Huge test.' }); } },
    'rename-map': { target: 'map', apply: ({ map, input }) => { map.title = input.title; } },
  },
  settings: {
    'test-minutes': { default: 2, validate: value => { if (![2, 10].includes(value)) throw new Problem('Choose 2 or 10 minutes.'); return value; } },
  },
});

async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'jobs-'));
  const store = new Store(path.join(dir, 'ideas'), { registry });
  const map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  return { dir, store, map };
}
async function act(store, mapId, input) {
  const map = await store.get(mapId);
  return store.action(mapId, { expectedRevision: map.revision, ...input });
}
// Root investigation finishes with one open question and one suggested child.
async function explored() {
  const context = await fixture();
  const job = await context.store.claim('test');
  await context.store.complete(context.map.id, job.jobId, job.claimKey, { summary: 'A focused finding.', body: 'What was found, with its limits.', questions: ['Who resolves conflicts?'], suggestions: [{ title: 'Sync timing', body: 'When should devices sync?' }] });
  return context;
}

test('a helper job on an idea runs its whole life without touching that idea', async () => {
  const { store, map } = await explored();
  const before = await store.get(map.id);
  const root = structuredClone(before.nodes[0]), growth = structuredClone(before.growth);
  let saved = await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  const job = saved.jobs.at(-1);
  assert.equal(job.type, 'test-helper'); assert.equal(job.nodeId, map.rootId); assert.equal(job.status, 'queued');
  const packet = await store.claim('test');
  assert.equal(packet.jobType, 'test-helper'); assert.equal(packet.jobId, job.id);
  assert.equal(packet.node.id, map.rootId); assert.match(packet.instruction, /short note/);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { note: 'Try a field test.' });
  const done = saved.jobs.find(j => j.id === job.id);
  assert.equal(done.status, 'completed'); assert.deepEqual(done.result, { note: 'Try a field test.' });
  assert.deepEqual(saved.nodes[0], root, 'status, findings, questions and revision stay as they were');
  assert.deepEqual(saved.growth, growth);
  const repeat = await store.complete(map.id, packet.jobId, packet.claimKey, { note: 'Again.' });
  assert.equal(repeat.revision, saved.revision, 'a delivery retry changes nothing');
});

test('a completed helper job never completes its idea', async () => {
  const { store, map } = await explored();
  const child = (await store.get(map.id)).nodes[1];
  await act(store, map.id, { type: 'request-helper', nodeId: child.id });
  const packet = await store.claim('test');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { note: 'Helpful context.' });
  const node = saved.nodes.find(n => n.id === child.id);
  assert.equal(isCompleted(saved, node), false);
  assert.equal(node.status, 'suggested');
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${child.id}.md`), 'utf8');
  assert.doesNotMatch(doc, /Earlier investigation result/, 'helper results are not investigation history');
});

test('failing, recovering and cancelling a helper job leave the idea unchanged', async () => {
  const { store, map } = await explored();
  const before = await store.get(map.id);
  const root = structuredClone(before.nodes[0]), growth = structuredClone(before.growth);
  const unchanged = saved => { assert.deepEqual(saved.nodes[0], root); assert.deepEqual(saved.growth, growth); };
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  let packet = await store.claim('test');
  let saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'Could not help.');
  assert.equal(saved.jobs.find(j => j.id === packet.jobId).status, 'failed');
  unchanged(saved);

  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  packet = await store.claim('test');
  const restarted = new Store(store.directory, { registry });
  await restarted.recover();
  saved = await restarted.get(map.id);
  assert.equal(saved.jobs.find(j => j.id === packet.jobId).status, 'interrupted');
  unchanged(saved);

  saved = await act(restarted, map.id, { type: 'request-helper', nodeId: map.rootId });
  const queued = saved.jobs.at(-1);
  saved = await act(restarted, map.id, { type: 'cancel-job', jobId: queued.id });
  assert.equal(saved.jobs.find(j => j.id === queued.id).status, 'cancelled');
  unchanged(saved);
  await assert.rejects(act(restarted, map.id, { type: 'cancel-job', jobId: queued.id }), error => error.status === 409);

  await act(restarted, map.id, { type: 'request-helper', nodeId: map.rootId });
  packet = await restarted.claim('test');
  saved = await act(restarted, map.id, { type: 'cancel-job', jobId: packet.jobId });
  assert.equal(saved.jobs.find(j => j.id === packet.jobId).status, 'cancelled', 'running work can be stopped too');
  await assert.rejects(restarted.complete(map.id, packet.jobId, packet.claimKey, { note: 'Too late.' }), error => error.status === 409);
  unchanged(await restarted.get(map.id));
});

test('map-level work can fail and be stopped like work on an idea', async () => {
  const { store, map } = await explored();
  await act(store, map.id, { type: 'request-map-check' });
  let packet = await store.claim('test');
  let saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'Could not count.');
  assert.equal(saved.jobs.find(j => j.id === packet.jobId).status, 'failed');
  saved = await act(store, map.id, { type: 'request-map-check' });
  saved = await act(store, map.id, { type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal(saved.jobs.at(-1).status, 'cancelled');
});

test('a helper result whose idea changed while it ran is kept but marked stale', async () => {
  const { store, map } = await explored();
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  const packet = await store.claim('test');
  const current = await store.get(map.id);
  await act(store, map.id, { type: 'answer', nodeId: map.rootId, questionId: current.nodes[0].questions[0].id, answer: 'The owner decides.' });
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { note: 'Written before the answer.' });
  const job = saved.jobs.find(j => j.id === packet.jobId);
  assert.equal(job.status, 'completed'); assert.equal(job.stale, true);
  assert.deepEqual(job.result, { note: 'Written before the answer.' });
});

test('asynchronous packet builders and validators are awaited', async () => {
  const { store, map } = await explored();
  await act(store, map.id, { type: 'request-async', nodeId: map.rootId });
  const packet = await store.claim('test');
  assert.match(packet.instruction, /^Built asynchronously\. Keep names/, 'the built instruction, then the privacy sentence');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { note: 'Awaited.' });
  assert.deepEqual(saved.jobs.find(j => j.id === packet.jobId).result, { note: 'Awaited.' });
});

test('work too large for the packet budget fails with a reason and the queue moves on', async () => {
  const { store, map } = await explored();
  await act(store, map.id, { type: 'request-huge' });
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  const packet = await store.claim('test');
  assert.equal(packet.jobType, 'test-helper');
  const huge = (await store.get(map.id)).jobs.find(j => j.type === 'test-huge');
  assert.equal(huge.status, 'failed'); assert.match(huge.error, /packet budget/); assert.equal(huge.claimKey, undefined);
});

test('work this version cannot run is not counted as waiting', async () => {
  const { store, map } = await explored();
  const saved = await store.get(map.id);
  saved.jobs.push({ id: 'job-0000beef', type: 'from-the-future', nodeId: null, status: 'queued', reason: 'Newer Explore.', createdAt: new Date().toISOString() });
  await writeFile(store.file(map.id), JSON.stringify(saved, null, 2));
  assert.equal((await store.list())[0].pending, 0);
  const view = store.view(await store.get(map.id));
  assert.equal(view.jobs.find(j => j.id === 'job-0000beef').unsupported, true);
  assert.equal(view.jobs.find(j => j.id !== 'job-0000beef').unsupported, undefined);
});

test('cancel-job leaves branch investigations to the existing cancel action', async () => {
  const { store, map } = await fixture();
  const job = (await store.get(map.id)).jobs[0];
  await assert.rejects(act(store, map.id, { type: 'cancel-job', jobId: job.id }), /Stop exploration/);
  await assert.rejects(act(store, map.id, { type: 'cancel-job', jobId: 'job-00000000' }), error => error.status === 404);
});

test('repeat requests reuse the open job for the same type and target, and investigations stay separate', async () => {
  const { store, map } = await explored();
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  let saved = await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  assert.equal(saved.jobs.filter(j => j.type === 'test-helper').length, 1);
  await act(store, map.id, { type: 'request-map-check' });
  saved = await act(store, map.id, { type: 'request-map-check' });
  assert.equal(saved.jobs.filter(j => j.type === 'test-map-check').length, 1);
  const child = saved.nodes[1];
  await act(store, map.id, { type: 'request-helper', nodeId: child.id });
  saved = await act(store, map.id, { type: 'activate', nodeId: child.id });
  const childJobs = saved.jobs.filter(j => j.nodeId === child.id);
  assert.deepEqual(childJobs.map(j => j.type || 'investigate').sort(), ['investigate', 'test-helper'], 'a queued helper does not stand in for an investigation');
  assert.equal(saved.nodes.find(n => n.id === child.id).status, 'queued');
  const question = saved.nodes[0].questions[0].id;
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId, questionId: question });
  saved = await act(store, map.id, { type: 'request-helper', nodeId: map.rootId, questionId: question });
  const rootHelpers = saved.jobs.filter(j => j.type === 'test-helper' && j.nodeId === map.rootId);
  assert.deepEqual(rootHelpers.map(j => j.subjectId ?? null), [null, question], 'work about one question is grouped by that question');
});

test('a map-level job has no idea and nothing that reads jobs by idea breaks', async () => {
  const { store, map } = await explored();
  let saved = await act(store, map.id, { type: 'request-map-check' });
  const job = saved.jobs.at(-1);
  assert.equal(job.nodeId, null); assert.equal(job.type, 'test-map-check');
  const packet = await store.claim('test');
  assert.equal(packet.jobType, 'test-map-check'); assert.equal(packet.mapId, map.id); assert.equal(packet.ideas, 2);
  const restarted = new Store(store.directory, { registry });
  await restarted.recover();
  saved = await restarted.get(map.id);
  assert.equal(saved.jobs.find(j => j.id === job.id).status, 'interrupted');
  assert.ok(publicMap(saved)); assert.ok(mapBrief(saved)); assert.ok(await restarted.list());

  await act(restarted, map.id, { type: 'request-map-check' });
  const again = await restarted.claim('test');
  saved = await restarted.complete(map.id, again.jobId, again.claimKey, { count: 2 });
  assert.deepEqual(saved.jobs.find(j => j.id === again.jobId).result, { count: 2 });
});

test('typed packets name their type and stay within the packet budget', async () => {
  const { store, map } = await fixture();
  const investigation = await store.claim('test');
  assert.equal(investigation.jobType, 'investigate');
  await store.complete(map.id, investigation.jobId, investigation.claimKey, { summary: 'Done.', body: 'Finished.', questions: ['Next?'] });
  await act(store, map.id, { type: 'request-helper', nodeId: map.rootId });
  const helper = await store.claim('test');
  assert.equal(helper.jobType, 'test-helper');
  assert.ok(JSON.stringify(helper).length <= 15500);
  assert.equal(helper.contextCharacters, JSON.stringify({ ...helper, contextCharacters: undefined, approximateTokens: undefined }).length);
});

test('map-level actions still need the current revision and run one at a time', async () => {
  const { store, map } = await fixture();
  const current = await store.get(map.id);
  await assert.rejects(store.action(map.id, { type: 'rename-map', title: 'No revision' }), error => error.status === 409);
  const results = await Promise.allSettled([
    store.action(map.id, { type: 'rename-map', title: 'First', expectedRevision: current.revision }),
    store.action(map.id, { type: 'rename-map', title: 'Second', expectedRevision: current.revision }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  assert.equal((await store.get(map.id)).title, 'First');
  await assert.rejects(act(store, map.id, { type: 'activate' }), error => error.status === 404, 'undeclared actions still need an idea');
});

test('a job type this version does not know stays queued for a newer version', async () => {
  const { store, map } = await explored();
  const saved = await store.get(map.id);
  saved.jobs.push({ id: 'job-0000beef', type: 'from-the-future', nodeId: null, status: 'queued', reason: 'Newer Explore.', createdAt: new Date().toISOString() });
  await writeFile(store.file(map.id), JSON.stringify(saved, null, 2));
  assert.equal(await store.claim('test'), null);
  assert.equal((await store.get(map.id)).jobs.at(-1).status, 'queued');
});

test('queued work whose idea no longer exists fails with that reason instead of blocking the queue', async () => {
  const { store, map } = await explored();
  const saved = await store.get(map.id);
  saved.jobs.push({ id: 'job-0000dead', nodeId: 'node-gone0000', status: 'queued', reason: 'Old work.', createdAt: new Date().toISOString() });
  saved.jobs.push({ id: 'job-0000feed', type: 'test-helper', nodeId: 'node-gone0000', status: 'queued', reason: 'Old help.', createdAt: new Date().toISOString() });
  await writeFile(store.file(map.id), JSON.stringify(saved, null, 2));
  assert.equal(await store.claim('test'), null);
  const after = await store.get(map.id);
  for (const id of ['job-0000dead', 'job-0000feed']) {
    const job = after.jobs.find(j => j.id === id);
    assert.equal(job.status, 'failed'); assert.match(job.error, /no longer exists/);
  }
});

test('settings are shared in the repo next to the maps and validated per field', async () => {
  const { dir, store } = await fixture();
  assert.deepEqual(await store.getSettings(), { version: 1, revision: 0, listenMinutes: 2, researchModelHint: '', 'test-minutes': 2 });
  await assert.rejects(store.updateSettings({ expectedRevision: 0, unknown: true }), /Unknown setting/);
  await assert.rejects(store.updateSettings({ expectedRevision: 0, 'test-minutes': 7 }), /2 or 10/);
  await assert.rejects(store.updateSettings({ 'test-minutes': 10 }), error => error.status === 409);
  const saved = await store.updateSettings({ expectedRevision: 0, 'test-minutes': 10 });
  assert.deepEqual(saved, { version: 1, revision: 1, listenMinutes: 2, researchModelHint: '', 'test-minutes': 10 });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'ideas', 'settings.json'), 'utf8')), { 'test-minutes': 10, version: 1, revision: 1 }, 'only chosen values are written; the rest keep their defaults');
  await assert.rejects(store.updateSettings({ expectedRevision: 0, 'test-minutes': 2 }), error => error.status === 409);
  await assert.rejects(access(path.join(dir, '.explore')), 'settings never go to the local runtime folder');
  assert.equal((await store.list()).length, 1, 'the settings file is not mistaken for a map');
});

test('a save with no settings changes nothing and creates no file', async () => {
  const { dir, store } = await fixture();
  await assert.rejects(store.updateSettings({ expectedRevision: 0 }), error => error.status === 400 && /Choose a setting/.test(error.message));
  await assert.rejects(access(path.join(dir, 'ideas', 'settings.json')));
});

test('settings saved by a newer Explore version are shown as defaults and never overwritten', async () => {
  const { dir, store } = await fixture();
  const file = path.join(dir, 'ideas', 'settings.json');
  const newer = JSON.stringify({ version: 2, revision: 7, 'test-minutes': 10, futureField: 'kept' });
  await writeFile(file, newer);
  const settings = await store.getSettings();
  assert.equal(settings.newer, true); assert.equal(settings['test-minutes'], 2);
  await assert.rejects(store.updateSettings({ expectedRevision: settings.revision, 'test-minutes': 10 }), error => error.status === 409 && /newer version/.test(error.message));
  assert.equal(await readFile(file, 'utf8'), newer);
});

test('an unreadable settings file falls back to defaults and is replaced only by a save', async () => {
  const { dir, store } = await fixture();
  const file = path.join(dir, 'ideas', 'settings.json');
  await writeFile(file, '<<<<<<< HEAD\n{ "version": 1 }\n');
  const settings = await store.getSettings();
  assert.equal(settings['test-minutes'], 2); assert.equal(settings.revision, 0); assert.equal(settings.unreadable, true);
  assert.match(await readFile(file, 'utf8'), /<<<<<<< HEAD/, 'reading never rewrites the file');
  await store.updateSettings({ expectedRevision: 0, 'test-minutes': 10 });
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['test-minutes'], 10);
});
