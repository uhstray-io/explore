import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { limitationsHtml, optionLimitationNotes, directionFrom, limitationClick } from '../skills/explore/assets/limitations.js';
import { optionsHtml } from '../skills/explore/assets/workspace-view.js';

// Conflicts and evidence gaps (C3, #12). Illustrative maps under .test-output, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const A = 'https://example.org/a', B = 'https://example.org/b';
const sources = [{ title: 'Vendor pricing', url: A, note: 'Lists 40 per user.' }, { title: 'Analyst survey', url: B, note: 'Reports 55 per user.' }];
const conflict = { id: 'price', kind: 'conflict', summary: 'The vendor and the survey disagree on the price per user.', nextStep: 'Ask the vendor for a written quote.', sources: [A, B] };
const gap = { id: 'offline', kind: 'missing-evidence', summary: 'No source says whether sync survives a week offline.', nextStep: 'Run a one-week offline trial with two phones.' };
const options = [
  { id: 'buy', title: 'Buy an app', description: 'Use an existing app.', fit: 'When the forms are standard.' },
  { id: 'build', title: 'Build one', description: 'Write a custom app.', fit: 'When the workflow is unusual.' },
];
async function explored() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'limits-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  const markdown = () => readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  return { store, map, job, markdown, deliver: result => store.complete(map.id, job.jobId, job.claimKey, { summary: 'Buying looks cheaper.', body: 'Findings.', sources, ...result }) };
}

test('a result records conflicts and evidence gaps on the idea, in Markdown, the brief and a section read', async () => {
  const { map, deliver, markdown } = await explored();
  const saved = await deliver({ limitations: [conflict, gap] });
  const node = saved.nodes.find(n => n.id === map.rootId);
  assert.deepEqual(node.limitations, [conflict, gap]);
  const text = await markdown();
  assert.match(text, /## Conflicts and evidence gaps/); assert.match(text, /Sources disagree/); assert.match(text, /Evidence not found/);
  assert.match(text, /Affects: Whole branch/); assert.match(text, /Next step: Ask the vendor for a written quote\./);
  const brief = mapBrief(saved), section = brief.sections.find(s => s.id === 'limitations');
  assert.equal(section.label, 'Conflicts and evidence gaps — unresolved'); assert.equal(section.total, 2);
  assert.match(section.items[0].text, /^Sources disagree: The vendor and the survey disagree.*Next step: Ask the vendor/);
  assert.ok(JSON.stringify(brief, null, 2).length <= 24000);
  const read = contextExcerpt(saved, map.rootId, { section: 'limitations' });
  assert.equal(read.totalRecords, 2); assert.match(read.excerpt, /Run a one-week offline trial/);
});

test('a record that breaks the rules rejects the whole result and changes nothing', async () => {
  const { store, map, deliver } = await explored();
  const before = await readFile(store.file(map.id), 'utf8');
  const broken = [
    [{ ...conflict, sources: [A] }, /at least two/],
    [{ ...gap, sources: ['https://example.org/elsewhere'] }, /not in this result's sources/],
    [{ ...gap, kind: 'assumption' }, /conflict or missing-evidence/],
    [{ ...gap, id: '9lives' }, /identifier/],
    [{ ...gap, nextStep: undefined }, /Next step/],
    [{ ...gap, summary: 's'.repeat(601) }, /600/],
    [{ ...gap, optionIds: ['buy'] }, /option that is not in this result/],
    [{ ...gap, blocksRecommendation: true }, /optionId null/],
    [{ ...conflict, sources: [A, A] }, /twice/],
  ];
  for (const [record, message] of broken) await assert.rejects(deliver({ limitations: [record] }), error => error.status === 400 && message.test(error.message), message.source);
  await assert.rejects(deliver({ limitations: [gap, gap] }), /unique/);
  await assert.rejects(deliver({ limitations: Array.from({ length: 9 }, (_, i) => ({ ...gap, id: `g${i}` })) }), /at most 8/);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
});

test('with options, a record names the options it affects and blocks a recommendation only when there is none', async () => {
  const { deliver, markdown, map } = await explored();
  const blocked = { recommendation: { optionId: null, missing: 'A written quote.' }, options };
  await assert.rejects(deliver({ ...blocked, limitations: [{ ...gap, optionIds: ['rent'] }] }), /option that is not in this result/);
  await assert.rejects(deliver({ options, recommendation: { optionId: 'buy', rationale: 'Cheaper.', mainTradeoff: 'Less control.' }, limitations: [{ ...gap, blocksRecommendation: true }] }), /optionId null/);
  const saved = await deliver({ ...blocked, limitations: [{ ...conflict, optionIds: ['buy'], blocksRecommendation: true }] });
  const text = await markdown();
  assert.match(text, /Affects: Buy an app/); assert.match(text, /Blocks a recommendation/);
  // The affected option card points to the record.
  const node = saved.nodes.find(n => n.id === map.rootId);
  assert.match(optionsHtml(node, esc, option => optionLimitationNotes(node, option, esc)), /data-limitation-show="price"[^>]*>Sources disagree</);
  assert.equal(optionLimitationNotes(node, options[1], esc), '', 'an option no record names gets nothing');
});

test('a stale result keeps its records in job history only, and a revised premise clears them', async () => {
  const { store, map, job } = await explored();
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends.', body: 'Findings.', sources, limitations: [gap], questions: ['Which phones?'] });
  assert.equal(saved.nodes[0].limitations.length, 1);
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'Android.' });
  const next = await store.claim('agent', map.id);
  saved = await store.get(map.id);
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'revise', nodeId: map.rootId, body: 'Notes that work offline for a year.' });
  assert.equal(saved.nodes[0].limitations, undefined, 'revise clears them with the findings');
  saved = await store.complete(map.id, next.jobId, next.claimKey, { summary: 'Late.', body: 'Late findings.', sources, limitations: [conflict] });
  assert.equal(saved.nodes[0].limitations, undefined, 'a stale result does not touch the idea');
  assert.deepEqual(saved.jobs.find(entry => entry.id === next.jobId).result.limitations, [conflict]);
});

test('a continuing branch sees its records, keeps them when the agent resends them, and the brief keeps the next step', async () => {
  const { store, map, job } = await explored();
  const long = { ...gap, summary: 's'.repeat(600) };
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends.', body: 'Findings.', sources, limitations: [conflict, long], questions: ['Which phones?'] });
  const item = mapBrief(saved).sections.find(section => section.id === 'limitations').items[1];
  assert.match(item.text, /Next step: Run a one-week offline trial/, 'a long summary never hides the next step');
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'Android.' });
  const next = await store.claim('agent', map.id);
  assert.deepEqual(next.selected.limitations.map(record => record.id), ['price', 'offline']);
  assert.ok(next.selected.limitations[1].summary.length < 300, 'shortened in the packet'); assert.match(next.instruction, /read --section options\|limitations\|claims\|assumptions and resend in full those that still hold/); assert.match(next.retrieval, /limitations/);
  saved = await store.complete(map.id, next.jobId, next.claimKey, { summary: 'Android only.', body: 'Findings.', sources, limitations: [conflict] });
  assert.deepEqual(saved.nodes[0].limitations, [conflict], 'what the agent resent is kept; what it dropped is gone');
});

test('a section read keeps records as saved so they can be resent; node Markdown escapes them', async () => {
  const { map, deliver, markdown } = await explored();
  const marked = { ...gap, id: 'sync_offline', summary: 'Costs <$50 | maybe *more*.' };
  const saved = await deliver({ limitations: [marked] });
  const read = contextExcerpt(saved, map.rootId, { section: 'limitations' });
  assert.match(read.excerpt, /\(sync_offline\): Costs <\$50 \| maybe \*more\*\./); assert.doesNotMatch(read.excerpt, /\\/);
  assert.match(await markdown(), /sync\\_offline/);
});

test('a kind from elsewhere shows as itself, never as undefined', async () => {
  const node = { id: 'n', options: [], sources: [], limitations: [{ id: 'x', kind: 'assumption', summary: 'A newer kind.', nextStep: 'Check it.' }] };
  assert.match(limitationsHtml(node, { esc, live: false, map: { nodes: [node] } }), />assumption</);
  const brief = mapBrief({ id: 'm', title: 'M', revision: 1, rootId: 'n', nodes: [{ ...node, title: 'N', status: 'explored', reviewState: 'unreviewed', questions: [], prompt: 'P', summary: 'S' }], edges: [], jobs: [] });
  assert.doesNotMatch(brief.markdown, /undefined/); assert.match(brief.markdown, /assumption: A newer kind/);
});

test('results and maps without records show nothing, and never claim none were found', async () => {
  const { map, deliver, markdown } = await explored();
  const saved = await deliver({});
  const node = saved.nodes.find(n => n.id === map.rootId);
  assert.equal(Object.hasOwn(node, 'limitations'), false);
  assert.doesNotMatch(await markdown(), /Conflicts and evidence gaps/);
  assert.equal(limitationsHtml(node, { esc, live: true, map: saved }), '');
  const brief = mapBrief(saved);
  assert.doesNotMatch(brief.markdown, /none found/i); assert.match(brief.markdown, /## Conflicts and evidence gaps — unresolved\n\n_None recorded\. Results saved before this feature could not record them\._/);
  assert.equal(contextExcerpt(saved, map.rootId, { section: 'limitations' }).totalRecords, 0);
});

test('the inspector shows each record and turns its next step into an inactive direction', async () => {
  const { store, map, deliver } = await explored();
  let saved = await deliver({ options, recommendation: { optionId: null, missing: 'A quote.' }, limitations: [{ ...conflict, optionIds: ['buy'], blocksRecommendation: true }, gap] });
  const node = () => saved.nodes.find(n => n.id === map.rootId);
  let html = limitationsHtml(node(), { esc, live: true, map: saved });
  assert.match(html, /Conflicts and evidence gaps/); assert.match(html, /Sources disagree/); assert.match(html, /Evidence not found/);
  assert.match(html, /Affects:<\/span> Buy an app/); assert.match(html, /Affects:<\/span> Whole branch/); assert.match(html, /Blocks a recommendation/);
  assert.match(html, /<p class="limitation-sources"><a href="https:\/\/example\.org\/a"[^>]*>Vendor pricing<\/a>/);
  assert.match(html, /id="limitation-[^"]+-price"/);
  assert.equal((html.match(/data-limitation-direction=/g) || []).length, 2);
  assert.doesNotMatch(limitationsHtml(node(), { esc, live: false, map: saved }), /data-limitation-direction/, 'history shows records without actions');
  // Add as a direction: the existing suggest action, with the summary as title and the next step as body.
  const direction = directionFrom({ ...gap, summary: 'x'.repeat(150) });
  assert.equal(direction.title.length, 100); assert.ok(direction.title.endsWith('…')); assert.equal(direction.body, gap.nextStep);
  const jobs = saved.jobs.length;
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'suggest', nodeId: map.rootId, ...directionFrom(gap) });
  const child = saved.nodes.at(-1);
  assert.equal(child.parentId, map.rootId); assert.equal(child.status, 'suggested'); assert.equal(saved.jobs.length, jobs, 'nothing is queued');
  html = limitationsHtml(node(), { esc, live: true, map: saved });
  assert.equal((html.match(/data-limitation-direction=/g) || []).length, 1, 'a record already added says so');
  assert.match(html, /Added as a direction/);
});

test('clicking Add as a direction sends the suggest action for that record', async () => {
  const sent = [], toasts = [];
  const node = { id: 'node-a', title: 'Idea', limitations: [gap], options: [] };
  const state = { map: { nodes: [node] }, visibleMap: { nodes: [node] } };
  const target = { dataset: { limitationDirection: 'offline', nodeId: 'node-a' }, disabled: false };
  const event = { target: { closest: selector => (selector === '[data-limitation-direction]' ? target : null) } };
  assert.equal(await limitationClick(event, { state, act: async (...args) => { sent.push(args); return true; }, toast: message => toasts.push(message) }), true);
  assert.deepEqual(sent, [['node-a', 'suggest', directionFrom(gap)]]);
  assert.match(toasts[0], /inactive/);
  assert.equal(await limitationClick({ target: { closest: () => null } }, { state, act: async () => true, toast() {} }), false);
});
