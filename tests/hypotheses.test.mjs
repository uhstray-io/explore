import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { hypothesisHtml, directionKindHtml, outcomeMarkHtml, outcomeLabel } from '../skills/explore/assets/hypothesis.js';

// Hypothesis ideas (K13, #59). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

async function setup() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'hypotheses-')), 'ideas'));
  const map = await store.create({ title: 'Field notes', idea: 'Why do volunteers stop logging?' });
  const job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Several causes.', body: 'Details.' });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, ...input });
  // Activate an idea, claim its work and deliver `result` (questions keep it open, none finish it).
  const run = async (nodeId, result) => {
    let saved = await store.get(map.id);
    if (saved.nodes.find(node => node.id === nodeId).status === 'suggested') await act({ type: 'activate', nodeId });
    const packet = await store.claim('agent', map.id);
    assert.equal(packet.selected.id, nodeId);
    return { packet, saved: await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Found.', body: 'Evidence for and against.', ...result }) };
  };
  return { store, map, act, run };
}
const nodeOf = (map, id) => map.nodes.find(node => node.id === id);

test('the user can add a hypothesis with an optional test; it stays suggested until activated, and other kinds are refused', async () => {
  const { map, act } = await setup();
  let saved = await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'Volunteers stop because logging takes over a minute.', kind: 'hypothesis', test: '  Time ten volunteers logging one observation.  ' });
  const added = saved.nodes.at(-1);
  assert.equal(added.kind, 'hypothesis'); assert.equal(added.status, 'suggested');
  assert.deepEqual(added.hypothesis, { test: 'Time ten volunteers logging one observation.', outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] });
  saved = await act({ type: 'suggest', nodeId: map.rootId, title: 'Plain direction', body: 'Look around.' });
  assert.equal(saved.nodes.at(-1).kind, 'research'); assert.equal(Object.hasOwn(saved.nodes.at(-1), 'hypothesis'), false);
  await assert.rejects(act({ type: 'suggest', nodeId: map.rootId, title: 'Risky', body: 'x', kind: 'risk' }), /direction or a hypothesis/);
  await assert.rejects(act({ type: 'suggest', nodeId: map.rootId, title: 'Long test', body: 'x', kind: 'hypothesis', test: 'x'.repeat(2001) }), /at most 2000/);
});

test('an agent suggestion of kind hypothesis creates a hypothesis with its test, and the packet asks for the smallest refuting test', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Parent', body: 'Explore causes.' });
  const parent = (await store.get(map.id)).nodes.at(-1).id;
  const { saved } = await run(parent, { questions: ['Which group?'], suggestions: [{ title: 'Phones are full', body: 'Storage fills, so the app crashes.', kind: 'hypothesis', test: 'Check free storage on five phones.' }, { title: 'Odd kind', body: 'x', kind: 'nonsense' }] });
  const [hyp, odd] = saved.nodes.slice(-2);
  assert.equal(hyp.kind, 'hypothesis'); assert.equal(hyp.hypothesis.test, 'Check free storage on five phones.'); assert.equal(odd.kind, 'research');
  const { packet } = await run(hyp.id, { questions: ['Anything else?'] });
  assert.deepEqual(packet.selected.hypothesis, { test: 'Check free storage on five phones.', outcome: null, proposed: null });
  assert.match(packet.instruction, /smallest test that could refute it/); assert.match(packet.instruction, /never record an outcome/i);
});

test('a hypothesis result sets the test and a proposed outcome, never the outcome; on any other idea it is rejected unchanged', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'It takes over a minute.', kind: 'hypothesis' });
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Plain', body: 'Look around.' });
  const [hypId, plainId] = (await store.get(map.id)).nodes.slice(-2).map(node => node.id);
  await act({ type: 'activate', nodeId: plainId });
  const job = await store.claim('agent', map.id), before = await readFile(store.file(map.id), 'utf8');
  await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'S', body: 'B', hypothesis: { outcome: 'supported', rationale: 'x' } }), error => error.status === 400 && /Only a hypothesis/.test(error.message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S', body: 'B' });
  // A rejected result leaves the claim valid, so each bad one is tried on the same claim.
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Second claim', body: 'Claim.', kind: 'hypothesis' });
  const second = (await store.get(map.id)).nodes.at(-1).id;
  await act({ type: 'activate', nodeId: second });
  const claim = await store.claim('agent', map.id);
  assert.equal(claim.selected.id, second);
  for (const [bad, message] of [[{ outcome: 'proven', rationale: 'x' }, /supported, refuted, inconclusive or null/], [{ outcome: 'refuted' }, /rationale is required/], ['yes', /must be an object/]]) {
    await assert.rejects(store.complete(map.id, claim.jobId, claim.claimKey, { summary: 'S', body: 'B', hypothesis: bad }), message);
  }
  await store.complete(map.id, claim.jobId, claim.claimKey, { summary: 'S', body: 'B' });
  const { saved } = await run(hypId, { questions: ['Can you time five volunteers?'], hypothesis: { test: 'Time five volunteers.', outcome: 'refuted', rationale: 'Logs show 20 seconds on average.' } });
  const record = nodeOf(saved, hypId).hypothesis;
  assert.equal(record.test, 'Time five volunteers.'); assert.equal(record.outcome, null, 'the agent never records it');
  assert.deepEqual(record.proposed, { outcome: 'refuted', rationale: 'Logs show 20 seconds on average.', jobId: saved.jobs.at(-1).id });
  await act({ type: 'answer', nodeId: hypId, questionId: nodeOf(saved, hypId).questions[0].id, answer: 'Yes, next week.' }); // The branch continues.
  const later = await run(hypId, { hypothesis: { outcome: null } });
  assert.equal(nodeOf(later.saved, hypId).hypothesis.proposed, null, 'a test that needs the user proposes nothing'); assert.equal(nodeOf(later.saved, hypId).hypothesis.test, 'Time five volunteers.');
});

test('recording an outcome works on a finished hypothesis, changes no findings, keeps a history, and flags what rests on it unless a first one is supported', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'It takes over a minute.', kind: 'hypothesis' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  let { saved } = await run(hypId, { suggestions: [{ title: 'Shorter form', body: 'A two-field form.' }], hypothesis: { outcome: 'supported', rationale: 'Timings.' } });
  const child = saved.nodes.at(-1).id;
  await run(child, {}); // The child below it has findings.
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Training plan', body: 'Train volunteers.' });
  const dependent = (await store.get(map.id)).nodes.at(-1).id;
  await act({ type: 'link', nodeId: dependent, to: hypId, relation: 'depends_on' });
  await run(dependent, {});
  const finished = nodeOf(await store.get(map.id), hypId);
  assert.equal(finished.status, 'explored');
  saved = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'supported', note: '  Timed on site.  ' });
  let hyp = nodeOf(saved, hypId);
  assert.deepEqual([hyp.status, hyp.body, hyp.completedAt, hyp.contentRevision, hyp.reviewState], [finished.status, finished.body, finished.completedAt, finished.contentRevision, finished.reviewState], 'its findings and completion stay');
  assert.equal(hyp.hypothesis.outcome, 'supported'); assert.equal(hyp.hypothesis.outcomeNote, 'Timed on site.'); assert.ok(hyp.hypothesis.outcomeAt);
  assert.deepEqual([child, dependent].map(id => nodeOf(saved, id).stale), [false, false], 'a first supported flags nothing');
  assert.equal(saved.history.at(-1).type, 'outcome-recorded');
  saved = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'supported', note: 'Timed again.' });
  assert.deepEqual([child, dependent].map(id => nodeOf(saved, id).stale), [false, false], 'the same outcome again changes nothing that rests on it');
  saved = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'refuted', note: 'A bigger sample disagreed.' });
  hyp = nodeOf(saved, hypId);
  assert.deepEqual(hyp.hypothesis.history.map(item => item.outcome), ['supported', 'supported', 'refuted'], 'earlier outcomes stay in the history');
  assert.deepEqual([child, dependent].map(id => nodeOf(saved, id).stale), [true, true], 'a changed outcome flags descendants and dependents');
  assert.equal(nodeOf(saved, child).reviewCauses.at(-1).kind, 'hypothesis-outcome'); assert.equal(hyp.stale, false, 'the hypothesis itself is left as it is');
  await assert.rejects(act({ type: 'record-outcome', nodeId: hypId, outcome: 'proven' }), /supported, refuted or inconclusive/);
  await assert.rejects(act({ type: 'record-outcome', nodeId: dependent, outcome: 'refuted' }), error => error.status === 409 && /Only a hypothesis/.test(error.message));
});

test('a first refuted or inconclusive outcome flags what rests on the hypothesis', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Phones are full', body: 'Storage fills.', kind: 'hypothesis' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  const { saved } = await run(hypId, { suggestions: [{ title: 'Clear caches', body: 'A cleanup step.' }] });
  const child = saved.nodes.at(-1).id;
  await run(child, {});
  const flagged = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'inconclusive' });
  assert.equal(nodeOf(flagged, child).stale, true);
});

test('node Markdown and the brief keep the proposed outcome apart from the recorded one', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'It takes over a minute.', kind: 'hypothesis', test: 'Time ten volunteers.' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  await run(hypId, { hypothesis: { outcome: 'refuted', rationale: 'Logs show 20 seconds.' } });
  let markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${hypId}.md`), 'utf8');
  assert.match(markdown, /## Hypothesis test\n\nTime ten volunteers\.\n\n## Outcome\n\n_Not recorded yet\._\n\n_Proposed by the agent, not recorded: Refuted\. Logs show 20 seconds\._/);
  let brief = mapBrief(await store.get(map.id));
  const section = () => brief.sections.find(s => s.id === 'hypotheses');
  assert.equal(section().label, 'Hypotheses — outcomes the user recorded, proposals kept apart');
  assert.match(section().items[0].text, /^Claim: It takes over a minute\. — Test: Time ten volunteers\. — Recorded: none — Proposed by the agent, not recorded: Refuted$/);
  await act({ type: 'record-outcome', nodeId: hypId, outcome: 'supported', note: 'We timed it ourselves.' });
  markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${hypId}.md`), 'utf8');
  assert.match(markdown, /## Outcome\n\nRecorded: Supported \(\d{4}-\d{2}-\d{2}\)\. We timed it ourselves\.\n\n_Proposed by the agent, not recorded: Refuted\. Logs show 20 seconds\._/);
  brief = mapBrief(await store.get(map.id));
  assert.match(section().items[0].text, /Recorded: Supported \(\d{4}-\d{2}-\d{2}\) — Proposed by the agent, not recorded: Refuted$/);
  assert.deepEqual([section().items[0].outcome, section().items[0].proposed], ['supported', 'refuted']);
});

test('format-1 maps without hypotheses load unchanged; a hypothesis must keep its record', () => {
  const base = { schemaVersion: 1, id: 'map-1', title: 'T', rootId: 'root', edges: [], jobs: [], history: [], revision: 1, updatedAt: '2026-01-01' };
  const idea = (extra = {}) => ({ id: 'root', title: 'Root', kind: 'idea', status: 'explored', reviewState: 'unreviewed', summary: 'S', questions: [], sources: [], ...extra });
  assert.deepEqual(validateMap({ ...base, nodes: [idea()] }).errors.filter(error => error.at.startsWith('nodes')), []);
  assert.deepEqual(validateMap({ ...base, nodes: [idea({ kind: 'hypothesis', hypothesis: { test: '', outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] } })] }).errors.filter(error => error.at.startsWith('nodes')), []);
  assert.ok(validateMap({ ...base, nodes: [idea({ kind: 'hypothesis', hypothesis: 'yes' })] }).errors.some(error => error.at === 'nodes[0].hypothesis'));
  assert.ok(validateMap({ ...base, nodes: [idea({ kind: 'hypothesis', hypothesis: { outcome: 'proven', history: [] } })] }).errors.some(error => error.at === 'nodes[0].hypothesis.outcome'));
});

test('the inspector shows the test, the recorded outcome and the agent\'s proposal apart, and offers Record outcome only while live', () => {
  const node = { id: 'h1', kind: 'hypothesis', title: 'Slow', hypothesis: { test: 'Time <ten> volunteers.', outcome: 'supported', outcomeNote: 'On <site>.', outcomeAt: '2026-03-01T10:00:00.000Z', proposed: { outcome: 'refuted', rationale: 'Logs <disagree>.', jobId: 'job-1' },
    history: [{ outcome: 'inconclusive', note: 'Too few.', at: '2026-02-01T10:00:00.000Z' }, { outcome: 'supported', note: 'On <site>.', at: '2026-03-01T10:00:00.000Z' }] } };
  const html = hypothesisHtml(node, { esc, live: true, drafts: {} });
  assert.match(html, /<h3 class="section-label">Hypothesis<\/h3><p class="hypothesis-field"><small>How to test it<\/small>Time &lt;ten&gt; volunteers\.<\/p>/);
  assert.match(html, /<p class="hypothesis-field hypothesis-outcome supported"><small>Outcome you recorded<\/small>Supported · 2026-03-01\. On &lt;site&gt;\.<\/p>/);
  assert.match(html, /<p class="hypothesis-field hypothesis-proposed"><small>Proposed by your agent, not recorded<\/small>Refuted\. Logs &lt;disagree&gt;\.<\/p>/);
  assert.match(html, /<details class="hypothesis-history"><summary>Earlier outcomes \(1\)<\/summary><ul><li>Inconclusive · 2026-02-01\. Too few\.<\/li><\/ul><\/details>/);
  assert.match(html, /<details data-editor="outcome-h1"><summary>Record outcome<\/summary><form class="outcome-form" data-outcome-form="" data-node-id="h1">/);
  assert.match(html, /value="refuted" data-draft="h1-outcome" required checked>/, 'the agent\'s proposal is preselected');
  assert.match(hypothesisHtml(node, { esc, live: true, drafts: { 'h1-outcome': 'inconclusive' } }), /value="inconclusive" data-draft="h1-outcome" required checked>/, 'a draft choice wins');
  assert.doesNotMatch(hypothesisHtml(node, { esc, live: false, drafts: {} }), /Record outcome/);
  const blank = hypothesisHtml({ id: 'h2', kind: 'hypothesis', hypothesis: { test: '', outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] } }, { esc, live: true, drafts: {} });
  assert.match(blank, /Not designed yet\./); assert.match(blank, /Not recorded yet\./); assert.doesNotMatch(blank, /Proposed by your agent/);
  assert.equal(hypothesisHtml({ id: 'r', kind: 'research' }, { esc, live: true, drafts: {} }), '');
  assert.equal(outcomeMarkHtml(node), '<span class="node-outcome supported" aria-hidden="true">✓</span>'); assert.equal(outcomeLabel(node), ', outcome: Supported');
  assert.equal(outcomeMarkHtml({ ...node, hypothesis: { ...node.hypothesis, outcome: null } }), ''); assert.equal(outcomeLabel({ id: 'r', kind: 'research' }), '');
  const form = directionKindHtml('n1', { esc, drafts: { 'n1-kind': 'hypothesis', 'n1-test': 'Time <it>.' } });
  assert.match(form, /<input type="radio" name="kind" value="hypothesis" data-draft="n1-kind" checked>/); assert.match(form, /<textarea id="branch-test" name="test" rows="2" maxlength="2000" data-draft="n1-test">Time &lt;it&gt;\.<\/textarea>/);
  assert.match(directionKindHtml('n1', { esc, drafts: {} }), /value="research" data-draft="n1-kind" checked>/);
});
