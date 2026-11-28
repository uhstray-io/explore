import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { hypothesisHtml, directionKindHtml, outcomeMarkHtml, outcomeLabel, suggestPayload, outcomePayload } from '../skills/explore/assets/hypothesis.js';
import { nearbyBrief } from '../skills/explore/scripts/neighbourhood.mjs';

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
  assert.deepEqual(record.proposed, { outcome: 'refuted', rationale: 'Logs show 20 seconds on average.', jobId: saved.jobs.at(-1).id, at: record.proposed.at }); assert.match(record.proposed.at, /^\d{4}-/);
  await act({ type: 'answer', nodeId: hypId, questionId: nodeOf(saved, hypId).questions[0].id, answer: 'Yes, next week.' }); // The branch continues.
  const later = await run(hypId, { hypothesis: { outcome: null } });
  assert.equal(nodeOf(later.saved, hypId).hypothesis.proposed, null, 'a test that needs the user proposes nothing'); assert.equal(nodeOf(later.saved, hypId).hypothesis.test, 'Time five volunteers.');
});

test('the proposal lives with the findings: a later result without one clears it, a revise clears it, and a stale result never sets it', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'It takes over a minute.', kind: 'hypothesis', test: '   ' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  assert.equal(nodeOf(await store.get(map.id), hypId).hypothesis.test, '', 'a test of spaces is no test');
  let { saved, packet } = await run(hypId, { questions: ['Time it?'], hypothesis: { outcome: 'refuted', rationale: 'Logs say 20 seconds.' } });
  assert.equal(nodeOf(saved, hypId).hypothesis.proposed.outcome, 'refuted'); assert.ok(nodeOf(saved, hypId).hypothesis.proposed.at);
  await act({ type: 'answer', nodeId: hypId, questionId: nodeOf(saved, hypId).questions[0].id, answer: 'Yes.' });
  ({ saved, packet } = await run(hypId, { questions: ['Anything else?'] }));
  assert.equal(packet.selected.hypothesis.proposed, 'refuted', 'the packet carries it'); assert.match(packet.instruction, /resend it if it still holds/);
  assert.equal(nodeOf(saved, hypId).hypothesis.proposed, null, 'a result without one clears it');
  await act({ type: 'answer', nodeId: hypId, questionId: nodeOf(saved, hypId).questions.at(-1).id, answer: 'No.' });
  ({ saved } = await run(hypId, { questions: ['More?'], hypothesis: { outcome: 'supported', rationale: 'New logs.' } }));
  saved = await act({ type: 'revise', nodeId: hypId, body: 'It takes over two minutes.' });
  assert.equal(nodeOf(saved, hypId).hypothesis.proposed, null, 'a revise clears it with the findings');
  await act({ type: 'activate', nodeId: hypId });
  const job = await store.claim('agent', map.id);
  await act({ type: 'revise', nodeId: hypId, body: 'Changed while it ran.' });
  saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'S', body: 'B', hypothesis: { outcome: 'refuted', rationale: 'Stale.' } });
  assert.equal(nodeOf(saved, hypId).hypothesis.proposed, null, 'a stale result never sets it');
  assert.equal(saved.jobs.find(item => item.id === job.jobId).result.hypothesis.outcome, 'refuted', 'it stays on its job');
});

test('a changed premise on a finished hypothesis is a hypothesis with the same test, and nearby ideas in packets say what was recorded', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Logging is too slow', body: 'It takes over a minute.', kind: 'hypothesis', test: 'Time ten volunteers.' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  await run(hypId, {});
  let saved = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'supported' });
  assert.deepEqual(nearbyBrief(nodeOf(saved, hypId)).kind, 'hypothesis'); assert.equal(nearbyBrief(nodeOf(saved, hypId)).outcome, 'supported');
  assert.equal(Object.hasOwn(nearbyBrief(nodeOf(saved, map.rootId)), 'kind'), false, 'other ideas are unchanged');
  saved = await act({ type: 'fork-revision', nodeId: hypId, body: 'It takes over two minutes.' });
  const fork = saved.nodes.at(-1);
  assert.equal(fork.kind, 'hypothesis'); assert.equal(fork.hypothesis.test, 'Time ten volunteers.'); assert.equal(fork.hypothesis.outcome, null);
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
  assert.deepEqual([hyp.status, hyp.body, hyp.completedAt, hyp.reviewState], [finished.status, finished.body, finished.completedAt, finished.reviewState], 'its findings and completion stay');
  assert.equal(hyp.contentRevision, finished.contentRevision + 1, 'work running on it or below it becomes stale, as after a changed answer');
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
  assert.equal(nodeOf(saved, dependent).status, 'explored', 'flagged, not interrupted');
  await assert.rejects(act({ type: 'record-outcome', nodeId: hypId, outcome: 'proven' }), /supported, refuted or inconclusive/);
  await assert.rejects(act({ type: 'record-outcome', nodeId: dependent, outcome: 'refuted' }), error => error.status === 409 && /Only a hypothesis/.test(error.message));
});

test('a first refuted or inconclusive outcome flags what rests on the hypothesis, and questions below it stay answerable', async () => {
  const { store, map, act, run } = await setup();
  await act({ type: 'suggest', nodeId: map.rootId, title: 'Phones are full', body: 'Storage fills.', kind: 'hypothesis' });
  const hypId = (await store.get(map.id)).nodes.at(-1).id;
  const { saved } = await run(hypId, { suggestions: [{ title: 'Clear caches', body: 'A cleanup step.' }, { title: 'Ask the team', body: 'A survey.' }] });
  const [child, asking] = saved.nodes.slice(-2).map(node => node.id);
  await run(child, {});
  await run(asking, { questions: ['Which phones do they use?'] }); // Waiting for an answer.
  const flagged = await act({ type: 'record-outcome', nodeId: hypId, outcome: 'inconclusive', note: '   ' });
  assert.equal(nodeOf(flagged, child).stale, true); assert.equal(nodeOf(flagged, hypId).hypothesis.outcomeNote, '', 'a note of spaces is no note');
  const waiting = nodeOf(flagged, asking);
  assert.equal(waiting.status, 'awaiting-answer'); assert.equal(waiting.questions[0].supersededAt, undefined);
  const answered = await act({ type: 'answer', nodeId: asking, questionId: waiting.questions[0].id, answer: 'Android, mostly.' });
  assert.equal(nodeOf(answered, asking).questions[0].answer, 'Android, mostly.', 'still answerable');
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
  assert.match(section().items[0].text, /^Recorded: none — Proposed by the agent, not recorded: Refuted — Claim: It takes over a minute\. — Test: Time ten volunteers\.$/);
  await act({ type: 'record-outcome', nodeId: hypId, outcome: 'supported', note: 'We timed it ourselves.' });
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, type: 'record-outcome', nodeId: hypId, outcome: 'inconclusive', note: 'A bigger sample.' }, { actor: { name: 'Ana' } });
  markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${hypId}.md`), 'utf8');
  assert.match(markdown, /## Outcome\n\nRecorded: Inconclusive \(\d{4}-\d{2}-\d{2}\) by Ana\. A bigger sample\.\n\n_Proposed by the agent, not recorded: Refuted\. Logs show 20 seconds\._\n\nEarlier outcomes:\n- Supported \(\d{4}-\d{2}-\d{2}\)\. We timed it ourselves\./);
  brief = mapBrief(await store.get(map.id));
  assert.match(section().items[0].text, /^Recorded: Inconclusive \(\d{4}-\d{2}-\d{2}\) — Proposed by the agent, not recorded: Refuted — Claim/);
  assert.deepEqual([section().items[0].outcome, section().items[0].proposed], ['inconclusive', 'refuted']);
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, type: 'fork-revision', nodeId: hypId, body: 'x'.repeat(400) });
  brief = mapBrief(await store.get(map.id));
  const long = section().items.find(item => item.text.includes('xxxx'));
  assert.match(long.text, /^Recorded: none — Claim: x{159}… — Test: Time ten volunteers\.$/, 'a long claim never hides the outcome');
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
  const node = { id: 'h1', kind: 'hypothesis', title: 'Slow', hypothesis: { test: 'Time <ten> volunteers.', outcome: 'supported', outcomeNote: 'On <site>.', outcomeAt: '2026-03-01T10:00:00.000Z', proposed: { outcome: 'refuted', rationale: 'Logs <disagree>.', jobId: 'job-1', at: '2026-03-02T10:00:00.000Z' },
    history: [{ outcome: 'inconclusive', note: 'Too few.', at: '2026-02-01T10:00:00.000Z' }, { outcome: 'supported', note: 'On <site>.', at: '2026-03-01T10:00:00.000Z' }] } };
  const html = hypothesisHtml(node, { esc, live: true, drafts: {} });
  assert.match(html, /<h3 class="section-label">Hypothesis<\/h3><p class="hypothesis-field"><small>How to test it<\/small>Time &lt;ten&gt; volunteers\.<\/p>/);
  assert.match(html, /<p class="hypothesis-field hypothesis-outcome supported"><small>Outcome you recorded<\/small>Supported · 2026-03-01\. On &lt;site&gt;\.<\/p>/);
  assert.match(html, /<p class="hypothesis-field hypothesis-proposed"><small>Proposed by your agent, not recorded<\/small>Refuted\. Logs &lt;disagree&gt;\.<\/p>/);
  assert.match(html, /<details class="hypothesis-history" data-editor="outcome-history-h1"><summary>Earlier outcomes \(1\)<\/summary><ul><li>Inconclusive · 2026-02-01\. Too few\.<\/li><\/ul><\/details>/);
  assert.match(html, /<details data-editor="outcome-h1"><summary>Record outcome<\/summary><form class="outcome-form" data-outcome-form="" data-node-id="h1">/);
  assert.match(html, /value="refuted" data-draft="h1-outcome" required checked>/, 'a proposal newer than the recorded outcome is preselected');
  const older = { ...node, hypothesis: { ...node.hypothesis, proposed: { ...node.hypothesis.proposed, at: '2026-02-15T10:00:00.000Z' } } };
  assert.match(hypothesisHtml(older, { esc, live: true, drafts: {} }), /value="supported" data-draft="h1-outcome" required checked>/, 'after the user disagreed, their outcome stays chosen');
  assert.match(html, /<details class="hypothesis-history" data-editor="outcome-history-h1">/, 'earlier outcomes stay open across polls');
  assert.match(hypothesisHtml(node, { esc, live: true, drafts: { 'h1-outcome': 'inconclusive' } }), /value="inconclusive" data-draft="h1-outcome" required checked>/, 'a draft choice wins');
  assert.doesNotMatch(hypothesisHtml(node, { esc, live: false, drafts: {} }), /Record outcome/);
  const blank = hypothesisHtml({ id: 'h2', kind: 'hypothesis', hypothesis: { test: '', outcome: null, outcomeNote: '', outcomeAt: null, proposed: null, history: [] } }, { esc, live: true, drafts: {} });
  assert.match(blank, /Not designed yet\./); assert.match(blank, /Not recorded yet\./); assert.doesNotMatch(blank, /Proposed by your agent/);
  assert.equal(hypothesisHtml({ id: 'r', kind: 'research' }, { esc, live: true, drafts: {} }), '');
  assert.equal(outcomeMarkHtml(node), '<span class="node-outcome supported" aria-hidden="true">+</span>'); assert.equal(outcomeLabel(node), ', outcome: Supported');
  assert.equal(outcomeMarkHtml({ ...node, hypothesis: { ...node.hypothesis, outcome: null } }), ''); assert.equal(outcomeLabel({ id: 'r', kind: 'research' }), '');
  const form = directionKindHtml('n1', { esc, drafts: { 'n1-kind': 'hypothesis', 'n1-test': 'Time <it>.' } });
  assert.match(form, /<input type="radio" name="kind" value="hypothesis" data-draft="n1-kind" checked>/); assert.match(form, /<textarea id="branch-test" name="test" rows="2" maxlength="2000" data-draft="n1-test">Time &lt;it&gt;\.<\/textarea>/);
  assert.match(directionKindHtml('n1', { esc, drafts: {} }), /value="research" data-draft="n1-kind" checked>/);
  assert.deepEqual(suggestPayload({ title: 'Slow', body: '  ', kind: 'hypothesis', test: '  Time it.  ' }), { title: 'Slow', body: 'Slow', kind: 'hypothesis', test: 'Time it.' });
  assert.deepEqual(suggestPayload({ title: 'Plain', body: 'Look.', kind: 'research', test: 'ignored' }), { title: 'Plain', body: 'Look.' });
  assert.deepEqual(outcomePayload({ outcome: 'refuted', note: '  ' }), { outcome: 'refuted', note: '' });
});
