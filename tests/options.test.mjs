import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';

async function claimed() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'options-')), 'ideas'));
  const map = await store.create({ title: 'Workshop format', idea: 'Hands-on or discussion?' });
  const job = await store.claim('test');
  return { store, map, job };
}
const option = (id, title, extra = {}) => ({ id, title, description: `${title} in practice.`, fit: `When ${title.toLowerCase()} suits the street.`, pros: ['Cheap'], cons: ['Needs a hall'], ...extra });
const base = { summary: 'Two real formats.', body: 'Compared in detail.' };
const choice = {
  ...base, questions: ['Which format should the first workshop use?'],
  options: [option('hands-on', 'Hands-on', { suggestedAnswer: 'I would start hands-on.' }), option('talk', 'Discussion group')],
  recommendation: { optionId: 'hands-on', rationale: 'People learn by doing.', mainTradeoff: 'Needs tools for everyone.', reconsiderIf: 'Few can bring tools.' },
};

test('a real choice is saved with its options and recommendation, and nothing is decided for the user', async () => {
  const { store, map, job } = await claimed();
  const saved = await store.complete(map.id, job.jobId, job.claimKey, choice);
  const root = saved.nodes[0];
  assert.deepEqual(root.options.map(o => o.id), ['hands-on', 'talk']);
  assert.equal(root.recommendation.optionId, 'hands-on');
  assert.equal(root.reviewState, 'unreviewed');
  assert.equal(root.questions[0].answer, null, 'a suggested answer is never an answer');
});

test('"No recommendation yet" says what is missing', async () => {
  const { store, map, job } = await claimed();
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { ...choice, recommendation: { optionId: null, missing: 'How many neighbours can bring tools.' } });
  assert.equal(saved.nodes[0].recommendation.optionId, null);
  assert.match(saved.nodes[0].recommendation.missing, /bring tools/);
});

test('malformed comparisons are rejected without changing the map', async () => {
  const { store, map, job } = await claimed();
  const before = await readFile(store.file(map.id), 'utf8');
  const bad = [
    [{ ...choice, recommendation: { ...choice.recommendation, optionId: 'nope' } }, /recommendation names an option/],
    [{ ...choice, options: [option('a', 'Same'), option('a', 'Other')] }, /unique/],
    [{ ...choice, options: [option('a', 'Same'), option('b', ' same ')] }, /titles must differ/],
    [{ ...choice, options: [option('a', 'Only')], recommendation: { optionId: 'a', rationale: 'x', mainTradeoff: 'y' } }, /optionsLimit/],
    [{ ...choice, optionsLimit: 'Only one fits.' }, /only with a single option/],
    [{ ...base, recommendation: { optionId: null, missing: 'x' } }, /needs options/],
    [{ ...choice, recommendation: undefined }, /recommendation is required/],
    [{ ...choice, recommendation: { optionId: 'hands-on', rationale: 'x' } }, /main trade-off/],
    [{ ...choice, recommendation: { optionId: null } }, /what is missing/],
    [{ ...choice, options: [option('a', 'x'.repeat(151)), option('b', 'B')] }, /150/],
    [{ ...choice, options: [option('a', 'A', { pros: ['1', '2', '3', '4', '5'] }), option('b', 'B')] }, /at most 4/],
    [{ ...choice, options: [option('1a', 'A'), option('b', 'B')] }, /identifier/],
    [{ ...choice, options: Array.from({ length: 5 }, (_, i) => option(`o${i}`, `O${i}`)) }, /1–4 options/],
  ];
  for (const [result, message] of bad) await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, result), error => error.status === 400 && message.test(error.message), String(message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('one honest option needs a reason there is no real alternative', async () => {
  const { store, map, job } = await claimed();
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { ...base, options: [option('only', 'Hands-on')], optionsLimit: 'The hall only suits hands-on work.', recommendation: { optionId: 'only', rationale: 'It is the only one.', mainTradeoff: 'No choice.' } });
  assert.equal(saved.nodes[0].optionsLimit, 'The hall only suits hands-on work.');
});

test('results without options behave exactly as before', async () => {
  const { store, map, job } = await claimed();
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { ...base, unknownField: 'ignored' });
  assert.equal('options' in saved.nodes[0], false); assert.equal('recommendation' in saved.nodes[0], false);
  assert.equal(mapBrief(saved).sections.find(s => s.id === 'recommendations').total, 0);
});

test('a stale result keeps its options in history only, and revising clears them', async () => {
  const { store, map, job } = await claimed();
  await store.complete(map.id, job.jobId, job.claimKey, choice);
  let current = await store.get(map.id);
  current = await store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, type: 'answer', questionId: current.nodes[0].questions[0].id, answer: 'Hands-on.' });
  const second = await store.claim('test');
  current = await store.get(map.id);
  current = await store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, type: 'revise', body: 'A different premise.' });
  assert.equal('options' in current.nodes[0], false, 'revise clears options with sources');
  const stale = await store.complete(map.id, second.jobId, second.claimKey, { ...choice, options: [option('x', 'X'), option('y', 'Y')], recommendation: { optionId: 'x', rationale: 'r', mainTradeoff: 't' } });
  assert.equal(stale.jobs.at(-1).stale, true);
  assert.equal('options' in stale.nodes[0], false);
  assert.deepEqual(stale.jobs.at(-1).result.options.map(o => o.id), ['x', 'y']);
});

test('packets, node Markdown, section reads and the brief carry the comparison', async () => {
  const { store, map, job } = await claimed();
  await store.complete(map.id, job.jobId, job.claimKey, { ...choice, questions: [] });
  const saved = await store.get(map.id);
  await store.action(map.id, { expectedRevision: saved.revision, nodeId: map.rootId, type: 'suggest', title: 'Next', body: 'Later.' });
  const doc = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(doc, /## Options/); assert.match(doc, /Hands-on/); assert.match(doc, /## Recommendation/); assert.match(doc, /not a decision/i);
  const read = contextExcerpt(saved, map.rootId, { section: 'options' });
  assert.match(read.excerpt, /hands-on/); assert.match(read.excerpt, /Main trade-off: Needs tools for everyone/);
  const brief = mapBrief(saved);
  const section = brief.sections.find(s => s.id === 'recommendations');
  assert.equal(section.label, 'Agent recommendations — not decisions');
  assert.match(section.items[0].text, /Hands-on/);
  assert.match(brief.markdown, /Agent recommendations — not decisions/);
  const fresh = await claimed();
  await fresh.store.complete(fresh.map.id, fresh.job.jobId, fresh.job.claimKey, choice);
  const m = await fresh.store.get(fresh.map.id);
  await fresh.store.action(fresh.map.id, { expectedRevision: m.revision, nodeId: fresh.map.rootId, type: 'answer', questionId: m.nodes[0].questions[0].id, answer: 'Hands-on.' });
  const packet = await fresh.store.claim('test');
  assert.deepEqual(packet.selected.options, [{ id: 'hands-on', title: 'Hands-on' }, { id: 'talk', title: 'Discussion group' }]);
  assert.equal(packet.selected.recommendation, 'hands-on');
});
