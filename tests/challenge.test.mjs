import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { challengeDialogHtml, challengesOf, directionFrom, CHALLENGE } from '../skills/explore/assets/challenge.js';
import { challengeDialog } from '../skills/explore/assets/challenge-dialog.js';
import { proposalOutdated, CHECK_ANSWERS } from '../skills/explore/scripts/map-jobs.mjs';
import { toolsDialog } from '../skills/explore/assets/tools-dialog.js';

// Challenge decisions (F2, #25). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));

// A map with three saved answers on an idea that still has an open question, so its answers can change.
async function setup(store) {
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  await store.complete(map.id, first.jobId, first.claimKey, { summary: 'Depends.', body: 'Sync is the hard part.', questions: ['Who edits notes?', 'How often do teams sync?', 'Which phones?', 'Who pays?'] });
  const act = async input => store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: map.rootId, ...input });
  const questions = (await store.get(map.id)).nodes[0].questions;
  for (const [i, answer] of ['The field team.', 'Once a day.', 'Older Android phones.'].entries()) await act({ type: 'answer', questionId: questions[i].id, answer });
  const raw = async change => { const current = await store.get(map.id); change(current); await store.save(current); };
  return { map, act, questions, raw };
}
async function memoryStore() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = path.join(await mkdtemp(path.join(root, 'challenge-')), 'ideas');
  return { dir, store: new Store(dir) };
}
const finding = (questions, map, extra = {}) => ({ category: 'assumption', explanation: 'It assumes one team edits each note.', resolution: 'Ask whether two teams ever share a notebook.', refs: [{ nodeId: map.rootId, questionId: questions[0].id }], ...extra });
const content = map => JSON.stringify([map.nodes, map.edges, map.growth]);
// Many saved answers on one new idea, for the limits.
const manyAnswers = (count, length = 20) => current => {
  current.nodes.push({ id: 'node-many0000', title: 'Many', kind: 'research', status: 'explored', reviewState: 'unreviewed', summary: 'S', prompt: 'p', body: 'b', parentId: current.rootId, sources: [], contentRevision: 1, stale: false, createdAt: '2026-01-01T00:00:00.000Z',
    questions: Array.from({ length: count }, (_, i) => ({ id: `q-many${String(i).padStart(4, '0')}`, text: `Question ${i}?`, answer: `${i}${'a'.repeat(length)}` })) });
};
const many = count => Array.from({ length: count }, (_, i) => ({ nodeId: 'node-many0000', questionId: `q-many${String(i).padStart(4, '0')}` }));

test('a challenge needs 1–40 saved, current answers that fit, and its packet holds those and the original idea alone', async () => {
  const { store } = await memoryStore(), { map, act, questions, raw } = await setup(store);
  const before = await store.get(map.id);
  for (const [selection, message] of [[[], /Choose 1 to 40/], [undefined, /Choose 1 to 40/], [[{ nodeId: map.rootId, questionId: questions[3].id }], /not a saved answer/],
    [[{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[0].id }], /chosen twice/]]) {
    await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, ...(selection ? { selection } : {}) }), message, message.source);
  }
  assert.equal((await store.get(map.id)).revision, before.revision, 'the map is unchanged');
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[1].id }] });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, CHALLENGE);
  assert.deepEqual(packet.records.map(record => record.kind), ['idea', 'answer']);
  assert.equal(packet.records[1].answer, 'Once a day.'); assert.ok(['status', 'reviewState', 'stale', 'certainty', 'nodeTitle', 'question'].every(key => key in packet.records[1]));
  const text = JSON.stringify(packet);
  assert.equal(text.includes('The field team.'), false, 'an unselected answer never appears'); assert.equal(text.includes('Older Android phones.'), false);
  assert.match(packet.instruction, /good faith/); assert.match(packet.instruction, /Do not manufacture objections/); assert.match(packet.instruction, /never ask the user to change an answer/);
  assert.match(packet.resultFormat.limits, /at most 3 sources/);
  await store.fail(map.id, packet.jobId, packet.claimKey, 'Stopped for the test.');
  // Forty is the most, and forty long answers cannot fit: both refused before anything is queued.
  await raw(manyAnswers(41));
  await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, selection: many(41) }), /Choose 1 to 40/);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: many(40) });
  const forty = await store.claim('agent', map.id);
  assert.equal(forty.records.filter(record => record.kind === 'answer').length, 40);
  await store.fail(map.id, forty.jobId, forty.claimKey, 'Stopped for the test.');
  await raw(current => { current.nodes = current.nodes.filter(node => node.id !== 'node-many0000'); });
  await raw(manyAnswers(40, 900));
  const jobs = (await store.get(map.id)).jobs.length;
  await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, selection: many(40) }), /do not fit in one review/);
  assert.equal((await store.get(map.id)).jobs.length, jobs, 'nothing queued');
  // A premise revision sets the idea's answers aside: an earlier premise's answer cannot be chosen.
  await act({ type: 'revise', body: 'Notes for one field team.' });
  assert.ok((await store.get(map.id)).nodes[0].questions[1].supersededAt);
  await assert.rejects(act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[1].id }] }), /not a saved answer/);
});

test('a challenge whose answers were set aside before the agent took it fails with the reason, and is never read short', async () => {
  const { store } = await memoryStore(), { map, act, questions } = await setup(store);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[1].id }] });
  await act({ type: 'revise', body: 'Notes for one field team.' }); // Sets both answers aside while the challenge waits.
  const claimed = await store.claim('agent', map.id);
  assert.notEqual(claimed?.jobType, CHALLENGE, 'the agent never gets a challenge of fewer answers than the user chose');
  const job = (await store.get(map.id)).jobs.find(entry => entry.type === CHALLENGE);
  assert.equal(job.status, 'failed'); assert.match(job.error, /not a saved answer on this map, or a changed premise set it aside/);
  assert.match(challengeDialogHtml({ map: await store.get(map.id), esc, listening: false, live: true }), /Your agent could not challenge these answers\. A chosen record is not a saved answer/);
});

test('results are checked: four categories, refs from what was read, at most 12, valid sources; a valid one adds one unreviewed proposal and changes no idea', async () => {
  const { store } = await memoryStore(), { map, act, questions } = await setup(store);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }, { nodeId: map.rootId, questionId: questions[1].id }] });
  const packet = await store.claim('agent', map.id), before = await readFile(store.file(map.id), 'utf8'), shape = content(await store.get(map.id));
  const good = finding(questions, map), ref = { nodeId: map.rootId, questionId: questions[0].id };
  for (const [bad, message] of [[{ findings: [{ ...good, category: 'objection' }] }, /category must be/], [{ findings: [{ ...good, refs: [{ nodeId: map.rootId, questionId: questions[2].id }] }] }, /not read in this review/],
    [{ findings: Array.from({ length: 13 }, () => good) }, /at most 12/], [{ findings: [{ ...good, sources: [{ title: 'T', url: 'javascript:alert(1)', note: 'N' }] }] }, /URL|http/i],
    [{ findings: [{ ...good, sources: Array.from({ length: 4 }, (_, i) => ({ title: `T${i}`, url: `https://example.org/${i}`, note: 'N' })) }] }, /at most 3 sources/],
    [{ findings: [{ ...good, refs: [] }] }, /cites 1–8/], [{ findings: [{ ...good, refs: Array.from({ length: 9 }, () => ref) }] }, /cites 1–8/],
    [{ findings: [{ ...good, explanation: 'x'.repeat(1001) }] }, /explanation must be at most 1000/], [{ findings: [{ ...good, resolution: 'x'.repeat(1001) }] }, /settle it must be at most 1000/],
    [{ findings: [{ ...good, severity: 'high' }] }, /does not take: severity/], [{ findings: [], summary: 'S' }, /remove summary/]]) {
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, bad), error => error.status === 400 && message.test(error.message), message.source);
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { findings: [good, { ...good, category: 'evidence-gap', sources: [{ title: 'Field survey', url: 'https://example.org/survey', note: 'Teams share notebooks.' }] }] });
  const proposal = saved.proposals.at(-1);
  assert.equal(proposal.type, CHALLENGE); assert.equal(saved.proposals.length, 1);
  assert.deepEqual(proposal.items.map(item => [item.category, item.review]), [['assumption', 'unreviewed'], ['evidence-gap', 'unreviewed']]);
  assert.deepEqual(proposal.items[1].sources, [{ title: 'Field survey', url: 'https://example.org/survey', note: 'Teams share notebooks.' }]); assert.equal(proposal.items[0].sources, undefined);
  assert.equal(content(saved), shape, 'ideas, questions, links and growth are unchanged');
  const empty = await (async () => { await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }] }); const next = await store.claim('agent', map.id); return store.complete(map.id, next.jobId, next.claimKey, { findings: [] }); })();
  assert.deepEqual(empty.proposals.at(-1).items, [], 'nothing that matters is a fine result');
  // The brief names waiting hypotheses in words.
  const reviews = mapBrief(await store.get(map.id)).sections.find(section => section.id === 'reviews');
  assert.match(JSON.stringify(reviews), /Hidden assumption: It assumes one team/); assert.doesNotMatch(JSON.stringify(reviews), /evidence-gap:/);
});

test('keep and dismiss persist; a challenge is outdated when a challenged answer or its certainty changes, not when another question is answered', async () => {
  const { dir, store } = await memoryStore(), { map, act, questions } = await setup(store);
  await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[0].id }] });
  const packet = await store.claim('agent', map.id);
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { findings: [finding(questions, map), finding(questions, map, { category: 'alternative' })] });
  const proposal = saved.proposals.at(-1), stale = async () => store.view(await store.get(map.id)).proposals.find(entry => entry.id === proposal.id).stale === true;
  await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[0].id, decision: 'accepted' });
  await act({ type: 'review-proposal', proposalId: proposal.id, itemId: proposal.items[1].id, decision: 'dismissed' });
  const reloaded = await new Store(dir).get(map.id);
  assert.deepEqual(reloaded.proposals.at(-1).items.map(item => item.review), ['accepted', 'dismissed']);
  assert.equal(await stale(), false);
  await act({ type: 'answer', questionId: questions[3].id, answer: 'The county.' });
  assert.equal(await stale(), false, 'another answer on the same idea leaves it current');
  const round = await store.claim('agent', map.id); // That was the last open question, so the idea continues.
  await store.complete(map.id, round.jobId, round.claimKey, { summary: 'New findings.', body: 'More on sync.', questions: ['Who backs up the phones?'] });
  assert.equal(await stale(), false, 'and so do new findings on it');
  await act({ type: 'set-answer-state', questionId: questions[0].id, answerState: 'assumption' });
  assert.equal(await stale(), true, 'how sure the user is was part of what it read');
  const second = await (async () => { await act({ type: 'request-map-job', jobType: CHALLENGE, selection: [{ nodeId: map.rootId, questionId: questions[1].id }] }); const next = await store.claim('agent', map.id); return (await store.complete(map.id, next.jobId, next.claimKey, { findings: [finding(questions, map, { refs: [{ nodeId: map.rootId, questionId: questions[1].id }] })] })).proposals.at(-1); })();
  await act({ type: 'change-answer', questionId: questions[1].id, answer: 'Twice a day.' });
  assert.equal(store.view(await store.get(map.id)).proposals.find(entry => entry.id === second.id).stale, true, 'a changed answer');
});

test('the browser previews exactly the answers it will send', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const app = await startServer({ workspace: await mkdtemp(path.join(root, 'challenge-http-')), port: 0 });
  try {
    const { map, questions } = await setup(app.store);
    const { token } = await (await fetch(`${app.address}/api/session`)).json();
    const selection = [{ nodeId: map.rootId, questionId: questions[1].id }], shown = await app.store.get(map.id);
    const preview = await (await fetch(`${app.address}/api/maps/${map.id}/job-preview?type=${CHALLENGE}&selection=${encodeURIComponent(JSON.stringify(selection))}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    await app.store.action(map.id, { expectedRevision: (await app.store.get(map.id)).revision, type: 'request-map-job', jobType: CHALLENGE, selection });
    const claimed = await app.store.claim('agent', map.id);
    assert.deepEqual(preview.records, claimed.records, 'the preview is what the agent reads'); assert.equal(JSON.stringify(preview).includes('The field team.'), false);
    assert.match(challengeDialogHtml({ map: shown, esc, listening: false, live: true, chosen: selection, preview }), /<li>How often do teams sync\? <span class="form-note">Once a day\.<\/span><\/li>/, 'the dialog lists the exact answers');
  } finally { await app.close(); }
});

const fixture = () => {
  const map = { id: 'map-1', revision: 2, rootId: 'root', nodes: [{ id: 'root', title: 'Root <a>', questions: [{ id: 'q-1', text: 'Who <edits>?', answer: 'The team.' }, { id: 'q-2', text: 'How often?', answer: 'Daily.' }] }], jobs: [], proposals: [] };
  map.proposals.push({ id: 'proposal-1', type: CHALLENGE, items: [{ id: 'item-1', category: 'assumption', explanation: 'It <assumes> one team.', resolution: 'Ask.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'unreviewed' },
    { id: 'item-2', category: 'evidence-gap', explanation: 'No survey.', resolution: 'Survey.', refs: [{ nodeId: 'gone', questionId: 'q-9' }, { nodeId: 'root', questionId: 'q-1' }], sources: [{ title: 'Survey <1>', url: 'https://example.org/s', note: 'Says so.' }, { title: 'Odd', url: 'javascript:alert(1)', note: 'Pulled from Git.' }], review: 'accepted' },
    { id: 'item-3', category: 'counterargument', explanation: 'Teams rotate.', resolution: 'Check rosters.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'dismissed' },
    { id: 'item-4', category: 'alternative', explanation: 'Paper.', resolution: 'Try it.', refs: [{ nodeId: 'gone', questionId: 'q-9' }], review: 'accepted' }] });
  return map;
};

test('the dialog labels each hypothesis and says when it is reasoning; a kept one can be explored on an idea it cites that still exists', () => {
  const map = fixture(), html = challengeDialogHtml({ map, esc, listening: false, live: true });
  assert.match(html, /<h3 class="section-label">Hypotheses to consider<\/h3><p class="form-note">Your agent's challenge, not findings: your answers stay as they are\.<\/p>/);
  assert.match(html, /<strong>Hidden assumption<\/strong><p>It &lt;assumes&gt; one team\.<\/p><p><strong>What would settle it:<\/strong> Ask\.<\/p>/);
  assert.match(html, /data-select="root">Root &lt;a&gt; · Who &lt;edits&gt;\?<\/button>/, 'refs select the idea'); assert.match(html, /data-select="gone">A removed idea<\/button>/);
  assert.match(html, /<p class="form-note">Reasoning, not research\.<\/p>/); assert.match(html, /<a href="https:\/\/example\.org\/s" target="_blank" rel="noopener noreferrer">Survey &lt;1&gt;<\/a> · Says so\./);
  assert.match(html, /<li>Odd · Pulled from Git\.<\/li>/, 'only an http(s) source is a link'); assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /data-review-item="item-1" data-proposal="proposal-1" data-decision="accepted">Keep<\/button>/);
  assert.match(html, /Kept\. <button type="button" class="text-button" data-challenge-direction="item-2" data-proposal="proposal-1">Explore this as a direction<\/button>/);
  assert.doesNotMatch(html, /data-challenge-direction="item-(1|3|4)"/, 'only a kept one, and only while an idea it cites exists'); assert.match(html, /<strong>Counter-argument<\/strong>[\s\S]*<p class="review-decision">Dismissed\.<\/p>/);
  assert.match(html, /<input type="checkbox" data-challenge-node="root" data-challenge-question="q-1"> Who &lt;edits&gt;\?/); assert.match(html, /data-challenge-preview="" disabled>/);
  assert.match(challengeDialogHtml({ map: { ...map, proposals: [{ ...map.proposals[0], stale: true }] }, esc, listening: false, live: true }), /Answers you challenged changed since/);
  const history = challengeDialogHtml({ map, esc, listening: false, live: false });
  assert.match(history, /return to the live map/); assert.doesNotMatch(history, /data-(review-item|challenge-preview|challenge-direction)/);
  assert.deepEqual(directionFrom(map, map.proposals[0].items[1]), { nodeId: 'root', title: 'Evidence gap: No survey.', body: 'No survey.\n\nWhat would settle it: Survey.' }, 'the first cited idea that exists');
  assert.equal(directionFrom(map, map.proposals[0].items[3]), null);
  const long = directionFrom(map, { category: 'assumption', explanation: 'x'.repeat(200), resolution: 'R', refs: [{ nodeId: 'root' }] });
  assert.equal(long.title.length, 100); assert.match(long.title, /^Hidden assumption: x+…$/);
});

test('earlier challenges stay reachable while a point waits or is kept; progress and failure show, and only challenge work counts', () => {
  const map = fixture();
  map.proposals.push({ id: 'proposal-2', type: CHALLENGE, items: [{ id: 'item-5', category: 'alternative', explanation: 'Newer.', resolution: 'R.', refs: [{ nodeId: 'root', questionId: 'q-2' }], review: 'unreviewed' }] });
  map.proposals.unshift({ id: 'proposal-0', type: CHALLENGE, items: [{ id: 'item-0', category: 'alternative', explanation: 'All dismissed.', resolution: 'R.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'dismissed' }] });
  map.proposals.push({ id: 'proposal-c', type: 'check-answers', items: [{ id: 'item-c', category: 'possible-tension', explanation: 'A check point.', resolution: 'R.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'unreviewed' }] });
  const { latest, earlier } = challengesOf(map);
  assert.equal(latest.id, 'proposal-2'); assert.deepEqual(earlier.map(proposal => proposal.id), ['proposal-1'], 'one with nothing left open or kept is not offered');
  let html = challengeDialogHtml({ map, esc, listening: false, live: true });
  assert.match(html, /Newer\.[\s\S]*<details class="challenge-earlier"><summary>Earlier challenges \(1\)<\/summary>[\s\S]*It &lt;assumes&gt; one team[\s\S]*data-challenge-direction="item-2" data-proposal="proposal-1"/);
  assert.doesNotMatch(html, /Teams rotate|All dismissed|A check point/, 'dismissed points and other reviews stay out');
  map.jobs = [{ id: 'job-i', status: 'queued' }, { id: 'job-c', type: 'check-answers', status: 'running' }];
  assert.doesNotMatch(challengeDialogHtml({ map, esc, listening: false, live: true }), /data-challenge-stop/, 'an investigation or a check is not a challenge in progress');
  map.jobs.push({ id: 'job-1', type: CHALLENGE, status: 'queued' });
  html = challengeDialogHtml({ map, esc, listening: false, live: true });
  assert.match(html, /Queued for your agent\. <button type="button" class="text-button" data-challenge-stop="job-1">Stop<\/button>/); assert.doesNotMatch(html, /Challenge answers<\/h3>/, 'one challenge at a time');
  assert.match(challengeDialogHtml({ map, esc, listening: true, live: true }), /Your agent will pick this up next\./);
  map.jobs[2].status = 'running';
  assert.match(challengeDialogHtml({ map, esc, listening: true, live: true }), /Your agent is challenging these answers\./);
  map.jobs[2] = { id: 'job-1', type: CHALLENGE, status: 'failed', error: 'Too <long>.' };
  html = challengeDialogHtml({ map, esc, listening: false, live: true });
  assert.match(html, /Your agent could not challenge these answers\. Too &lt;long&gt;\./); assert.match(html, /Challenge answers<\/h3>/, 'a failure leaves the choice open');
  assert.match(challengeDialogHtml({ map: { ...map, jobs: [{ id: 'job-2', type: CHALLENGE, status: 'interrupted' }] }, esc, listening: false, live: true }), /It stopped before it finished\./);
});

function fakeDialog({ map, act, api, explored, selected = [] }) {
  const elements = new Map(), focused = [], toasts = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {}, found = new Map();
      elements.set(id, { id, innerHTML: '', open: false, addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(`#${id}`); }, contains: () => false,
        querySelector(selector) {
          // An element's tag must carry every attribute the selector names, as `[a="x"][b="y"]` does.
          const has = (tag, part) => (part.includes('=') ? tag.includes(part) : new RegExp(`\\s${part}[\\s=>]`).test(tag));
          const present = selector.startsWith('#') ? this.innerHTML.includes(`id="${selector.slice(1)}"`)
            : (this.innerHTML.match(/<[^>]+>/g) ?? []).some(tag => selector.match(/\[[^\]]+\]/g).every(part => has(tag, part.slice(1, -1))));
          if (!present) return null;
          if (!found.has(selector)) found.set(selector, { disabled: false, focus() { focused.push(selector); } });
          return found.get(selector);
        } });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), activeElement: null };
  const dialog = challengeDialog({ map, act, api, esc, toast: message => toasts.push(message), live: () => true, listening: () => false, select: id => selected.push(id), exploreAsDirection: direction => explored.push(direction) });
  const body = element('challenge-body');
  const click = dataset => body.fire('click', { target: { closest: () => ({ dataset, disabled: false }) } });
  const tick = (nodeId, questionId, checked = true) => body.fire('change', { target: { closest: () => ({ dataset: { challengeNode: nodeId, challengeQuestion: questionId }, checked }) } });
  return { element, body, dialog, click, tick, focused, toasts };
}

test('the dialog previews and queues the chosen answers, and Explore this as a direction opens the form without queueing anything', async () => {
  let map = fixture();
  const calls = [], routes = [], explored = [], selected = [];
  const io = fakeDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; }, api: async route => { routes.push(route); return { records: [{ kind: 'idea' }, { kind: 'answer', question: 'Who <edits>?', answer: 'The team.' }], mapRevision: map.revision }; }, explored, selected });
  const previewOf = selection => `/maps/map-1/job-preview?type=challenge&selection=${encodeURIComponent(JSON.stringify(selection))}`;
  try {
    await io.element('challenge-open').fire('click');
    assert.equal(io.element('challenge-dialog').open, true); assert.equal(io.focused.at(-1), '[data-review-item]');
    await io.tick('root', 'q-1'); await io.tick('root', 'q-2'); await io.tick('root', 'q-2', false);
    await io.click({ challengePreview: '' });
    assert.equal(routes.at(-1), previewOf([{ nodeId: 'root', questionId: 'q-1' }]), 'an unticked answer is not sent');
    assert.match(io.body.innerHTML, /Your agent will read the original idea and 1 answer, with the map's title/); assert.match(io.body.innerHTML, /<li>Who &lt;edits&gt;\?/); assert.equal(io.focused.at(-1), '[data-challenge-send]');
    // A poll with a new revision drops the preview: it described the map as it was.
    map = { ...fixture(), revision: 3 }; io.dialog.mapChanged();
    assert.doesNotMatch(io.body.innerHTML, /data-challenge-send/); assert.match(io.body.innerHTML, /data-challenge-preview="">/, 'the choice is kept');
    await io.click({ challengePreview: '' });
    await io.click({ challengeSend: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: CHALLENGE, selection: [{ nodeId: 'root', questionId: 'q-1' }] }]);
    assert.match(io.body.innerHTML, /data-challenge-preview="" disabled>/, 'the choice is cleared after sending');
    await io.click({ reviewItem: 'item-1', proposal: 'proposal-1', decision: 'accepted' });
    assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'accepted' }]); assert.equal(io.toasts.at(-1), 'Kept.');
    map.jobs = [{ id: 'job-1', type: CHALLENGE, status: 'queued' }]; io.dialog.mapChanged();
    await io.click({ challengeStop: 'job-1' });
    assert.deepEqual(calls.at(-1), [null, 'cancel-job', { jobId: 'job-1' }]);
    await io.click({ select: 'root' });
    assert.deepEqual(selected, ['root']); assert.equal(io.element('challenge-dialog').open, false, 'a reference opens its idea');
    map.jobs = []; await io.tick('root', 'q-2');
    await io.element('challenge-open').fire('click');
    assert.match(io.body.innerHTML, /data-challenge-preview="" disabled>/, 'opening again starts with nothing chosen');
    const before = calls.length;
    await io.click({ challengeDirection: 'item-2', proposal: 'proposal-1' });
    assert.deepEqual(explored, [{ nodeId: 'root', title: 'Evidence gap: No survey.', body: 'No survey.\n\nWhat would settle it: Survey.' }]); assert.equal(calls.length, before, 'nothing queued or written');
    assert.equal(io.element('challenge-dialog').open, false, 'the dialog makes way for the form');
  } finally { delete globalThis.document; }
});

test('the choice drops answers no longer offered, a late preview of an older choice is ignored, and focus stays on the same box', async () => {
  let map = fixture(), release;
  const routes = [];
  const io = fakeDialog({ map: () => map, act: async () => true, explored: [],
    api: route => { routes.push(route); return new Promise(resolve => { release = () => resolve({ records: [{ kind: 'idea' }, { kind: 'answer', question: 'Q', answer: 'A' }], mapRevision: map.revision }); }); } });
  try {
    await io.element('challenge-open').fire('click');
    await io.tick('root', 'q-1');
    const asked = io.click({ challengePreview: '' });
    await io.tick('root', 'q-2'); // Changed while the preview was on its way.
    release(); await asked;
    assert.doesNotMatch(io.body.innerHTML, /data-challenge-send/, 'that preview is not of this choice');
    // A redraw while the second answer's box has focus brings focus back to that box.
    globalThis.document.activeElement = { id: '', dataset: { challengeNode: 'root', challengeQuestion: 'q-2' } }; io.body.contains = element => !!element;
    map = { ...map, revision: 5, nodes: [{ ...map.nodes[0], title: 'Root renamed' }] }; io.dialog.mapChanged();
    assert.equal(io.focused.at(-1), '[data-challenge-node="root"][data-challenge-question="q-2"]');
    globalThis.document.activeElement = null; io.body.contains = () => false;
    // The first answer is set aside elsewhere: it leaves the choice.
    map = { ...map, revision: 6, nodes: [{ ...map.nodes[0], questions: [{ ...map.nodes[0].questions[0], supersededAt: '2026-11-28T00:00:00.000Z' }, map.nodes[0].questions[1]] }] }; io.dialog.mapChanged();
    const sent = io.click({ challengePreview: '' }); release(); await sent;
    assert.equal(routes.at(-1), `/maps/map-1/job-preview?type=challenge&selection=${encodeURIComponent(JSON.stringify([{ nodeId: 'root', questionId: 'q-2' }]))}`);
  } finally { delete globalThis.document; }
});

test('a direction from a hypothesis is added only when the user submits Add a direction, and stays inactive', async () => {
  const { store } = await memoryStore(), { map, act } = await setup(store);
  const jobs = (await store.get(map.id)).jobs.length;
  const direction = directionFrom(await store.get(map.id), { category: 'alternative', explanation: 'Paper backup.', resolution: 'Test a flat phone.', refs: [{ nodeId: map.rootId, questionId: 'q' }] });
  const saved = await act({ type: 'suggest', title: direction.title, body: direction.body });
  const added = saved.nodes.at(-1);
  assert.deepEqual([added.title, added.status, added.parentId], ['Overlooked alternative: Paper backup.', 'suggested', map.rootId]); assert.equal(saved.jobs.length, jobs, 'no job queued');
});

test('revising the idea of a challenged answer outdates the challenge; a whole-map check is outdated only by a question it read', async () => {
  const { store } = await memoryStore(), { map, act, questions, raw } = await setup(store);
  const run = async (jobType, input) => { await act({ type: 'request-map-job', jobType, ...input }); const job = await store.claim('agent', map.id); return (await store.complete(map.id, job.jobId, job.claimKey, { findings: [] })).proposals.at(-1); };
  const stale = async proposal => store.view(await store.get(map.id)).proposals.find(entry => entry.id === proposal.id).stale === true;
  const check = await run(CHECK_ANSWERS, {});
  await act({ type: 'answer', questionId: questions[3].id, answer: 'The county.' });
  assert.equal(await stale(check), true, 'an open question it read was answered');
  const round = await store.claim('agent', map.id); // That answer continued the idea.
  await store.complete(map.id, round.jobId, round.claimKey, { summary: 'More.', body: 'More.', questions: ['Who backs up the phones?', 'Where are backups kept?'] });
  const whole = await run(CHECK_ANSWERS, {}); // Reads those two open questions too.
  await raw(current => { current.nodes[0].contentRevision++; }); // The idea changed, but no question it read did.
  assert.equal(await stale(whole), false, 'an open question it read is keyed by itself, not by its idea');
  const challenge = await run(CHALLENGE, { selection: [{ nodeId: map.rootId, questionId: questions[0].id }] });
  const newer = (await store.get(map.id)).nodes[0].questions.at(-1);
  await act({ type: 'answer', questionId: newer.id, answer: 'In the van.' });
  assert.equal(await stale(challenge), false, 'a question the challenge did not read');
  await act({ type: 'revise', body: 'Notes for one field team.' });
  assert.equal(await stale(challenge), true, 'a changed premise sets the challenged answer aside');
  // A record saved before questions were keyed falls back to its idea's revision.
  const old = { nodes: [{ id: 'n', contentRevision: 2, questions: [{ id: 'q', text: 'Q?', answer: 'A.' }] }] };
  assert.equal(proposalOutdated(old, { included: [{ nodeId: 'n', questionId: 'q', contentRevision: 1 }] }), true);
  assert.equal(proposalOutdated(old, { included: [{ nodeId: 'n', questionId: 'q', contentRevision: 2 }] }), false);
});

test('a changed choice drops its preview, ticks survive a redraw, Keep moves focus to the new direction, and an earlier kept point can be explored', async () => {
  let map = fixture();
  map.proposals.push({ id: 'proposal-2', type: CHALLENGE, items: [{ id: 'item-9', category: 'alternative', explanation: 'Newest.', resolution: 'R.', refs: [{ nodeId: 'root', questionId: 'q-2' }], review: 'unreviewed' }] });
  map.proposals.unshift({ id: 'proposal-0', type: CHALLENGE, items: [{ id: 'item-0', category: 'alternative', explanation: 'Oldest kept.', resolution: 'R.', refs: [{ nodeId: 'root', questionId: 'q-1' }], review: 'accepted' }] });
  assert.deepEqual(challengesOf(map).earlier.map(proposal => proposal.id), ['proposal-1', 'proposal-0'], 'earlier challenges newest first');
  const explored = [];
  const act = async (_, type, input) => { if (type === 'review-proposal') { map = structuredClone(map); map.proposals.find(p => p.id === input.proposalId).items.find(i => i.id === input.itemId).review = input.decision; } return true; };
  const io = fakeDialog({ map: () => map, act, explored, api: async () => ({ records: [{ kind: 'idea' }, { kind: 'answer', question: 'Q', answer: 'A' }], mapRevision: map.revision }) });
  try {
    await io.element('challenge-open').fire('click');
    await io.tick('root', 'q-1'); await io.click({ challengePreview: '' });
    assert.match(io.body.innerHTML, /data-challenge-question="q-1" checked>/, 'a ticked answer stays ticked through the redraw');
    await io.tick('root', 'q-2');
    assert.doesNotMatch(io.body.innerHTML, /data-challenge-send/, 'a changed choice needs a new preview');
    await io.click({ reviewItem: 'item-9', proposal: 'proposal-2', decision: 'accepted' });
    assert.equal(io.focused.at(-1), '[data-challenge-direction="item-9"]', 'focus moves to what Keep offers next');
    await io.click({ challengeDirection: 'item-0', proposal: 'proposal-0' });
    assert.deepEqual(explored, [{ nodeId: 'root', title: 'Overlooked alternative: Oldest kept.', body: 'Oldest kept.\n\nWhat would settle it: R.' }]);
  } finally { delete globalThis.document; }
});

test('Map tools checks chosen answers, stops and reviews through the app, and redraws only while open', async () => {
  const elements = {}, element = id => (elements[id] ??= { id, innerHTML: '', open: false, handlers: {}, addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }, showModal() { this.open = true; }, close() { this.open = false; } });
  const boxes = [{ dataset: { choiceNode: 'root', choiceQuestion: 'q-1' } }];
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')), querySelectorAll: () => boxes };
  const calls = [], routes = [], map = fixture(); let opened = 0;
  try {
    const tools = toolsDialog({ map: () => map, act: async (...args) => { calls.push(args); return true; }, api: async route => { routes.push(route); return { records: [], omittedRecords: [] }; }, esc, toast: () => {}, listening: () => false, onOpen: () => opened++ });
    await tools.mapChanged();
    assert.equal(routes.length, 0, 'nothing drawn while closed');
    element('show-tools').handlers.click[0]();
    assert.equal(element('tools-dialog').open, true); assert.equal(opened, 1);
    assert.match(element('tools-choices').innerHTML, /<input type="checkbox" data-choice-node="root" data-choice-question="q-1"> Who &lt;edits&gt;\?/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(routes, ['/maps/map-1/job-preview?type=check-answers']); assert.match(element('tools-body').innerHTML, /data-check-answers/);
    const click = dataset => element('tools-dialog').handlers.click[0]({ target: { closest: () => ({ dataset, disabled: false }) } });
    await click({ checkAnswers: '' });
    assert.deepEqual(calls.at(-1), [null, 'request-map-job', { jobType: 'check-answers', selection: [{ nodeId: 'root', questionId: 'q-1' }] }]);
    await click({ cancelJob: 'job-1' }); assert.deepEqual(calls.at(-1), [null, 'cancel-job', { jobId: 'job-1' }]);
    await click({ reviewItem: 'item-1', proposal: 'proposal-1', decision: 'dismissed' }); assert.deepEqual(calls.at(-1), [null, 'review-proposal', { proposalId: 'proposal-1', itemId: 'item-1', decision: 'dismissed' }]);
    await click({ select: 'root' }); assert.equal(element('tools-dialog').open, false, 'a reference closes it for the page to open that idea');
  } finally { delete globalThis.document; }
});
