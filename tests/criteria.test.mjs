import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { reconsiderationsOf, proposalState, criteriaDialogHtml, reconsideredHtml, criteriaEntryHtml } from '../skills/explore/assets/criteria.js';
import { criteriaDialog } from '../skills/explore/assets/criteria-dialog.js';

// Compare options with your own criteria (C9, #14). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const options = [{ id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.' }, { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' }];
const comparison = { options, recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' } };

async function setup({ questions = [] } = {}) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'criteria-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Two ways to sync.', body: 'Details.', ...comparison, ...(questions.length ? { questions } : {}) });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input });
  return { store, map, act, node: async () => (await store.get(map.id)).nodes[0] };
}
const criteria = [{ label: 'Cheap to run', priority: 'low' }, { label: 'Works with no signal', priority: 'high' }];
const assessments = (node, extra = {}) => node.options.flatMap(option => node.criteria.map(criterion => ({ optionId: option.id, criterionId: criterion.id, text: `${option.id} on ${criterion.label}.`, basis: 'reasoning', ...extra })));
const revised = node => ({ assessments: assessments(node), recommendation: { optionId: 'lock', rationale: 'Offline matters most to you, and locking is simpler offline.', mainTradeoff: 'Less concurrent editing.' }, changed: 'Your high priority on working with no signal favours locking.' });

test('criteria save sorted by priority and queue no work; an idea without options takes none', async () => {
  const { store, map, act, node } = await setup();
  const before = (await store.get(map.id)).jobs.length;
  let saved = await act({ type: 'set-criteria', criteria });
  const list = saved.nodes[0].criteria;
  assert.deepEqual(list.map(item => [item.label, item.priority]), [['Works with no signal', 'high'], ['Cheap to run', 'low']]);
  assert.ok(list.every(item => /^crit-[0-9a-f]{8}$/.test(item.id))); assert.equal(saved.jobs.length, before, 'nothing queued');
  saved = await act({ type: 'set-criteria', criteria: [{ id: list[1].id, label: 'Cheap to run', priority: 'normal' }, list[0]] });
  assert.deepEqual(saved.nodes[0].criteria.map(item => item.id), [list[0].id, list[1].id], 'ids are kept');
  for (const [bad, message] of [[Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, priority: 'low' })), /at most 8/], [[{ label: 'x'.repeat(121), priority: 'low' }], /at most 120/], [[{ label: 'Fast', priority: 'urgent' }], /High, Normal or Low/], [[{ label: ' ', priority: 'low' }], /required/]]) {
    await assert.rejects(act({ type: 'set-criteria', criteria: bad }), message);
  }
  const plain = await act({ type: 'suggest', title: 'Storage', body: 'Limits.' });
  await assert.rejects(store.action(map.id, { expectedRevision: plain.revision, type: 'set-criteria', nodeId: plain.nodes.at(-1).id, criteria }), error => error.status === 409 && /options/.test(error.message));
  saved = await act({ type: 'set-criteria', criteria: [] });
  assert.equal(Object.hasOwn(saved.nodes[0], 'criteria'), false, 'an empty list removes them');
  void node;
});

test('reconsider on a finished branch queues a job, and its result leaves status, findings and completion as they were', async () => {
  const { store, map, act, node } = await setup();
  await act({ type: 'set-criteria', criteria });
  const finished = await node();
  assert.equal(finished.status, 'explored');
  let saved = await act({ type: 'reconsider' });
  const job = saved.jobs.at(-1);
  assert.equal(job.type, 'reconsider'); assert.deepEqual(job.input.criteria, finished.criteria, 'a snapshot of the criteria');
  await assert.rejects(act({ type: 'reconsider' }), error => error.status === 409 && /already/.test(error.message), 'one at a time');
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'reconsider'); assert.deepEqual(packet.options.map(option => option.id), ['crdt', 'lock']);
  assert.equal(packet.recommendation.optionId, 'crdt'); assert.deepEqual(packet.criteria.map(item => item.priority), ['high', 'low']);
  assert.match(packet.instruction, /no new research/i); assert.match(packet.instruction, /priorities are the user's preferences, not facts/i);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, revised(finished));
  const after = saved.nodes[0];
  assert.deepEqual([after.status, after.summary, after.body, after.completedAt, after.contentRevision, after.reviewState], [finished.status, finished.summary, finished.body, finished.completedAt, finished.contentRevision, finished.reviewState]);
  assert.equal(after.recommendation.optionId, 'crdt', 'the original is never overwritten');
  assert.deepEqual(reconsiderationsOf(store.view(saved), map.rootId).latest.result.recommendation.optionId, 'lock');
});

test('a result missing a pair, with unknown IDs, or recommending against a blocking limitation is rejected unchanged', async () => {
  const { store, map, act, node } = await setup();
  await act({ type: 'set-criteria', criteria });
  await act({ type: 'reconsider' });
  const current = await node(), packet = await store.claim('agent', map.id), before = await readFile(store.file(map.id), 'utf8');
  const good = revised(current);
  for (const [bad, message] of [[{ ...good, assessments: good.assessments.slice(1) }, /every option and criterion/], [{ ...good, assessments: [...good.assessments.slice(1), { ...good.assessments[0], optionId: 'nope' }] }, /not in this comparison/],
    [{ ...good, assessments: good.assessments.map((item, i) => (i ? item : { ...item, basis: 'vibes' })) }, /evidence, reasoning or unknown/], [{ ...good, changed: undefined }, /What changed/], [{ ...good, extra: 1 }, /remove extra/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
});

test('adopting shows the revised recommendation beside the original; dismissing keeps the original only', async () => {
  const { store, map, act, node } = await setup();
  await act({ type: 'set-criteria', criteria });
  let saved = await act({ type: 'reconsider' });
  const packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, revised(await node()));
  saved = await act({ type: 'adopt-reconsideration', jobId: packet.jobId });
  const shown = store.view(saved);
  assert.equal(reconsiderationsOf(shown, map.rootId).adopted.id, packet.jobId);
  const lead = reconsideredHtml(shown, shown.nodes[0], { esc });
  assert.match(lead, /Reconsidered with your criteria/); assert.match(lead, /One editor at a time/); assert.match(lead, /What changed: Your high priority/);
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /### Your criteria\n\n- High: Works with no signal\n- Low: Cheap to run/);
  assert.match(markdown, /### Reconsidered with your criteria\n\n_The agent's judgement against your priorities, not a decision\._\n\nRecommended: One editor at a time \(lock\)\./);
  assert.match(markdown, /Recommended: Merge edits automatically/, 'the original stays');
  const brief = mapBrief(await store.get(map.id)), item = brief.sections.find(s => s.id === 'recommendations').items[0];
  assert.match(item.text, /^Reconsidered with your criteria: One editor at a time\. Original: Merge edits automatically\./);
  assert.match(contextExcerpt(await store.get(map.id), map.rootId, { section: 'options' }).excerpt, /Your criteria[\s\S]*Reconsidered with your criteria/);
  saved = await act({ type: 'dismiss-reconsideration', jobId: packet.jobId });
  assert.equal(reconsiderationsOf(store.view(saved), map.rootId).adopted, null, 'back to the original only');
  assert.equal(reconsideredHtml(store.view(saved), store.view(saved).nodes[0], { esc }), '');
});

test('criteria edited after the request mark the proposal as based on earlier criteria, which cannot be adopted; a stale idea cannot be reconsidered', async () => {
  const { store, map, act, node } = await setup({ questions: ['Which phones?'] });
  await act({ type: 'set-criteria', criteria });
  await act({ type: 'reconsider' });
  const packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, revised(await node()));
  const current = await node();
  await act({ type: 'set-criteria', criteria: [...current.criteria, { label: 'Easy to explain', priority: 'normal' }] });
  const shown = store.view(await store.get(map.id)), job = reconsiderationsOf(shown, map.rootId).latest;
  assert.equal(proposalState(shown.nodes[0], job), 'earlier-criteria');
  await assert.rejects(act({ type: 'adopt-reconsideration', jobId: job.id }), error => error.status === 409 && /earlier criteria/.test(error.message));
  await act({ type: 'dismiss-reconsideration', jobId: job.id });
  // An earlier premise changed: the idea's findings need review, and reconsidering waits for that.
  const raw = await store.get(map.id); raw.nodes[0].stale = true;
  const { writeFile } = await import('node:fs/promises'); await writeFile(store.file(map.id), JSON.stringify(raw));
  await assert.rejects(act({ type: 'reconsider' }), error => error.status === 409 && /need review/.test(error.message));
});

test('stopping, failing or restarting a reconsideration never changes the idea\'s status', async () => {
  const { store, map, act, node } = await setup();
  await act({ type: 'set-criteria', criteria });
  const status = (await node()).status;
  let saved = await act({ type: 'reconsider' });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal(saved.jobs.at(-1).status, 'cancelled'); assert.equal(saved.nodes[0].status, status);
  await act({ type: 'reconsider' });
  let packet = await store.claim('agent', map.id);
  saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'No time.');
  assert.equal(saved.jobs.at(-1).status, 'failed'); assert.equal(saved.nodes[0].status, status);
  await act({ type: 'reconsider' });
  packet = await store.claim('agent', map.id);
  const restarted = new Store(path.dirname(path.dirname(store.file(map.id))));
  await restarted.recover?.();
  assert.equal((await restarted.get(map.id)).nodes[0].status, status);
});

test('the dialog lists the criteria by priority, shows a proposal as a grid, and says when it is based on earlier criteria', () => {
  const node = { id: 'root', title: 'Root', ...comparison, criteria: [{ id: 'crit-aaaaaaaa', label: 'No <signal>', priority: 'high' }, { id: 'crit-bbbbbbbb', label: 'Cheap', priority: 'low' }] };
  const job = { id: 'job-1', type: 'reconsider', nodeId: 'root', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', input: { criteria: node.criteria }, result: { ...revised(node), assessments: assessments(node, { text: 'Fine <here>.' }) } };
  const map = { nodes: [node], jobs: [job] };
  const html = criteriaDialogHtml({ map, node, esc, draft: node.criteria, live: true });
  assert.match(html, /<input id="criterion-0" data-criterion-label="0" maxlength="120" value="No &lt;signal&gt;"/); assert.match(html, /<option value="high" selected>High<\/option>/);
  assert.match(html, /<table class="criteria-grid">/); assert.match(html, /<th scope="col">No &lt;signal&gt; <small>High<\/small><\/th>/); assert.match(html, /Fine &lt;here&gt;\. <small>Reasoning<\/small>/);
  assert.match(html, /data-reconsider-adopt="job-1">Use revised comparison<\/button>/); assert.match(html, /data-reconsider-dismiss="job-1">Keep original<\/button>/);
  const edited = { ...node, criteria: [...node.criteria, { id: 'crit-cccccccc', label: 'New', priority: 'normal' }] };
  const earlier = criteriaDialogHtml({ map: { nodes: [edited], jobs: [job] }, node: edited, esc, draft: edited.criteria, live: true });
  assert.match(earlier, /Based on earlier criteria/); assert.doesNotMatch(earlier, /data-reconsider-adopt/);
  assert.match(criteriaDialogHtml({ map: { nodes: [node], jobs: [{ ...job, stale: true }] }, node, esc, draft: node.criteria, live: true }), /Outdated: the idea changed since you asked/);
  assert.match(criteriaEntryHtml(node, { esc, live: true }), /<button type="button" class="secondary" data-criteria-open="root">Compare with my criteria<\/button>/);
  assert.equal(criteriaEntryHtml({ id: 'x' }, { esc, live: true }), '', 'only an idea with options');
});

// A small fake DOM for the dialog.
function fakeDialog({ map, act }) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', open: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, querySelector() { return { focus() {} }; } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const dialog = criteriaDialog({ map, act, esc, toast: () => {}, live: () => true, listening: () => false });
  const click = dataset => element('criteria-body').fire('click', { target: { closest: () => ({ dataset }) } });
  return { element, dialog, click };
}

test('the dialog opens from the inspector, edits and saves criteria, asks for a reconsideration, and adopts or keeps the original', async () => {
  const node = { id: 'root', title: 'Root', ...comparison, criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }] };
  let map = { nodes: [node], jobs: [] };
  const calls = [];
  const io = fakeDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; } });
  try {
    await io.element('detail').fire('click', { target: { closest: selector => (selector === '[data-criteria-open]' ? { dataset: { criteriaOpen: 'root' } } : null) } });
    assert.equal(io.element('criteria-dialog').open, true); assert.match(io.element('criteria-body').innerHTML, /value="No signal"/);
    await io.click({ criterionAdd: '' });
    await io.element('criteria-body').fire('input', { target: { dataset: { criterionLabel: '1' }, value: 'Cheap' } });
    await io.element('criteria-body').fire('change', { target: { dataset: { criterionPriority: '1' }, value: 'low' } });
    await io.click({ criteriaSave: '' });
    assert.deepEqual(calls.at(-1), ['root', 'set-criteria', { criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }, { label: 'Cheap', priority: 'low' }] }]);
    await io.click({ criterionRemove: '1' });
    await io.click({ reconsiderAsk: '' });
    assert.deepEqual(calls.slice(-2), [['root', 'set-criteria', { criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }] }], ['root', 'reconsider', {}]], 'unsaved edits are saved first');
    map = { nodes: [node], jobs: [{ id: 'job-1', type: 'reconsider', nodeId: 'root', status: 'completed', input: { criteria: node.criteria }, result: revised(node) }] };
    io.dialog.mapChanged();
    assert.match(io.element('criteria-body').innerHTML, /Use revised comparison/);
    await io.click({ reconsiderAdopt: 'job-1' }); assert.deepEqual(calls.at(-1), ['root', 'adopt-reconsideration', { jobId: 'job-1' }]);
    await io.click({ reconsiderDismiss: 'job-1' }); assert.deepEqual(calls.at(-1), ['root', 'dismiss-reconsideration', { jobId: 'job-1' }]);
  } finally { delete globalThis.document; }
});
