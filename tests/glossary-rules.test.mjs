import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { restoreSummary } from '../skills/explore/assets/workspace-view.js';
import { glossaryHtml } from '../skills/explore/assets/glossary-dialog.js';

// Map glossary (K9, #55): undo, packet room, the replacement rule, validation and the brief's bound.
// Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'glossary-rules-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline for a survey crew.' });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  return { store, map, act };
}
const terms = map => (map.glossary || []).map(({ term, definition, status }) => ({ term, definition, status }));
const entry = (id, term, fields = {}) => ({ id, term, definition: 'A meaning.', status: 'agreed', origin: 'user', createdAt: 'x', updatedAt: 'x', ...fields });

test('Undo and restore include the glossary, and the preview says so', async () => {
  const { store, map, act } = await workspace();
  await store.claim('agent', map.id).then(job => store.fail(map.id, job.jobId, job.claimKey, 'Stopped for the test.'));
  let saved = await act({ type: 'revise', nodeId: map.rootId, body: 'Notes for a survey crew of nine.' });
  saved = await act({ type: 'glossary-add', term: 'Crew', definition: 'The nine surveyors.' });
  const latest = (await store.versions.list(map.id)).versions;
  saved = await act({ type: 'restore-version', version: latest[1].id, undo: true });
  assert.deepEqual(saved.glossary, [], 'Undo takes the term back out');
  assert.equal(saved.nodes[0].prompt, 'Notes for a survey crew of nine.', 'and leaves the earlier revise alone');
  saved = await act({ type: 'glossary-add', term: 'Depot', definition: 'A building.' });
  saved = await act({ type: 'restore-version', version: latest[1].id });
  assert.deepEqual(saved.glossary, [], 'restoring a version from before a term removes it');
  assert.match(restoreSummary({ counts: { nodesAdded: 0, nodesRemoved: 0, nodesChanged: 0, linksAdded: 0, linksRemoved: 0, termsChanged: 1 }, reopened: [] }), /^Restoring changes the glossary\./);
});

test('the glossary never crowds out the selected idea: unused terms go before its findings', async () => {
  const { store, map, act } = await workspace();
  const first = await store.claim('agent', map.id); await store.fail(map.id, first.jobId, first.claimKey, 'Stopped for the test.');
  const saved = await store.get(map.id), node = saved.nodes[0];
  node.prompt = 'p'.repeat(2400); node.body = 'b'.repeat(4000); node.summary = 'Short.';
  node.questions = Array.from({ length: 8 }, (_, i) => ({ id: `q-${i}`, text: 'q'.repeat(150), answer: 'a'.repeat(400) }));
  saved.glossary = Array.from({ length: 10 }, (_, i) => entry(`term-${i}`, `Unrelated${i}`, { definition: 'd'.repeat(590) }));
  await store.save(saved);
  await act({ type: 'activate', nodeId: map.rootId });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.selected.body.length, 4000, 'the findings are kept whole');
  assert.equal(packet.selected.questions.length, 8, 'and every answered question');
  assert.ok(packet.omittedGlossaryTerms > 5, 'unused terms were dropped instead');
  assert.ok(packet.contextCharacters <= 15500);
});

test('a proposal changes the agreed term with the same name, and removing a term keeps proposals', async () => {
  const { store, map, act } = await workspace();
  const job = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', glossary: [{ term: 'Depot', definition: 'Agent meaning.' }, { term: 'sync', definition: 'Copy both ways.' }] });
  saved = await act({ type: 'glossary-add', term: 'depot', definition: 'My meaning.' });
  saved = await act({ type: 'glossary-add', term: 'Sync', definition: 'Upload only.' });
  assert.match(glossaryHtml(saved, { esc: String }), /Depot <small>would replace the agreed definition/, 'the dialog shows what Accept will change');
  const sync = saved.glossary.find(item => item.status === 'agreed' && item.term === 'Sync');
  saved = await act({ type: 'glossary-edit', termId: sync.id, term: 'Upload' });
  saved = await act({ type: 'glossary-accept', termId: saved.glossary.find(item => item.term === 'sync').id });
  assert.deepEqual(terms(saved).filter(item => /sync|upload/i.test(item.term)), [{ term: 'Upload', definition: 'Upload only.', status: 'agreed' }, { term: 'sync', definition: 'Copy both ways.', status: 'agreed' }], 'a renamed term is not changed by a proposal for its old name');
  saved = await act({ type: 'glossary-remove', termId: saved.glossary.find(item => item.term === 'depot').id });
  assert.ok(saved.glossary.some(item => item.status === 'proposed' && item.term === 'Depot'), 'the user still decides about the proposal');
});

test('a malformed glossary makes the map unreadable rather than breaking every save', async () => {
  const { store, map } = await workspace();
  const base = JSON.parse(await readFile(store.file(map.id), 'utf8'));
  for (const glossary of [[null], [entry('term-1', 7)], 'terms']) {
    const { errors } = validateMap({ ...base, glossary }, { folderId: map.id });
    assert.ok(errors.some(error => error.unreadable && /^glossary/.test(error.at)), JSON.stringify(glossary));
  }
  assert.deepEqual(validateMap({ ...base, glossary: [entry('term-1', 'Crew')] }, { folderId: map.id }).errors, []);
});

test('a term counts as used only as a whole word, and typed work gets the glossary', async () => {
  const { store, map, act } = await workspace();
  let saved = await store.get(map.id);
  saved.nodes[0].prompt = 'An important question about the depot.'; await store.save(saved);
  for (const [term, definition] of [['Ant', 'An insect.'], ['Zone', 'An area.'], ['Depot', 'A building.']]) await act({ type: 'glossary-add', term, definition });
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.glossary.map(item => item.term), ['Depot', 'Ant', 'Zone'], '"important" does not use "Ant"');
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'S.', body: 'B.', questions: ['Which phones?'] });
  await act({ type: 'request-research', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id });
  const research = await store.claim('agent', map.id);
  assert.equal(research.jobType, 'question-research'); assert.equal(research.glossary.length, 3); assert.match(research.instruction, /Use the glossary's terms as defined\./);
});

test('Tidy declares that it keeps the glossary out', async () => {
  const { questionJobTypes } = await import('../skills/explore/scripts/question-actions.mjs');
  const { TIDY } = await import('../skills/explore/assets/questions.js');
  assert.equal(questionJobTypes[TIDY].glossary, false);
});

test('the brief bounds the glossary with the rest and says where every term is', async () => {
  const { store, map } = await workspace();
  const saved = await store.get(map.id);
  saved.glossary = Array.from({ length: 100 }, (_, i) => entry(`term-${i}`, `Term${i}`, { definition: 'd'.repeat(600), status: i < 80 ? 'agreed' : 'proposed' }));
  await store.save(saved);
  const brief = mapBrief(await store.get(map.id));
  assert.ok(JSON.stringify(brief, null, 2).length <= 24000);
  assert.match(brief.markdown, /more terms omitted\. README\.md's Glossary section lists every agreed term\./);
  assert.match(brief.markdown, /more terms omitted\. map\.json holds every proposal\./);
});
