import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { rankContext, terms, selectionKey, contextLimit } from '../skills/explore/scripts/relevance.mjs';
import { runNoteHtml } from '../skills/explore/assets/workspace-view.js';

// Relevant answers from elsewhere on the map (C13, #16). Illustrative fixtures only, never ideas/.
const node = (id, parentId, { title = id, prompt = `Premise of ${id}.`, questions = [], stale = false } = {}) =>
  ({ id, parentId, title, prompt, body: prompt, summary: prompt, kind: 'research', status: 'explored', reviewState: 'unreviewed', questions, sources: [], stale, contentRevision: 1 });
const answer = (id, text, value, answerState = 'decided', extra = {}) => ({ id, text, answer: value, answerState, ...extra });
const ids = list => list.map(entry => entry.node.id);

// root ─ a ─ sel (selected), with ideas elsewhere under the root.
function fixtureMap() {
  const nodes = [
    node('r', null, { title: 'Field notebook' }), node('a', 'r', { title: 'Storage' }),
    node('sel', 'a', { title: 'Sync conflicts', prompt: 'How do edits merge when tablets reconnect?' }),
    node('pre', 'r', { title: 'Device budget' }), node('pre2', 'r', { title: 'Procurement' }), node('link', 'r', { title: 'Paper backup' }),
    node('match1', 'r', { questions: [answer('q1', 'Who merges edits?', 'A lead merges tablets each evening.')] }),
    node('match2', 'r', { questions: [answer('q2', 'Which tablets?', 'Older tablets.', 'tentative')] }),
    node('other', 'r', { questions: [answer('q3', 'Budget?', 'Small.')] }), node('empty', 'r'),
  ];
  return { id: 'map-1', rootId: 'r', originalIdea: 'An offline field notebook for survey crews.', nodes,
    edges: [{ from: 'a', to: 'pre', type: 'depends_on' }, { from: 'pre', to: 'pre2', type: 'depends_on' }, { from: 'sel', to: 'link', type: 'related_to' }] };
}

test('the path comes first; then prerequisites, linked ideas, matching answers and other answers, in that order', () => {
  const map = fixtureMap(), { required, candidates } = rankContext(map, map.nodes[2]);
  assert.deepEqual(required.map(entry => [entry.node.id, entry.reasons]), [['r', ['The original idea']], ['a', ['On the path to this idea']]]);
  assert.deepEqual(ids(candidates), ['pre', 'pre2', 'link', 'match1', 'match2', 'other'], 'an idea with no answers and no link is not a candidate');
  const reasons = Object.fromEntries(candidates.map(entry => [entry.node.id, entry.reasons]));
  assert.deepEqual(reasons.pre, ['Explicit prerequisite']); assert.deepEqual(reasons.link, ['Linked: this branch related to it']);
  assert.deepEqual(reasons.match1, ['Matches branch terms']); assert.deepEqual(reasons.match2, ['Matches branch terms', 'Not settled yet']);
  assert.deepEqual(reasons.other, ['Answered elsewhere on the map']);
  assert.deepEqual(ids(rankContext(map, map.nodes[0]).required), [], 'the root has no path above it');
});

test('within a group, unsettled answers come first, then nearer ideas, then by ID; matches by how many words they share', () => {
  const map = fixtureMap();
  map.nodes.push(node('deep', 'other', { questions: [answer('q4', 'Who?', 'Nobody.', 'assumption')] }), node('zeta', 'r', { questions: [answer('q5', 'When?', 'Soon.')] }),
    node('alpha', 'r', { questions: [answer('q6', 'Where?', 'Here.')] }), node('old', 'r', { questions: [answer('q7', 'How?', 'Once.', 'decided', { supersededAt: '2026-01-01T00:00:00.000Z' })] }),
    node('flag', 'r', { stale: true, questions: [answer('q8', 'Why?', 'Because.')] }),
    node('both', 'r', { questions: [answer('q9', 'Merge?', 'Edits merge when tablets reconnect.')] }));
  const { candidates } = rankContext(map, map.nodes[2]);
  const rest = ids(candidates).filter(id => !['pre', 'pre2', 'link', 'match1', 'match2', 'both'].includes(id));
  assert.deepEqual(rest.slice(0, 3).sort(), ['deep', 'flag', 'old'], 'an Assumption, an earlier premise and a flagged idea are not settled');
  assert.deepEqual(rest.slice(0, 3), ['flag', 'old', 'deep'], 'nearer first among them: deep sits one level further down');
  assert.deepEqual(rest.slice(3), ['alpha', 'other', 'zeta'], 'settled ones by ID at the same distance');
  assert.deepEqual(ids(candidates).slice(3, 6), ['both', 'match1', 'match2'], 'more shared words rank higher');
  map.objective = 'Choose a procurement plan'; map.nodes.push(node('goal', 'r', { questions: [answer('q10', 'Plan?', 'The procurement plan is open.')] }));
  assert.deepEqual(rankContext(map, map.nodes[2]).candidates.find(entry => entry.node.id === 'goal').reasons, ['Matches the goal']);
  map.nodes.push(node('idea', 'r', { questions: [answer('q11', 'Crews?', 'Survey crews of nine.')] }));
  assert.deepEqual(rankContext(map, map.nodes[2]).candidates.find(entry => entry.node.id === 'idea').reasons, ['Matches the original idea']);
});

test('matching words are NFKC, lower case, letters and digits of three or more, without stopwords', () => {
  assert.deepEqual([...terms('The ﬁeld TEAMS sync, in 2 days and 100 km')].sort(), ['100', 'days', 'field', 'sync', 'teams']);
  assert.deepEqual([...terms('Équipe de terrain')], ['équipe', 'terrain'], 'letters beyond English');
});

// A saved map with the selected idea's investigation queued, through the Store.
async function storeWith(change) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'relevance-')), 'ideas'));
  let map = await store.create({ title: 'Field notebook', idea: 'An offline field notebook for survey crews.' });
  const first = await store.claim('agent', map.id);
  await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Started.', body: 'Findings.' });
  map = await store.get(map.id);
  const make = (title, prompt, parentId = map.rootId) => { const n = store.node(title, prompt, 'research', parentId); map.nodes.push(n); map.edges.push({ from: parentId, to: n.id, type: 'contains' }); return n; };
  const selected = make('Sync conflicts', 'How do edits merge when tablets reconnect?');
  const extra = change({ map, make, selected }) ?? {};
  await store.save(map);
  map = await store.action(map.id, { type: 'activate', nodeId: selected.id, expectedRevision: (await store.get(map.id)).revision });
  return { store, map, selected, job: map.jobs.find(job => job.nodeId === selected.id && job.status === 'queued'), ...extra };
}
const answered = (n, text, value, extra = {}) => { Object.assign(n, { status: 'explored', questions: [{ id: `q-${n.id.slice(5)}`, text, answer: value, answerState: 'decided', ...extra }] }); return n; };

test('an answer elsewhere that shares the branch\'s words is sent with its reason; a prerequisite outranks it when only one fits', async () => {
  const { store, map, job, matching, prerequisite } = await storeWith(({ map: m, make, selected }) => {
    const matching = answered(make('Evening routine', 'x'.repeat(500)), 'Who merges edits?', `A lead merges tablets each evening. ${'y'.repeat(400)}`);
    const prerequisite = make('Device budget', 'z'.repeat(500)), far = make('Procurement', 'w'.repeat(10));
    m.edges.push({ from: selected.id, to: far.id, type: 'depends_on' }, { from: far.id, to: prerequisite.id, type: 'depends_on' });
    return { matching, prerequisite };
  });
  const full = store.packet(map, job, { budget: 100000 });
  const sent = full.context.find(entry => entry.id === matching.id);
  assert.deepEqual(sent.reasons, ['Matches branch terms']); assert.equal(sent.answers[0].question, 'Who merges edits?');
  assert.equal(full.context[0].id, map.rootId, 'the original idea first');
  assert.match(full.selectionPolicy, /heuristic, not proof of relevance/);
  // Room for the prerequisite two links away, not for the match as well.
  const room = JSON.stringify(full).length - JSON.stringify(sent).length + 200;
  const tight = store.packet(map, job, { budget: room });
  assert.ok(tight.context.some(entry => entry.id === prerequisite.id && entry.reasons[0] === 'Explicit prerequisite'));
  assert.equal(tight.context.some(entry => entry.id === matching.id), false);
  assert.deepEqual(tight.omitted, [{ id: matching.id, title: 'Evening routine', reason: 'budget' }]); assert.equal(tight.omittedTotal, 1); assert.equal(tight.omittedContext, 1);
  assert.ok(tight.contextCharacters < room + 300, 'the budget, plus the few counts added after it');
});

test('over budget the lowest-ranked whole entries are left out and listed, a smaller later one still fits, and the path is kept', async () => {
  const { store, map, job, path: ancestors, first, second, small } = await storeWith(({ map: m, make, selected }) => {
    // Put the selected idea two levels down, so its path has an ancestor besides the root.
    const parent = make('Storage', 'Where notes live.'); selected.parentId = parent.id;
    m.edges = m.edges.filter(edge => !(edge.type === 'contains' && edge.to === selected.id)); m.edges.push({ from: parent.id, to: selected.id, type: 'contains' });
    const big = title => answered(make(title, 'p'.repeat(600)), 'How do edits merge?', `Edits merge by hand when tablets reconnect. ${'m'.repeat(900)}`);
    const first = big('Merge rules'), second = big('Merge timing'), small = answered(make('Budget', 'Tiny.'), 'Budget?', 'Small.');
    return { path: [m.rootId, parent.id], first, second, small };
  });
  // Room for the path, the first big entry and the small one, but not the second big one.
  const full = store.packet(map, job, { budget: 100000 }), sizeOf = id => JSON.stringify(full.context.find(entry => entry.id === id)).length;
  const [higher, lower] = full.context.slice(2, 4); // Equal matches, in ID order.
  assert.deepEqual([[higher.id, lower.id].sort(), full.context[4].id], [[first.id, second.id].sort(), small.id], 'two matches, then an answer elsewhere');
  const packet = store.packet(map, job, { budget: JSON.stringify(full).length - sizeOf(lower.id) + 150 });
  assert.deepEqual(packet.context.map(entry => entry.id), [...ancestors, higher.id, small.id], 'the second big entry is skipped and the smaller one after it still fits');
  assert.deepEqual(packet.omitted, [{ id: lower.id, title: lower.title, reason: 'budget' }]);
  const squeezed = store.packet(map, job, { budget: 6000 });
  assert.deepEqual(squeezed.context.slice(0, 2).map(entry => entry.id), ancestors, 'even a budget too small for much keeps the path, shortened');
  assert.ok(squeezed.omittedTotal >= 1); assert.ok(squeezed.omitted.every(entry => entry.reason === 'budget'));
  assert.ok(store.packet(map, job).contextCharacters < 16000);
  assert.equal(JSON.stringify(packet).includes('contextSelection'), false, 'the record of the choice is not sent');
});

test('a path a little too long for the packet is shortened, and nothing on it is left out', async () => {
  const { store, map, job, parent } = await storeWith(({ map: m, make, selected }) => {
    const parent = make('Storage', 'x'.repeat(1500)); selected.parentId = parent.id;
    m.edges = m.edges.filter(edge => !(edge.type === 'contains' && edge.to === selected.id)); m.edges.push({ from: parent.id, to: selected.id, type: 'contains' });
    return { parent };
  });
  const roomy = store.packet(map, job, { budget: 100000 });
  const packet = store.packet(map, job, { budget: JSON.stringify(roomy).length - 300 });
  assert.deepEqual(packet.context.map(entry => entry.id), [map.rootId, parent.id]);
  assert.match(packet.context[1].premise, /Shortened/); assert.ok(packet.context[1].premise.length < 300);
  assert.equal(packet.omittedContext, 0); assert.equal('omitted' in packet, false, 'nothing ranked, so no list to send');
});

test('past the most ideas one packet carries, the rest are listed as over the limit', async () => {
  const { store, map, job } = await storeWith(({ make }) => { for (let i = 0; i < contextLimit + 30; i++) answered(make(`N${i}`, 'P.'), 'Q?', 'A.'); });
  const packet = store.packet(map, job, { budget: 100000 }); // Room for all of them: only the limit stops them.
  assert.equal(packet.context.length, contextLimit); assert.equal(packet.omittedTotal, 31); assert.equal(packet.omitted.length, 20, 'at most 20 listed');
  assert.deepEqual([...new Set(packet.omitted.map(entry => entry.reason))], ['limit']);
});

test('the claimed job keeps what it was sent; a new answer elsewhere leaves the result current, a changed dependency does not', async () => {
  const { store, map, selected, elsewhere, dependency } = await storeWith(({ map: m, make, selected: chosen }) => {
    const elsewhere = answered(make('Paper backup', 'Paper.'), 'Paper?', 'Sometimes.');
    const dependency = make('Device budget', 'Budget.'); m.edges.push({ from: chosen.id, to: dependency.id, type: 'depends_on' });
    return { elsewhere, dependency };
  });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.selected.id, selected.id);
  let saved = await store.get(map.id);
  const job = saved.jobs.find(entry => entry.id === packet.jobId);
  assert.deepEqual(job.contextSelection.included.map(entry => entry.id), packet.context.map(entry => entry.id));
  assert.ok(job.contextSelection.included.find(entry => entry.id === dependency.id).reasons.includes('Explicit prerequisite'));
  assert.equal(job.contextSelection.omittedTotal, 0); assert.deepEqual(job.contextSelection.omitted, []);
  // Meanwhile the user answers in another branch.
  saved.nodes.find(n => n.id === elsewhere.id).questions[0].answer = 'Always.'; saved.nodes.find(n => n.id === elsewhere.id).contentRevision++; await store.save(saved);
  saved = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Done.', body: 'Merged.', questions: ['Who merges?'] });
  assert.notEqual(saved.jobs.find(entry => entry.id === packet.jobId).stale, true, 'an answer elsewhere is context, not a premise');
  saved = await store.action(map.id, { type: 'answer', nodeId: selected.id, questionId: saved.nodes.find(n => n.id === selected.id).questions[0].id, answer: 'A lead.', expectedRevision: saved.revision });
  const next = await store.claim('agent', map.id);
  saved = await store.get(map.id); saved.nodes.find(n => n.id === dependency.id).contentRevision++; await store.save(saved);
  saved = await store.complete(map.id, next.jobId, next.claimKey, { summary: 'Again.', body: 'Again.' });
  assert.equal(saved.jobs.find(entry => entry.id === next.jobId).stale, true, 'a changed dependency still does');
});

test('the inspector lists what the last run was sent and left out; an older job shows the size note only', () => {
  const map = { nodes: [{ id: 'node-a', title: 'Paper <backup>' }, { id: 'node-b', title: 'Budget' }] };
  const job = { contextCharacters: 4200, contextSelection: { included: [{ id: 'node-a', reasons: ['Explicit prerequisite', 'Not settled yet'] }, { id: 'node-gone', reasons: ['Linked: it supports this branch'] }],
    omitted: [{ id: 'node-b', reason: 'budget' }], omittedTotal: 3 } };
  const html = runNoteHtml(job, map);
  assert.match(html, /<p class="run-note">Last investigation used 4,200 characters of map context\./);
  assert.match(html, /<details class="context-sent" data-editor="context-sent"><summary>Context sent with the last run<\/summary>/);
  assert.match(html, /<button type="button" class="text-button" data-select="node-a">Paper &lt;backup&gt;<\/button> <span class="form-note">Explicit prerequisite; Not settled yet<\/span>/);
  assert.match(html, /<li>A removed idea <span class="form-note">Linked: it supports this branch<\/span><\/li>/);
  assert.match(html, /Left out, so your agent did not read them:[\s\S]*data-select="node-b">Budget<\/button> <span class="form-note">no room left in the packet[\s\S]*And 2 more\./);
  const older = runNoteHtml({ contextCharacters: 4200 }, map);
  assert.doesNotMatch(older, /context-sent/); assert.match(older, /4,200 characters/);
  assert.match(runNoteHtml({ contextSelection: { included: [], omitted: [], omittedTotal: 0 } }, map), /Nothing else from the map/);
});

test('ranking details: prerequisites by distance, unsettled first in every group, both sides of the tree, no idea twice', () => {
  const map = fixtureMap();
  // pre2 (two links away) becomes unsettled: link distance still comes first among prerequisites.
  map.nodes.find(n => n.id === 'pre2').questions = [answer('qp', 'Who buys?', 'Maybe the council.', 'tentative')];
  map.nodes.push(node('pre1b', 'r', { questions: [{ id: 'qb', text: 'When?', answer: 'Soon.' }] })); // How sure was never recorded.
  map.edges.push({ from: 'sel', to: 'pre1b', type: 'depends_on' }, { from: 'sel', to: 'a', type: 'depends_on' }); // An ancestor is never a candidate.
  map.nodes.push(node('link2', 'r', { questions: [answer('ql', 'Paper?', 'Sometimes.', 'assumption')] })); map.edges.push({ from: 'link2', to: 'sel', type: 'supports' });
  map.nodes.push(node('hop', 'r')); map.edges.push({ from: 'link', to: 'hop', type: 'supports' }); // A second hop, reached through the linked idea.
  map.nodes.push(node('dep-of-link', 'r')); map.edges.push({ from: 'link', to: 'dep-of-link', type: 'depends_on' });
  const { candidates } = rankContext(map, map.nodes[2]), reasons = Object.fromEntries(candidates.map(c => [c.node.id, c.reasons]));
  assert.deepEqual(ids(candidates).slice(0, 3), ['pre1b', 'pre', 'pre2'], 'one link away first; the unrecorded answer counts as unsettled among them');
  assert.deepEqual(reasons.pre1b, ['Explicit prerequisite', 'Not settled yet']);
  assert.equal(new Set(ids(candidates)).size, candidates.length, 'no idea is ranked twice'); assert.equal(ids(candidates).includes('a'), false);
  assert.deepEqual(ids(candidates.filter(c => c.group === 2)).slice(0, 1), ['link2'], 'an unsettled linked idea first');
  assert.deepEqual(reasons.link2, ['Linked: it supports this branch', 'Not settled yet']); assert.deepEqual(reasons.hop, ['Linked: Paper backup supports it']);
  assert.deepEqual(reasons['dep-of-link'], ['Linked: Paper backup depends on it'], 'how the walk reached it'); assert.deepEqual(reasons.link, ['Linked: this branch related to it'], 'no "Not settled yet" without answers');
  // Reached only through the closure (its link is listed before the one that brings the linked idea in).
  const closure = { id: 'm', rootId: 'r', originalIdea: '', nodes: [node('r', null), node('sel', 'r'), node('link', 'r', { title: 'Paper backup' }), node('dep', 'r')], edges: [{ from: 'link', to: 'dep', type: 'depends_on' }, { from: 'sel', to: 'link', type: 'related_to' }] };
  assert.deepEqual(Object.fromEntries(rankContext(closure, closure.nodes[1]).candidates.map(c => [c.node.id, c.reasons[0]])), { link: 'Linked: this branch related to it', dep: 'Prerequisite of Paper backup' });
  // Tree distance counts both sides: an idea under a sibling of the path is farther than the path's own sibling.
  const tree = { id: 'm', rootId: 'r', originalIdea: '', edges: [], nodes: [node('r', null), node('a', 'r'), node('sel', 'a'), node('near', 'a', { questions: [answer('q1', 'X?', 'Y.')] }), node('far', 'b', { questions: [answer('q2', 'X?', 'Y.')] }), node('b', 'r')] };
  assert.deepEqual(ids(rankContext(tree, tree.nodes[2]).candidates), ['near', 'far']);
  // Both sides count: an idea beside the selected one's grandparent is nearer than one beside the root, though both hang
  // one level below the ancestor they share with it.
  const deep = { id: 'm', rootId: 'r', originalIdea: '', edges: [], nodes: [node('r', null), node('a', 'r'), node('b', 'a'), node('c', 'b'), node('sel', 'c'), node('x', 'r', { questions: [answer('q1', 'X?', 'Y.')] }), node('y', 'c', { questions: [answer('q2', 'X?', 'Y.')] })] };
  assert.deepEqual(ids(rankContext(deep, deep.nodes[4]).candidates), ['y', 'x']);
});

test('matching reads titles, sent answers only, the branch title and the success criteria', () => {
  const map = { id: 'm', rootId: 'r', originalIdea: 'Plain words.', edges: [], nodes: [node('r', null), node('sel', 'r', { title: 'Tablets', prompt: 'How to merge?' })] };
  map.nodes.push(node('by-title', 'r', { title: 'Tablets in the van', questions: [answer('q1', 'Who?', 'Ana.')] }));
  map.nodes.push(node('old-only', 'r', { questions: [answer('q2', 'Merge?', 'Merge daily.', 'tentative'), answer('q3', 'A?', 'Lunch.'), answer('q4', 'B?', 'Lunch.'), answer('q5', 'C?', 'Lunch.')] }));
  map.successCriteria = 'A signed budget.'; map.nodes.push(node('criteria', 'r', { questions: [answer('q9', 'Budget?', 'Signed.')] }));
  const { candidates } = rankContext(map, map.nodes[1]), reasons = Object.fromEntries(candidates.map(c => [c.node.id, c.reasons]));
  assert.deepEqual(reasons['by-title'], ['Matches branch terms'], 'the other idea\'s title, and this branch\'s title');
  assert.deepEqual(reasons['old-only'], ['Answered elsewhere on the map'], 'an answer the packet does not send never earns a reason');
  assert.deepEqual(reasons.criteria, ['Matches the goal']);
});

// A map whose packet is nearly full, with the user's question feedback: rated questions on the root.
async function crowded({ linked = false, others = 6 } = {}) {
  return storeWith(({ map: m, make, selected }) => {
    m.nodes[0].questions = Array.from({ length: 10 }, (_, i) => ({ id: 'q-rated' + i, text: 'Rated question ' + i + ' ' + 'r'.repeat(150) + '?', answer: null, rating: 'bad', ratingReason: 'x'.repeat(250), ratedAt: '2026-01-01T00:00:00.000Z' }));
    for (let i = 0; i < others; i++) answered(make('Lunch menu ' + i, 'l'.repeat(600)), 'Soup?', 'Tomato. ' + 's'.repeat(280));
    if (linked) { const big = make('Paper backup', 'p'.repeat(600)); answered(big, 'Paper?', 'b'.repeat(300)); m.edges.push({ from: selected.id, to: big.id, type: 'related_to' }); }
    selected.prompt = selected.body = 'w'.repeat(2400); // A long premise fills much of the room.
  });
}

test('the user\'s question feedback gives way to the path, prerequisites and links, never to answers elsewhere', async () => {
  let { store, map, job } = await crowded();
  let packet = store.packet(map, job);
  assert.equal(packet.questionFeedback.length, 10, 'every rated question stays'); assert.equal(packet.omittedFeedback, 0);
  assert.ok(packet.omittedTotal > 0 && packet.omitted.every(entry => entry.reason === 'budget'), 'answers elsewhere take only what is left');
  ({ store, map, job } = await crowded({ linked: true, others: 0 }));
  const roomy = store.packet(map, job, { budget: 100000 }), link = roomy.context.find(entry => entry.reasons[0].startsWith('Linked'));
  packet = store.packet(map, job, { budget: JSON.stringify(roomy).length - JSON.stringify(roomy.questionFeedback[0]).length - 2 });
  assert.ok(packet.context.some(entry => entry.id === link.id), 'a linked idea is admitted'); assert.ok(packet.omittedFeedback >= 1, 'and feedback gave way to it');
});

test('every budget gives a packet within it, and no claim can hang', { timeout: 60000 }, async () => {
  const { store, map, job } = await crowded({ linked: true, others: 8 });
  const least = store.packet(map, job, { budget: 0 }).contextCharacters; // What no budget can go below: the idea's own premise and the instructions.
  for (let budget = 0; budget <= 16000; budget += 37) {
    const packet = store.packet(map, job, { budget });
    if (budget >= least) assert.ok(packet.contextCharacters <= budget + 200, budget + ': ' + packet.contextCharacters);
    assert.equal(packet.context[0].id, map.rootId, 'the root always stays');
  }
});

test('a path too long even as bare ideas loses its ideas farthest from here, listed first with reason path; the root stays', async () => {
  const { store, map, job, chain } = await storeWith(({ map: m, make, selected }) => {
    let parent = m.rootId; const chain = [];
    for (let i = 0; i < 60; i++) { const n = make('Level ' + i + ' ' + 't'.repeat(90), 'x', parent); chain.push(n.id); parent = n.id; }
    selected.parentId = parent; m.edges = m.edges.filter(edge => !(edge.type === 'contains' && edge.to === selected.id)); m.edges.push({ from: parent, to: selected.id, type: 'contains' });
    answered(make('Lunch menu', 'Soup.'), 'Soup?', 'Tomato.');
    return { chain };
  });
  const packet = store.packet(map, job, { budget: 9000 });
  assert.equal(packet.context[0].id, map.rootId); assert.equal(packet.context.at(-1).id, chain.at(-1), 'the parent stays');
  const kept = packet.context.slice(1).map(entry => chain.indexOf(entry.id));
  assert.deepEqual(kept, kept.toSorted((a, b) => a - b)); assert.ok(!packet.context.some(entry => entry.id === chain[0]), 'the farthest go first');
  assert.ok(packet.omittedTotal > 1); assert.equal(packet.omitted[0].reason, 'path', 'the path\'s own ideas are listed first'); assert.equal(packet.omitted[0].id, chain[0]);
  assert.ok(packet.omitted.every(entry => entry.title.length <= 80), 'titles clipped'); assert.ok(packet.omitted.length <= 20);
  const claimed = await store.claim('agent', map.id), saved = await store.get(map.id);
  assert.equal(saved.jobs.find(entry => entry.id === claimed.jobId).contextSelection.omittedTotal, claimed.omittedTotal, 'the job counts them all, not just those listed');
});

test('an ordinary packet carries no empty selection fields, and the inspector survives a changed record', async () => {
  let { store, map, job } = await storeWith(() => {});
  let packet = store.packet(map, job);
  assert.equal('selectionPolicy' in packet, false); assert.equal('omitted' in packet, false); assert.equal('omittedTotal' in packet, false);
  ({ store, map, job } = await storeWith(({ make }) => { answered(make('Budget', 'B.'), 'Budget?', 'Small.'); }));
  packet = store.packet(map, job);
  assert.match(packet.selectionPolicy, /heuristic/); assert.equal('omitted' in packet, false, 'nothing left out, so no list');
  const page = { nodes: [{ id: 'node-a', title: 'A' }] };
  for (const sent of [{ included: 'x' }, { included: [null, { id: 3 }] }, { included: [{ id: 'node-a', reasons: 'text' }] }, { omitted: [{ id: 'node-a', reason: 'constructor' }], omittedTotal: 1 }, { omittedTotal: 'many' }]) {
    assert.doesNotThrow(() => runNoteHtml({ contextSelection: sent }, page), JSON.stringify(sent));
  }
  assert.match(runNoteHtml({ contextSelection: { included: [], omitted: [{ id: 'node-a', reason: 'constructor' }], omittedTotal: 1 } }, page), /<span class="form-note">left out<\/span>/);
  assert.match(runNoteHtml({ contextSelection: { included: [{ id: 'node-a', reasons: ['<b>'] }], omitted: [], omittedTotal: 0 } }, page), /&lt;b&gt;/);
  assert.match(runNoteHtml({ contextSelection: { included: [], omitted: [{ id: 'node-a', reason: 'path' }], omittedTotal: 1 } }, page), /on the path here, but too far up to fit/);
  assert.match(await readFile('skills/explore/assets/app.js', 'utf8'), /runNoteHtml\(job, state\.visibleMap\)/, 'the app passes the map, so ideas show by name');
});
