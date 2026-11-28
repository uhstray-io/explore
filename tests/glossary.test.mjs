import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';

// Map glossary (K9, #55). Illustrative maps under .test-output, never ideas/.
async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'glossary-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline for a survey crew.' });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  return { store, map, act };
}
const terms = map => (map.glossary || []).map(({ term, definition, status }) => ({ term, definition, status }));

test('a term the user adds reaches the next branch packet with its exact definition, and changes no idea', async () => {
  const { store, map, act } = await workspace();
  const before = (await store.get(map.id)).nodes.map(n => [n.contentRevision, !!n.stale]);
  let saved = await act({ type: 'glossary-add', term: 'Crew', definition: 'The nine surveyors who share one depot.' });
  assert.deepEqual(terms(saved), [{ term: 'Crew', definition: 'The nine surveyors who share one depot.', status: 'agreed' }]);
  assert.deepEqual(saved.nodes.map(n => [n.contentRevision, !!n.stale]), before, 'no idea is touched or flagged');
  await assert.rejects(act({ type: 'glossary-add', term: 'crew', definition: 'Another meaning.' }), error => error.status === 409, 'unique ignoring case');
  await assert.rejects(act({ type: 'glossary-add', term: 't'.repeat(81), definition: 'x' }), error => error.status === 400);
  await assert.rejects(act({ type: 'glossary-add', term: 'Sync', definition: 'd'.repeat(601) }), error => error.status === 400);
  const id = saved.glossary[0].id;
  saved = await act({ type: 'glossary-edit', termId: id, definition: 'The surveyors who share one depot.' });
  assert.equal(saved.glossary[0].definition, 'The surveyors who share one depot.');
  assert.ok(saved.history.some(event => event.type === 'glossary-edited'), 'each change is logged');
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.glossary, [{ term: 'Crew', definition: 'The surveyors who share one depot.' }]);
  assert.equal(packet.omittedGlossaryTerms, 0);
  assert.match(packet.instruction, /Use the glossary's terms as defined\. If you need a new term or a different meaning, propose it in `glossary`\./);
  saved = await act({ type: 'glossary-remove', termId: id });
  assert.deepEqual(saved.glossary, []);
});

test('the agent proposes; proposals stay out of packets until the user accepts, and a replacement keeps one entry', async () => {
  const { store, map, act } = await workspace();
  let saved = await act({ type: 'glossary-add', term: 'Sync', definition: 'Copying notes to the server.' });
  const sync = saved.glossary[0].id;
  let job = await store.claim('agent', map.id);
  const before = await readFile(store.file(map.id), 'utf8');
  for (const glossary of [Array.from({ length: 6 }, (_, i) => ({ term: `T${i}`, definition: 'd' })), [{ term: 't'.repeat(81), definition: 'd' }], [{ term: 'Ok', definition: 'd'.repeat(601) }], [{ term: 'Ok' }], 'Sync']) {
    await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', glossary }), error => error.status === 400, JSON.stringify(glossary).slice(0, 40));
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', questions: ['Which phones?'], glossary: [
    { term: 'Depot', definition: 'The building the crew works from.' },
    { term: 'sync', definition: 'Copying notes both ways, phone and server.' },
    { term: 'Sync', definition: 'Copying notes to the server.' }, // Identical to the agreed entry: dropped.
  ] });
  assert.deepEqual(terms(saved), [
    { term: 'Sync', definition: 'Copying notes to the server.', status: 'agreed' },
    { term: 'Depot', definition: 'The building the crew works from.', status: 'proposed' },
    { term: 'sync', definition: 'Copying notes both ways, phone and server.', status: 'proposed' },
  ]);
  const depot = saved.glossary[1], replacement = saved.glossary[2];
  assert.equal(depot.origin, 'agent'); assert.equal(depot.jobId, job.jobId); assert.equal(replacement.replaces, sync);
  // Proposed terms never reach a packet.
  saved = await act({ type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'Android.' });
  job = await store.claim('agent', map.id);
  assert.deepEqual(job.glossary, [{ term: 'Sync', definition: 'Copying notes to the server.' }]);
  // Accepting the replacement updates the agreed term and keeps one entry; edit-and-accept uses the user's words.
  saved = await act({ type: 'glossary-accept', termId: replacement.id });
  assert.deepEqual(terms(saved).filter(entry => /sync/i.test(entry.term)), [{ term: 'Sync', definition: 'Copying notes both ways, phone and server.', status: 'agreed' }]);
  saved = await act({ type: 'glossary-accept', termId: depot.id, definition: 'The shared building in town.' });
  assert.deepEqual(terms(saved).find(entry => entry.term === 'Depot'), { term: 'Depot', definition: 'The shared building in town.', status: 'agreed' });
  // A stale result adds no proposals; dismissing removes one.
  saved = await store.get(map.id);
  saved = await act({ type: 'revise', nodeId: map.rootId, body: 'Notes for a different crew.' });
  saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'B.', glossary: [{ term: 'Late', definition: 'From a stale run.' }] });
  assert.ok(!saved.glossary.some(entry => entry.term === 'Late'));
});

test('dismissing a proposal removes it', async () => {
  const { store, map, act } = await workspace();
  const job = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', glossary: [{ term: 'Depot', definition: 'A building.' }] });
  saved = await act({ type: 'glossary-dismiss', termId: saved.glossary[0].id });
  assert.deepEqual(saved.glossary, []);
  await assert.rejects(act({ type: 'glossary-accept', termId: 'term-missing' }), error => error.status === 404);
});

test('a large glossary stays within the packet: terms the idea uses first, then alphabetical, with omissions counted', async () => {
  const { store, map } = await workspace();
  const saved = await store.get(map.id);
  saved.glossary = Array.from({ length: 30 }, (_, i) => ({ id: `term-${i}`, term: `Word${String(i).padStart(2, '0')}`, definition: 'd'.repeat(300), status: 'agreed', origin: 'user', createdAt: 'x', updatedAt: 'x' }));
  saved.glossary.push({ id: 'term-used', term: 'Surveyor', definition: 'A crew member.', status: 'agreed', origin: 'user', createdAt: 'x', updatedAt: 'x' }, { id: 'term-prop', term: 'Offline', definition: 'Proposed only.', status: 'proposed', origin: 'agent', createdAt: 'x', updatedAt: 'x' });
  saved.nodes[0].prompt = 'Notes that work offline for every surveyor.';
  await store.save(saved);
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.glossary[0].term, 'Surveyor', 'a term the idea uses comes first');
  assert.deepEqual(packet.glossary.slice(1, 3).map(entry => entry.term), ['Word00', 'Word01']);
  assert.ok(JSON.stringify(packet.glossary).length <= 3000);
  assert.equal(packet.glossary.length + packet.omittedGlossaryTerms, 31, 'every agreed term is sent or counted');
  assert.ok(!packet.glossary.some(entry => entry.term === 'Offline'));
  assert.ok(packet.contextCharacters <= 15500);
});

test('older maps without a glossary load and send an empty one; README and brief show agreed and proposed apart', async () => {
  const { store, map, act } = await workspace();
  const packet = await store.claim('agent', map.id);
  assert.deepEqual(packet.glossary, []); assert.equal(packet.omittedGlossaryTerms, 0);
  let saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'S.', body: 'B.', glossary: [{ term: 'Depot', definition: 'A building.' }] });
  saved = await act({ type: 'glossary-add', term: 'Crew', definition: 'The *nine* surveyors.' });
  const readme = await readFile(path.join(path.dirname(store.file(map.id)), 'README.md'), 'utf8');
  assert.match(readme, /## Glossary\n\n- \*\*Crew\*\*: The \\\*nine\\\* surveyors\./); assert.doesNotMatch(readme, /Depot/, 'proposals are not agreed');
  const brief = mapBrief(saved);
  assert.deepEqual(brief.glossary.agreed.items, [{ term: 'Crew', definition: 'The *nine* surveyors.' }]);
  assert.deepEqual(brief.glossary.proposed.items, [{ term: 'Depot', definition: 'A building.' }]);
  assert.match(brief.markdown, /## Agreed glossary\n\n- \*\*Crew\*\*: The \\\*nine\\\* surveyors\./);
  assert.match(brief.markdown, /## Proposed terms — not agreed\n\n- \*\*Depot\*\*: A building\./);
  assert.ok(JSON.stringify(brief, null, 2).length <= 24000);
});

test('the dialog lists agreed terms and proposals apart, shows a replacement beside the current meaning, and escapes text', async () => {
  const { glossaryHtml, glossarySummary } = await import('../skills/explore/assets/glossary-dialog.js');
  const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const map = { glossary: [
    { id: 'term-1', term: 'Sync', definition: 'Copying <notes> to the server.', status: 'agreed' },
    { id: 'term-2', term: 'sync', definition: 'Copying notes both ways.', status: 'proposed', replaces: 'term-1' },
    { id: 'term-3', term: 'Depot', definition: 'A building.', status: 'proposed' },
  ] };
  const html = glossaryHtml(map, { esc });
  assert.match(html, /Agreed terms<\/h3><dl class="glossary-list"><div class="glossary-entry"><dt>Sync<\/dt><dd>Copying &lt;notes&gt; to the server\.<\/dd>/);
  assert.match(html, /data-glossary-edit="term-1"/); assert.match(html, /data-glossary-remove="term-1"/);
  assert.match(html, /Proposed by your agent — not agreed/);
  assert.match(html, /would replace the agreed definition[\s\S]*<small>Agreed now<\/small>Copying &lt;notes&gt; to the server\.[\s\S]*<small>Proposed<\/small>Copying notes both ways\./);
  for (const action of ['accept', 'edit-accept', 'dismiss']) assert.match(html, new RegExp(`data-glossary-${action}="term-3"`));
  assert.match(glossaryHtml(map, { esc, editing: 'term-1' }), /<input id="glossary-edit-term" maxlength="80" value="Sync">/);
  assert.match(glossaryHtml(map, { esc, editing: 'term-3' }), /<textarea id="glossary-accept-definition" maxlength="600" rows="3">A building\.<\/textarea>/);
  assert.equal(glossarySummary(map), '1 agreed term · 2 terms proposed by your agent. Every research job gets the agreed terms, so your agent keeps your words.');
  assert.match(glossaryHtml({}, { esc }), /No terms yet/); assert.match(glossarySummary({}), /^No agreed terms yet\./);
});
