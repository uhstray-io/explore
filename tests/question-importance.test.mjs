import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { importanceLabel, highestImportance } from '../skills/explore/assets/questions.js';
import { importanceHtml } from '../skills/explore/assets/workspace-view.js';

// Importance and "Why this question?" (B2, #4). Illustrative fixtures under .test-output, never ideas/.
async function fixture() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'importance-'));
  const store = new Store(path.join(dir, 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Shared notes must work offline.' });
  const job = await store.claim('agent', map.id);
  const deliver = questions => store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on editing.', body: 'Fixture.', questions });
  return { store, map, deliver };
}
const ranked = [
  'Which devices must it run on?',
  { text: 'Can two people edit one note?', importance: 'low', why: 'Only changes how conflicts are shown.' },
  { text: 'Must it work with no signal for days?', importance: 'high', why: 'If so, sync must queue every change; if not, a short cache is enough.' },
  { text: 'Who reads the notes later?', why: 'Decides whether exports matter.' },
  { text: 'Do notes need photos?', importance: 'medium', why: 'Photos change the storage plan.' },
];

test('a question can say how much its answer matters and why; strings stay unranked', async () => {
  const { store, map, deliver } = await fixture();
  const saved = await deliver(ranked);
  const questions = saved.nodes[0].questions;
  assert.deepEqual(questions.map(q => q.importance ?? null), [null, 'low', 'high', null, 'medium']);
  assert.equal(questions[2].why, 'If so, sync must queue every change; if not, a short cache is enough.');
  assert.equal(questions[3].why, 'Decides whether exports matter.');
  assert.equal('why' in questions[0], false);
  const markdown = await readFile(path.join(store.directory, map.id, 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /_Importance: High — If so, sync must queue every change/);
});

test('importance without a reason, an unknown level or an overlong reason is refused and changes nothing', async () => {
  const { store, map, deliver } = await fixture();
  const before = await readFile(store.file(map.id), 'utf8');
  for (const [question, message] of [
    [{ text: 'Offline for days?', importance: 'high' }, /importance needs a reason/i],
    [{ text: 'Offline for days?', importance: 'urgent', why: 'Sync.' }, /low, medium or high/i],
    [{ text: 'Offline for days?', importance: 'high', why: 'x'.repeat(601) }, /600/],
  ]) await assert.rejects(deliver([question]), error => error.status === 400 && message.test(error.message), String(message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before);
});

test('a changed premise keeps the importance recorded with the question', async () => {
  const { store, map, deliver } = await fixture();
  let saved = await deliver(ranked);
  saved = await store.action(map.id, { type: 'revise', nodeId: map.rootId, body: 'Notes for one person only.', expectedRevision: saved.revision });
  const high = saved.nodes[0].questions[2];
  assert.ok(high.supersededAt); assert.equal(high.importance, 'high'); assert.match(high.why, /queue every change/);
});

test('the brief lists waiting questions by importance, keeping map order within a level', async () => {
  const { deliver } = await fixture();
  const saved = await deliver(ranked);
  const section = mapBrief(saved).sections.find(s => s.id === 'questions');
  assert.deepEqual(section.items.map(item => item.importance), ['high', 'medium', 'low', null, null]);
  assert.deepEqual(section.items.slice(3).map(item => item.text), ['Which devices must it run on?', 'Who reads the notes later?']);
  assert.match(mapBrief(saved).markdown, /High importance/);
});

test('reading a node\'s questions shows importance and why', async () => {
  const { deliver, map } = await fixture();
  const saved = await deliver(ranked);
  const page = contextExcerpt(saved, map.rootId, { section: 'questions' });
  const text = JSON.stringify(page);
  assert.match(text, /Importance: High/); assert.match(text, /Why: If so, sync must queue every change/);
  assert.match(text, /Importance: Unranked/);
});

test('labels and the overview use the highest open importance', () => {
  assert.equal(importanceLabel({ importance: 'high' }), 'High importance');
  assert.equal(importanceLabel({ text: 'x' }), null);
  assert.equal(highestImportance([{ importance: 'low', answer: null }, { importance: 'medium', answer: null }, { importance: 'high', answer: 'Done.' }]), 'medium');
  assert.equal(highestImportance([{ answer: null }]), null);
});

test('the question box shows the label and a Why? link; answered questions show a quieter label', () => {
  const esc = value => String(value).replace(/</g, '&lt;');
  const open = importanceHtml({ id: 'q-1', importance: 'high', why: 'Sync <must> queue.' }, { esc });
  assert.match(open, /High importance/);
  assert.match(open, /<button type="button" class="text-button" data-why-toggle aria-expanded="false" aria-controls="why-q-1">Why\?<\/button>/);
  assert.match(open, /<p class="question-why" id="why-q-1" hidden>Sync &lt;must> queue\.<\/p>/);
  assert.doesNotMatch(importanceHtml({ id: 'q-2', importance: 'low' }, { esc }), /Why\?/, 'no Why? link without a reason');
  assert.match(importanceHtml({ id: 'q-3', why: 'Only a reason.' }, { esc }), /Why\?/, 'a reason alone still has its link');
  assert.equal(importanceHtml({ id: 'q-4' }, { esc }), '');
  assert.match(importanceHtml({ id: 'q-5', importance: 'medium', why: 'x' }, { esc, quiet: true }), /^<small class="certainty-label importance-quiet">Medium importance<\/small>$/);
});

test('a regenerated question can carry importance too', async () => {
  const { defaultRegistry } = await import('../skills/explore/scripts/job-types.mjs');
  const validate = defaultRegistry.jobTypes['regenerate-question'].validate;
  assert.deepEqual(validate({ question: { text: 'Offline for days?', importance: 'high', why: 'Sync design.' } }), { question: { text: 'Offline for days?', importance: 'high', why: 'Sync design.' } });
  assert.throws(() => validate({ question: { text: 'Offline for days?', importance: 'high' } }), /importance needs a reason/i);
});
