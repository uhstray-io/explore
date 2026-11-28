import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { reconsiderJobTypes, normalizeReconsideration } from '../skills/explore/scripts/reconsider.mjs';
import { optionsHtml } from '../skills/explore/assets/workspace-view.js';
import { reconsiderationsOf, proposalState, criteriaDialogHtml, reconsideredHtml, criteriaEntryHtml, adoptedReconsideration, criteriaKey } from '../skills/explore/assets/criteria.js';
import { criteriaDialog } from '../skills/explore/assets/criteria-dialog.js';

// Compare options with your own criteria (C9, #14). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const options = [{ id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.' }, { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' }];
const comparison = { options, recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' } };
const exec = promisify(execFile), skill = path.resolve('skills/explore');

async function setup({ questions = [] } = {}) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'criteria-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Two ways to sync.', body: 'Details.', ...comparison, ...(questions.length ? { questions } : {}) });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input });
  const node = async () => (await store.get(map.id)).nodes[0];
  // Ask for a reconsideration and let the agent deliver `make(node)`; returns the job's id.
  const reconsider = async (make = revised) => {
    await act({ type: 'reconsider' });
    const packet = await store.claim('agent', map.id);
    await store.complete(map.id, packet.jobId, packet.claimKey, make(await node()));
    return packet.jobId;
  };
  const view = async () => store.view(await store.get(map.id));
  const adoptedIds = async () => (await store.get(map.id)).jobs.filter(job => job.outcome === 'adopted').map(job => job.id);
  return { store, map, act, node, reconsider, view, adoptedIds };
}
const criteria = [{ label: 'Cheap to run', priority: 'low' }, { label: 'Works with no signal', priority: 'high' }];
const assessments = (node, extra = {}, list = node.criteria) => node.options.flatMap(option => list.map(criterion => ({ optionId: option.id, criterionId: criterion.id, text: `${option.id} on ${criterion.label}.`, basis: 'reasoning', ...extra })));
const revised = (node, list = node.criteria) => ({ assessments: assessments(node, {}, list), recommendation: { optionId: 'lock', rationale: 'Offline matters most to you, and locking is simpler offline.', mainTradeoff: 'Less concurrent editing.', reconsiderIf: 'A second team joins.' }, changed: 'Your high priority on working with no signal favours locking.' });
const markdownOf = async (store, map) => readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');

test('criteria save sorted by priority and queue no work; each label once, an identical save changes nothing, and they clear without options', async () => {
  const { store, map, act } = await setup();
  const before = (await store.get(map.id)).jobs.length;
  let saved = await act({ type: 'set-criteria', criteria });
  const list = saved.nodes[0].criteria;
  assert.deepEqual(list.map(item => [item.label, item.priority]), [['Works with no signal', 'high'], ['Cheap to run', 'low']]);
  assert.ok(list.every(item => /^crit-[0-9a-f]{8}$/.test(item.id))); assert.equal(saved.jobs.length, before, 'nothing queued');
  saved = await act({ type: 'set-criteria', criteria: [{ id: list[1].id, label: 'Cheap to run', priority: 'normal' }, list[0]] });
  assert.deepEqual(saved.nodes[0].criteria.map(item => item.id), [list[0].id, list[1].id], 'ids are kept');
  await assert.rejects(act({ type: 'set-criteria', criteria: saved.nodes[0].criteria }), error => error.status === 409 && /Nothing changed/.test(error.message), 'an identical save');
  await assert.rejects(act({ type: 'set-criteria', criteria: saved.nodes[0].criteria.map(item => ({ ...item, label: `${item.label} ` })) }), /Nothing changed/, 'labels are trimmed');
  await assert.rejects(act({ type: 'set-criteria', criteria: [list[0]], expected: [list[0]] }), error => error.status === 409 && /changed elsewhere/.test(error.message), 'edits made on top of criteria saved elsewhere');
  const twice = (await act({ type: 'set-criteria', criteria: [list[0], { ...list[0], label: 'Easy to explain' }] })).nodes[0].criteria;
  assert.equal(twice[0].id, list[0].id); assert.notEqual(twice[1].id, list[0].id, 'a repeated id gets a new one');
  for (const [bad, message] of [[Array.from({ length: 9 }, (_, i) => ({ label: `C${i}`, priority: 'low' })), /at most 8/], [[{ label: 'x'.repeat(121), priority: 'low' }], /at most 120/], [[{ label: 'Fast', priority: 'urgent' }], /High, Normal or Low/],
    [[{ label: ' ', priority: 'low' }], /required/], [[{ label: 'Fast', priority: 'low' }, { label: 'fast', priority: 'high' }], /already a criterion/]]) {
    await assert.rejects(act({ type: 'set-criteria', criteria: bad }), message);
  }
  const plain = await act({ type: 'suggest', title: 'Storage', body: 'Limits.' });
  await assert.rejects(store.action(map.id, { expectedRevision: plain.revision, type: 'set-criteria', nodeId: plain.nodes.at(-1).id, criteria }), error => error.status === 409 && /options/.test(error.message));
  // Criteria left behind on an idea whose options went away can still be cleared.
  const raw = await store.get(map.id); delete raw.nodes[0].options; delete raw.nodes[0].recommendation;
  await writeFile(store.file(map.id), JSON.stringify(raw));
  saved = await act({ type: 'set-criteria', criteria: [] });
  assert.equal(Object.hasOwn(saved.nodes[0], 'criteria'), false, 'an empty list removes them');
});

test('reconsidering keeps what it was asked about, waits for the idea\'s own investigation, and leaves the idea as it was', async () => {
  const { store, map, act, node } = await setup({ questions: ['Which phones?'] });
  await act({ type: 'set-criteria', criteria });
  await act({ type: 'answer', questionId: (await node()).questions[0].id, answer: 'Older Android phones.', answerState: 'decided' });
  await assert.rejects(act({ type: 'reconsider' }), error => error.status === 409 && /still exploring/.test(error.message), 'its investigation is open');
  let packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Two ways to sync.', body: 'Details again.', ...comparison, options: [{ ...options[0], suggestedAnswer: 'Merge.' }, options[1]] });
  const finished = await node();
  assert.equal(finished.status, 'explored');
  let saved = await act({ type: 'reconsider' });
  const job = saved.jobs.at(-1);
  assert.equal(job.type, 'reconsider');
  assert.deepEqual(job.input, { criteria: finished.criteria, contentRevision: finished.contentRevision, options: [{ id: 'crdt', title: 'Merge edits automatically' }, { id: 'lock', title: 'One editor at a time' }], blocked: false });
  await assert.rejects(act({ type: 'reconsider' }), error => error.status === 409 && /already/.test(error.message), 'one at a time');
  packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'reconsider'); assert.deepEqual(packet.options.map(option => option.id), ['crdt', 'lock']);
  assert.equal(packet.options.some(option => 'suggestedAnswer' in option), false, 'suggested answers stay out');
  assert.deepEqual(packet.node.answers.map(answer => [answer.answer, answer.answerState]), [['Older Android phones.', 'decided']], 'answers say how sure they are');
  assert.equal(packet.recommendation.optionId, 'crdt'); assert.deepEqual(packet.criteria.map(item => item.priority), ['high', 'low']);
  assert.match(packet.instruction, /no new research/i); assert.match(packet.instruction, /priorities are the user's preferences, not facts/i);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, revised(finished));
  const after = saved.nodes[0];
  assert.deepEqual([after.status, after.summary, after.body, after.completedAt, after.contentRevision, after.reviewState], [finished.status, finished.summary, finished.body, finished.completedAt, finished.contentRevision, finished.reviewState]);
  assert.equal(after.recommendation.optionId, 'crdt', 'the original is never overwritten');
  assert.equal(reconsiderationsOf(store.view(saved), map.rootId).latest.result.recommendation.optionId, 'lock');
});

test('the packet carries claims and limitations, gives way in order when too long, and stays within its budget at C1\'s limits', async () => {
  const long = (length, mark = '') => `${mark}${'x'.repeat(length - mark.length)}`;
  const big = ['a', 'b', 'c', 'd'].map(letter => ({ id: `opt${letter}`, title: long(150, letter), description: long(600), fit: long(400), pros: [1, 2, 3, 4].map(n => long(240, `${n}`)), cons: [1, 2, 3, 4].map(n => long(240, `${n}`)), suggestedAnswer: long(1000) }));
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `crit-0000000${i}`, label: long(120, `${i}`), priority: 'normal' }));
  const node = { id: 'n1', title: 'Root', prompt: long(2400), summary: long(700), body: 'b', options: big, recommendation: { optionId: 'opta', rationale: long(800), mainTradeoff: long(600) },
    questions: Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, text: long(300, `${i}`), answer: long(600), answerState: 'decided' })),
    claims: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, text: long(300) })),
    limitations: [{ id: 'l0', kind: 'missing-evidence', summary: long(300), blocksRecommendation: true }, ...Array.from({ length: 7 }, (_, i) => ({ id: `l${i + 1}`, kind: 'missing-evidence', summary: long(300) }))] };
  const job = { input: { criteria: eight, options: big.map(({ id, title }) => ({ id, title })) } };
  const { packet } = reconsiderJobTypes.reconsider;
  const small = packet({ job: { input: { criteria: eight.slice(0, 2), options: big.map(({ id, title }) => ({ id, title })) } }, node: { ...node, options: big.map(({ suggestedAnswer, pros, cons, ...rest }) => ({ ...rest, description: 'd', fit: 'f', pros: [], cons: [] })), questions: node.questions.slice(0, 2), claims: node.claims.slice(0, 2), limitations: node.limitations.slice(0, 2), prompt: 'p' }, budget: 15500 });
  assert.equal(small.node.answers.length, 2); assert.equal(small.claims.length, 2); assert.equal(small.limitations.length, 2); assert.equal(small.omitted, undefined, 'nothing left out when it fits');
  const full = packet({ job, node, budget: 15500 });
  assert.ok(JSON.stringify(full).length <= 15500 - 800, `${JSON.stringify(full).length} characters`);
  assert.equal(full.options.some(option => 'suggestedAnswer' in option), false);
  assert.deepEqual(full.omitted, { answers: 8, claims: 12, limitations: 7, shortened: ['options'] }, 'answers first, then claims, then limitations that block nothing, then wording');
  assert.match(full.retrieval, /read --map MAP --node NODE --section premise\|options/);
  assert.deepEqual(full.limitations.map(record => record.id), ['l0'], 'a limitation that blocks a recommendation stays');
  assert.ok(full.options.every(option => option.description.length <= 240 && option.pros.every(item => item.length <= 100)), 'and last the options\' wording shortens');
  // Answers give way oldest first, and only as far as needed.
  const some = packet({ job, node: { ...node, options: big.map(({ suggestedAnswer, ...rest }) => ({ ...rest, description: 'd', fit: 'f', pros: [], cons: [] })), claims: [], limitations: [] }, budget: 12000 });
  assert.ok(some.omitted.answers > 0 && some.node.answers.length > 0); assert.equal(some.node.answers.at(-1).question, node.questions.at(-1).text);
  assert.throws(() => packet({ job: { input: { ...job.input, options: [{ id: 'other', title: 'Other' }] } }, node, budget: 15500 }), /idea changed since you asked/, 'other options');
  assert.throws(() => packet({ job: { input: { ...job.input, contentRevision: 1 } }, node: { ...node, contentRevision: 2 }, budget: 15500 }), /idea changed since you asked/, 'an idea that moved on is not sent');
  const tight = packet({ job, node: { ...node, prompt: long(2400), recommendation: { optionId: 'opta', rationale: long(800), mainTradeoff: long(600) } }, budget: 9000 });
  assert.deepEqual(tight.omitted.shortened, ['options', 'premise', 'recommendation', 'limitations'], 'then the premise, the recommendation and the limitations');
  // End to end: a comparison at C1's limits with eight long criteria is claimed, never failed for its size.
  const { store, map, act } = await setup();
  const raw = await store.get(map.id); Object.assign(raw.nodes[0], { options: big, recommendation: node.recommendation, prompt: node.prompt, summary: node.summary });
  await writeFile(store.file(map.id), JSON.stringify(raw));
  await act({ type: 'set-criteria', criteria: eight.map(({ label, priority }) => ({ label, priority })) });
  await act({ type: 'reconsider' });
  const claimed = await store.claim('agent', map.id);
  assert.equal(claimed.jobType, 'reconsider'); assert.ok(claimed.contextCharacters <= 15500);
});

test('a result missing a pair, repeating one, naming unknown IDs, with extra fields, or recommending against a blocking limitation is rejected unchanged', async () => {
  const { store, map, act, node } = await setup();
  await act({ type: 'set-criteria', criteria });
  await act({ type: 'reconsider' });
  const current = await node(), packet = await store.claim('agent', map.id), before = await readFile(store.file(map.id), 'utf8');
  const good = revised(current), [first, second, ...rest] = good.assessments;
  for (const [bad, message] of [[{ ...good, assessments: good.assessments.slice(1) }, /every option and criterion/], [{ ...good, assessments: [{ ...first, optionId: 'nope' }, second, ...rest] }, /not in this comparison/],
    [{ ...good, assessments: [first, { ...first }, ...rest] }, /repeats an option and criterion/], [{ ...good, assessments: [{ ...first, basis: 'vibes' }, second, ...rest] }, /evidence, reasoning or unknown/],
    [{ ...good, assessments: [{ ...first, confidence: 'high' }, second, ...rest] }, /does not take: confidence/], [{ ...good, recommendation: { ...good.recommendation, score: 3 } }, /does not take: score/],
    [{ ...good, changed: undefined }, /What changed/], [{ ...good, extra: 1 }, /remove extra/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const blocked = { optionIds: ['crdt', 'lock'], criteria: current.criteria, blocked: true }, fail = message => { throw new Error(message); };
  assert.throws(() => normalizeReconsideration(good, blocked, fail), /blocks a recommendation/);
  assert.equal(normalizeReconsideration({ ...good, recommendation: { optionId: null, missing: 'Field tests.' } }, blocked, fail).recommendation.optionId, null);
});

test('a result is checked against what was asked: criteria edited and options changed since are kept, marked, never refused', async () => {
  const { store, map, act, node, view } = await setup({ questions: ['Which phones?'] });
  await act({ type: 'set-criteria', criteria });
  await act({ type: 'reconsider' });
  const asked = await node(), packet = await store.claim('agent', map.id);
  await act({ type: 'set-criteria', criteria: [...asked.criteria, { label: 'Easy to explain', priority: 'normal' }] });
  await act({ type: 'answer', questionId: asked.questions[0].id, answer: 'Older Android phones.' }); // Queues the idea's own investigation.
  const investigation = await store.claim('agent', map.id);
  await store.complete(map.id, investigation.jobId, investigation.claimKey, { summary: 'Three ways now.', body: 'Details.', options: [{ id: 'p2p', title: 'Peer to peer', description: 'Devices sync directly.', fit: 'No server.' }, ...options], recommendation: { optionId: null, missing: 'Field data.' },
    limitations: [{ id: 'pilot', kind: 'missing-evidence', summary: 'No field data yet.', nextStep: 'Run a pilot.', blocksRecommendation: true }] });
  // For the two options and two criteria it was asked about, with nothing blocking a recommendation then.
  await store.complete(map.id, packet.jobId, packet.claimKey, revised(asked));
  const shown = await view(), job = reconsiderationsOf(shown, map.rootId).latest;
  assert.equal(job.id, packet.jobId); assert.equal(proposalState(shown.nodes[0], job), 'outdated');
  const html = criteriaDialogHtml({ map: shown, node: shown.nodes[0], esc, draft: shown.nodes[0].criteria });
  assert.match(html, /Outdated: the idea changed since you asked/); assert.doesNotMatch(html, /data-reconsider-adopt/);
  assert.match(html, /<th scope="row">One editor at a time<\/th>/); assert.doesNotMatch(html, /Peer to peer/, 'the grid shows the options it was asked about');
  assert.match(html, /<strong>Why One editor at a time:<\/strong>/, 'and its advice is never blank');
});

test('adopting leads with the revised advice beside the original, in the inspector, Markdown, read and the brief', async () => {
  const { store, map, act, reconsider, view, adoptedIds } = await setup();
  await act({ type: 'set-criteria', criteria: [{ label: 'Works *offline*', priority: 'high' }, { label: 'Cheap to run', priority: 'low' }] });
  const id = await reconsider(node => ({ ...revised(node), recommendation: { ...revised(node).recommendation, rationale: 'Offline matters most to you, and *locking* is simpler offline.' }, changed: 'Your <high> priority on working offline favours locking.' }));
  await act({ type: 'adopt-reconsideration', jobId: id });
  await assert.rejects(act({ type: 'adopt-reconsideration', jobId: id }), error => error.status === 409 && /Nothing changed/.test(error.message));
  const shown = await view(), lead = reconsideredHtml(shown, shown.nodes[0], { esc });
  assert.equal(adoptedReconsideration(shown, shown.nodes[0]).id, id);
  assert.match(lead, /<p class="reconsidered-label">Reconsidered with your criteria<\/p><p><strong>Why One editor at a time:<\/strong> Offline matters most/);
  assert.match(lead, /<strong>Main trade-off:<\/strong> Less concurrent editing\./); assert.match(lead, /<strong>Reconsider if:<\/strong> A second team joins\./);
  assert.match(lead, /What changed: Your &lt;high&gt; priority/, 'escaped');
  const cards = optionsHtml(shown.nodes[0], esc, undefined, lead);
  assert.match(cards, /Merge edits automatically <span class="option-badge">Originally recommended<\/span>/); assert.match(cards, /<p class="option-original">Original recommendation<\/p>/);
  assert.match(optionsHtml(shown.nodes[0], esc), /<span class="option-badge">Recommended<\/span>/, 'without a reconsideration in use');
  const markdown = await markdownOf(store, map);
  assert.match(markdown, /### Your criteria\n\n- High: Works \\\*offline\\\*\n- Low: Cheap to run/, 'criteria are escaped');
  assert.match(markdown, /### Reconsidered with your criteria\n\n_The agent's judgement against your priorities, not a decision\._\n\nRecommended: One editor at a time \(lock\)\nWhy: Offline matters most to you, and \\\*locking\\\* is simpler offline\.\nMain trade-off: Less concurrent editing\.\nReconsider if: A second team joins\.\n\nWhat changed: Your \\<high\\> priority/);
  assert.match(markdown, /Recommended: Merge edits automatically/, 'the original stays');
  const item = mapBrief(await store.get(map.id)).sections.find(s => s.id === 'recommendations').items[0];
  assert.match(item.text, /^Reconsidered with your criteria: One editor at a time\. Original: Merge edits automatically\./); assert.equal(Object.hasOwn(item, 'reconsidered'), false);
  assert.match(contextExcerpt(await store.get(map.id), map.rootId, { section: 'options' }).excerpt, /Your criteria[\s\S]*Reconsidered with your criteria/);
  await act({ type: 'dismiss-reconsideration', jobId: id });
  assert.deepEqual(await adoptedIds(), [], 'back to the original only');
  assert.equal(reconsideredHtml(await view(), (await view()).nodes[0], { esc }), '');
});

test('an adoption ends when the idea changes or the criteria are edited; one per idea; Keep original on a newer proposal ends an earlier one', async () => {
  const { store, map, act, node, reconsider, view, adoptedIds } = await setup({ questions: ['Which phones?'] });
  await act({ type: 'set-criteria', criteria });
  const first = await reconsider();
  await act({ type: 'adopt-reconsideration', jobId: first });
  const second = await reconsider();
  let shown = await view();
  assert.match(criteriaDialogHtml({ map: shown, node: shown.nodes[0], esc, draft: shown.nodes[0].criteria }), /Your earlier reconsideration stays in use until you choose/);
  await act({ type: 'adopt-reconsideration', jobId: second });
  assert.deepEqual(await adoptedIds(), [second], 'one per idea');
  const third = await reconsider();
  await act({ type: 'dismiss-reconsideration', jobId: third });
  assert.deepEqual(await adoptedIds(), [], 'Keep original: the original leads again');
  shown = await view();
  assert.equal(reconsideredHtml(shown, shown.nodes[0], { esc }), '');
  // Edited criteria end it, in map.json too.
  await act({ type: 'adopt-reconsideration', jobId: third });
  await act({ type: 'set-criteria', criteria: [...(await node()).criteria, { label: 'Easy to explain', priority: 'normal' }] });
  assert.deepEqual(await adoptedIds(), [], 'edited criteria');
  await assert.rejects(act({ type: 'adopt-reconsideration', jobId: third }), error => error.status === 409 && /earlier criteria/.test(error.message), 'nor can it be adopted again');
  // So does a change to the idea: here, an answer.
  const fourth = await reconsider();
  await act({ type: 'adopt-reconsideration', jobId: fourth });
  await act({ type: 'answer', questionId: (await node()).questions[0].id, answer: 'Older Android phones.' });
  assert.deepEqual(await adoptedIds(), [], 'the idea changed');
  assert.equal((await view()).jobs.find(job => job.id === fourth).stale, true, 'views mark it stale for every reader');
  shown = await view();
  assert.equal(reconsideredHtml(shown, shown.nodes[0], { esc }), '');
  assert.doesNotMatch(await markdownOf(store, map), /Reconsidered with your criteria/);
  assert.match(mapBrief(await store.get(map.id)).sections.find(s => s.id === 'recommendations').items[0].text, /^Recommended: Merge edits automatically/);
  await assert.rejects(act({ type: 'adopt-reconsideration', jobId: fourth }), error => error.status === 409 && /outdated/.test(error.message));
});

test('a stale idea cannot be reconsidered, and outdated covers a stale job, a stale idea, a new content revision and lost options', async () => {
  const { store, map, act } = await setup();
  await act({ type: 'set-criteria', criteria });
  // An earlier premise changed: the idea's findings need review, and reconsidering waits for that.
  const raw = await store.get(map.id); raw.nodes[0].stale = true;
  await writeFile(store.file(map.id), JSON.stringify(raw));
  await assert.rejects(act({ type: 'reconsider' }), error => error.status === 409 && /need review/.test(error.message));
  const node = { id: 'n', contentRevision: 2, options, criteria: [{ id: 'crit-aaaaaaaa', label: 'Cheap', priority: 'low' }] };
  const job = { input: { criteria: node.criteria, contentRevision: 2 } };
  assert.equal(proposalState(node, job), 'current');
  for (const [what, changed, asked] of [['a stale job', node, { ...job, stale: true }], ['a stale idea', { ...node, stale: true }, job], ['a new revision', { ...node, contentRevision: 3 }, job], ['no options', { ...node, options: [] }, job]]) assert.equal(proposalState(changed, asked), 'outdated', what);
  assert.equal(proposalState({ ...node, criteria: [{ ...node.criteria[0], label: 'Cheaper' }] }, job), 'earlier-criteria', 'a relabelled criterion');
});

test('stopping, failing or restarting a reconsideration never changes the idea\'s status, and the dialog says when it failed', async () => {
  const { store, map, act, node, view } = await setup();
  await act({ type: 'set-criteria', criteria });
  const status = (await node()).status;
  let saved = await act({ type: 'reconsider' });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'cancel-job', jobId: saved.jobs.at(-1).id });
  assert.equal(saved.jobs.at(-1).status, 'cancelled'); assert.equal(saved.nodes[0].status, status);
  const dialog = async () => { const shown = await view(); return criteriaDialogHtml({ map: shown, node: shown.nodes[0], esc, draft: shown.nodes[0].criteria }); };
  assert.doesNotMatch(await dialog(), /could not reconsider/, 'a stop the user made is not a failure');
  await act({ type: 'reconsider' });
  let packet = await store.claim('agent', map.id);
  saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'No time.');
  assert.equal(saved.jobs.at(-1).status, 'failed'); assert.equal(saved.nodes[0].status, status);
  assert.match(await dialog(), /Your agent could not reconsider this time\. No time\./);
  await act({ type: 'reconsider' });
  packet = await store.claim('agent', map.id);
  const restarted = new Store(path.dirname(path.dirname(store.file(map.id))));
  await restarted.recover();
  const after = await restarted.get(map.id);
  assert.equal(after.jobs.find(job => job.id === packet.jobId).status, 'interrupted'); assert.equal(after.nodes[0].status, status);
  const shown = restarted.view(after);
  assert.match(criteriaDialogHtml({ map: shown, node: shown.nodes[0], esc, draft: shown.nodes[0].criteria }), /Your agent could not reconsider this time\. /);
});

test('the dialog lists the criteria by priority, shows a proposal as a grid that names each cell\'s criterion, and says why it cannot be used', () => {
  const node = { id: 'root', title: 'Root', ...comparison, criteria: [{ id: 'crit-aaaaaaaa', label: 'No <signal>', priority: 'high' }, { id: 'crit-bbbbbbbb', label: 'Cheap', priority: 'low' }] };
  const job = { id: 'job-1', type: 'reconsider', nodeId: 'root', status: 'completed', finishedAt: '2026-03-04T10:00:00.000Z', input: { criteria: node.criteria }, result: { ...revised(node), assessments: assessments(node, { text: 'Fine <here>.' }) } };
  const map = { nodes: [node], jobs: [job] }, dialog = (jobs, extra = {}) => criteriaDialogHtml({ map: { nodes: [node], jobs }, node, esc, draft: node.criteria, ...extra });
  const html = criteriaDialogHtml({ map, node, esc, draft: node.criteria });
  assert.match(html, /<input id="criterion-0" data-criterion-label="0" maxlength="120" value="No &lt;signal&gt;"/); assert.match(html, /<option value="high" selected>High<\/option>/);
  assert.match(html, /<table class="criteria-grid">/); assert.match(html, /<th scope="col">No &lt;signal&gt; <small>High<\/small><\/th>/);
  assert.match(html, /<td><span class="criteria-cell-label">No &lt;signal&gt; · High<\/span>Fine &lt;here&gt;\. <small>Reasoning<\/small><\/td>/);
  assert.match(html, /<p class="reconsidered-label">Revised recommendation<\/p><p><strong>Why One editor at a time:<\/strong>/); assert.match(html, /<strong>Reconsider if:<\/strong> A second team joins\./);
  assert.match(html, /data-reconsider-adopt="job-1">Use revised comparison<\/button>/); assert.match(html, /data-reconsider-dismiss="job-1">Keep original<\/button>/);
  assert.match(html, /<p class="form-note" id="criteria-adopt-note" hidden>/); assert.match(html, /<p class="state-note warning" id="criteria-elsewhere" hidden>/);
  assert.match(dialog([job], { edited: true, changedElsewhere: true }), /<p class="state-note warning" id="criteria-elsewhere">Your criteria were changed elsewhere since you opened this\. <button type="button" class="text-button" data-criteria-reload="">Use the saved criteria<\/button><\/p>/);
  assert.match(dialog([job], { edited: true }), /data-reconsider-adopt="job-1" disabled aria-describedby="criteria-adopt-note">[\s\S]*<p class="form-note" id="criteria-adopt-note">Save or undo/, 'unsaved edits first');
  const edited = { ...node, criteria: [...node.criteria, { id: 'crit-cccccccc', label: 'New', priority: 'normal' }] };
  const earlier = criteriaDialogHtml({ map: { nodes: [edited], jobs: [job] }, node: edited, esc, draft: edited.criteria });
  assert.match(earlier, /Based on earlier criteria/); assert.doesNotMatch(earlier, /data-reconsider-adopt/);
  assert.match(dialog([{ ...job, stale: true }]), /Outdated: the idea changed since you asked/);
  assert.doesNotMatch(dialog([{ ...job, outcome: 'dismissed' }]), /Your agent's reconsideration/, 'a proposal set aside is not shown');
  const waiting = dialog([job, { id: 'job-2', type: 'reconsider', nodeId: 'root', status: 'queued' }]);
  assert.match(waiting, /data-reconsider-ask="" disabled>/); assert.match(waiting, /Queued for your agent\. <button type="button" class="text-button" data-reconsider-stop="job-2">Stop<\/button>/);
  assert.match(dialog([job, { id: 'job-3', type: 'reconsider', nodeId: 'root', status: 'failed', error: 'Too <long>.' }]), /Your agent could not reconsider this time\. Too &lt;long&gt;\./);
  assert.match(criteriaDialogHtml({ map, node, esc, draft: [] }), /data-reconsider-ask="" disabled>/, 'nothing to ask with');
  assert.match(criteriaEntryHtml(node, { esc, live: true }), /<button type="button" class="secondary" data-criteria-open="root">Compare with my criteria<\/button>/);
  assert.equal(criteriaEntryHtml({ id: 'x' }, { esc, live: true }), '', 'only an idea with options');
  assert.equal(criteriaEntryHtml(node, { esc, live: false }), '', 'only on the live map');
  // A map.json changed outside Explore (pulled through Git) is not saved until its next change, so readers check too.
  const kept = { ...node, contentRevision: 3 }, inUse = { ...job, outcome: 'adopted', input: { ...job.input, contentRevision: 3 } };
  assert.match(reconsideredHtml({ nodes: [kept], jobs: [inUse] }, kept, { esc }), /Reconsidered with your criteria/);
  assert.equal(reconsideredHtml({ nodes: [kept], jobs: [inUse] }, { ...kept, contentRevision: 4 }, { esc }), '', 'not once the idea changed');
  assert.equal(adoptedReconsideration({ nodes: [kept], jobs: [inUse] }, { ...kept, criteria: [node.criteria[0]] }), null, 'nor once the criteria were edited');
});

// A small fake DOM for the dialog: an element's querySelector finds only what its HTML has, the same object each time.
function fakeDialog({ map, act }) {
  const elements = new Map(), focused = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, focus() { focused.push(`#${id}`); },
        querySelector(selector) {
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1)}"`) : this.innerHTML.includes(`${selector.slice(1, -1)}=`);
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, hidden: false, attributes: {}, focus() { focused.push(selector); }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const dialog = criteriaDialog({ map, act, esc, toast: message => toasts.push(message), listening: () => false });
  const body = element('criteria-body');
  const click = async dataset => { const button = { dataset, disabled: false }; await body.fire('click', { target: { closest: () => button } }); return button; };
  const type = (at, value) => body.fire('input', { target: { dataset: { criterionLabel: String(at) }, value } });
  return { element, body, dialog, click, type, focused, toasts };
}

test('the dialog edits, saves and asks; it keeps unsaved edits through polls, keeps focus inside, and never asks when the save failed', async () => {
  const node = { id: 'root', title: 'Root', ...comparison, criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }] };
  let map = { nodes: [node], jobs: [] }, failSave = false;
  const calls = [];
  const act = async (...args) => {
    calls.push(args);
    if (args[1] === 'set-criteria') { // As the Store does: refused on top of criteria saved elsewhere.
      if (failSave || criteriaKey(args[2].expected) !== criteriaKey(node.criteria)) return false;
      node.criteria = args[2].criteria.map((item, i) => ({ ...item, id: item.id ?? `crit-new0000${i}` }));
    }
    return true;
  };
  const io = fakeDialog({ map: () => map, act });
  try {
    await io.element('detail').fire('click', { target: { closest: selector => (selector === '[data-criteria-open]' ? { dataset: { criteriaOpen: 'root' } } : null) } });
    assert.equal(io.element('criteria-dialog').open, true); assert.match(io.body.innerHTML, /value="No signal"/);
    await io.click({ criterionAdd: '' });
    assert.equal(io.focused.at(-1), '#criterion-1', 'the new row takes focus');
    await io.type(1, 'Cheap');
    await io.body.fire('change', { target: { dataset: { criterionPriority: '1' }, value: 'low' } });
    map = { nodes: [node], jobs: [{ id: 'job-9', type: 'reconsider', nodeId: 'root', status: 'queued' }] };
    io.dialog.mapChanged();
    assert.doesNotMatch(io.body.innerHTML, /Queued for your agent/, 'a poll never overwrites unsaved edits');
    map = { nodes: [node], jobs: [] };
    await io.click({ criteriaSave: '' });
    assert.deepEqual(calls.at(-1), ['root', 'set-criteria', { criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }, { label: 'Cheap', priority: 'low' }], expected: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }] }]);
    assert.equal(io.focused.at(-1), '[data-criteria-save]'); assert.equal(io.toasts.at(-1), 'Criteria saved.');
    await io.click({ criterionRemove: '1' });
    assert.equal(io.focused.at(-1), '#criterion-0', 'focus moves to the row before');
    failSave = true;
    const asked = await io.click({ reconsiderAsk: '' });
    assert.deepEqual(calls.at(-1)[1], 'set-criteria'); assert.equal(calls.some(call => call[1] === 'reconsider'), false, 'nothing asked when the save failed');
    assert.equal(asked.disabled, false);
    failSave = false;
    await io.click({ reconsiderAsk: '' });
    assert.deepEqual(calls.slice(-2), [['root', 'set-criteria', { criteria: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }], expected: [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }, { id: 'crit-new00001', label: 'Cheap', priority: 'low' }] }], ['root', 'reconsider', {}]], 'unsaved edits are saved first');
    assert.equal(io.focused.at(-1), '[data-reconsider-ask]');
    // A finished proposal: typing the saved value back counts as unedited, so polls redraw again.
    map = { nodes: [node], jobs: [{ id: 'job-1', type: 'reconsider', nodeId: 'root', status: 'completed', input: { criteria: node.criteria }, result: revised(node) }] };
    await io.type(0, 'No signal at all');
    io.dialog.mapChanged(); assert.doesNotMatch(io.body.innerHTML, /Use revised comparison/);
    await io.type(0, 'No signal');
    io.dialog.mapChanged(); assert.match(io.body.innerHTML, /Use revised comparison/);
    const adopt = io.body.querySelector('[data-reconsider-adopt]'), note = io.body.querySelector('#criteria-adopt-note');
    await io.type(0, 'Edited');
    assert.equal(adopt.disabled, true); assert.equal(note.hidden, false, 'Use revised comparison waits for the edits');
    assert.equal(adopt.attributes['aria-describedby'], 'criteria-adopt-note', 'and says why');
    await io.type(0, 'No signal ');
    assert.equal(adopt.disabled, false, 'a trailing space is no edit, as in the Store'); assert.equal(note.hidden, true); assert.equal(adopt.attributes['aria-describedby'], undefined);
    await io.click({ reconsiderAdopt: 'job-1' }); assert.deepEqual(calls.at(-1), ['root', 'adopt-reconsideration', { jobId: 'job-1' }]); assert.equal(io.focused.at(-1), '#criteria-proposal');
    await io.click({ reconsiderDismiss: 'job-1' }); assert.deepEqual(calls.at(-1), ['root', 'dismiss-reconsideration', { jobId: 'job-1' }]); assert.equal(io.focused.at(-1), '[data-reconsider-ask]');
    // Untouched, the dialog follows criteria saved elsewhere (another tab, or a pull).
    node.criteria = [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }, { id: 'crit-cccccccc', label: 'Saved in another tab', priority: 'normal' }];
    io.dialog.mapChanged();
    assert.match(io.body.innerHTML, /value="Saved in another tab"/, 'an untouched dialog shows them');
    // Saved elsewhere while being edited: it says so, and nothing is overwritten.
    await io.type(0, 'Mine');
    node.criteria = [{ id: 'crit-aaaaaaaa', label: 'No signal', priority: 'high' }, { id: 'crit-bbbbbbbb', label: 'From the other tab', priority: 'low' }];
    io.dialog.mapChanged();
    assert.equal(io.body.querySelector('#criteria-elsewhere').hidden, false, 'it says so');
    await io.click({ criteriaSave: '' });
    assert.deepEqual(calls.at(-1)[2].expected.map(item => item.label), ['No signal', 'Saved in another tab'], 'the save carries what the edits started from');
    assert.equal(node.criteria[1].label, 'From the other tab', 'and the criteria saved elsewhere stay');
    await io.click({ criteriaReload: '' });
    assert.match(io.body.innerHTML, /value="From the other tab"/); assert.equal(io.focused.at(-1), '#criterion-0');
    // Focus never lands on a disabled control: with work waiting, Stop leaves Ask disabled, so the heading takes it.
    map = { nodes: [node], jobs: [{ id: 'job-2', type: 'reconsider', nodeId: 'root', status: 'queued' }, { id: 'job-3', type: 'reconsider', nodeId: 'root', status: 'queued' }] };
    io.dialog.mapChanged();
    io.body.querySelector('[data-reconsider-ask]').disabled = true;
    await io.click({ reconsiderStop: 'job-2' });
    assert.equal(io.focused.at(-1), '#criteria-title');
  } finally { delete globalThis.document; }
});

test('the CLI hands out a reconsider job with next, and checks and saves its result', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(path.join(root, 'criteria-cli-'));
  const app = await startServer({ workspace, port: 0 });
  const run = args => exec(process.execPath, [path.join(skill, 'scripts/cli.mjs'), ...args, '--workspace', workspace]);
  const cli = async args => JSON.parse((await run(args)).stdout);
  try {
    const map = await app.store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
    const first = await app.store.claim('agent', map.id);
    await app.store.complete(map.id, first.jobId, first.claimKey, { summary: 'Two ways to sync.', body: 'Details.', ...comparison });
    const act = async input => app.store.action(map.id, { expectedRevision: (await app.store.get(map.id)).revision, nodeId: map.rootId, ...input });
    await act({ type: 'set-criteria', criteria }); await act({ type: 'reconsider' });
    const job = await cli(['next', '--worker', 'test']);
    assert.equal(job.jobType, 'reconsider'); assert.equal(job.criteria.length, 2); assert.equal(job.claimKey, undefined, 'the CLI keeps the claim key');
    const node = (await app.store.get(map.id)).nodes[0], file = path.join(workspace, 'result.json');
    await writeFile(file, JSON.stringify({ ...revised(node), assessments: revised(node).assessments.slice(1) }));
    const failed = await run(['result', '--job', job.jobId, '--file', file, '--check']).then(() => null, error => error);
    assert.ok(failed, 'a failed check exits non-zero'); assert.match(failed.stderr, /every option and criterion/);
    await writeFile(file, JSON.stringify(revised(node)));
    assert.equal((await cli(['result', '--job', job.jobId, '--file', file, '--check'])).ok, true);
    assert.equal((await cli(['result', '--job', job.jobId, '--file', file])).saved, true);
    assert.equal(reconsiderationsOf(await app.store.get(map.id), map.rootId).latest.result.recommendation.optionId, 'lock');
  } finally { await app.close(); }
});
