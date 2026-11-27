import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store, isCompleted } from '../skills/explore/scripts/store.mjs';
import { questionMenuHtml, questionResearchHtml, researchSuggestion } from '../skills/explore/assets/workspace-view.js';
import { questionJobs, RESEARCH } from '../skills/explore/assets/questions.js';

// Help me answer (B9, #10). Illustrative fixtures under .test-output, never ideas/.
async function asked(questions = ['Which sync model fits?', 'Who edits notes?']) {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'qresearch-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent');
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends on the field.', body: 'Sync is the hard part.', questions });
  const act = async input => { const current = await store.get(map.id); return store.action(map.id, { expectedRevision: current.revision, nodeId: map.rootId, ...input }); };
  return { store, map: saved, act, question: saved.nodes[0].questions[0] };
}
const researchJobs = map => map.jobs.filter(job => job.type === 'question-research');
const options = [
  { id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.', pros: ['No conflicts to resolve'], cons: ['Harder to build'], suggestedAnswer: 'I want edits merged automatically.' },
  { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' },
];
const result = { options, recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' }, summary: 'Two workable models.',
  sources: [{ title: 'Local-first software', url: 'https://example.org/local-first', note: 'Compares sync models.' }] };

test('Help me answer queues one research job and leaves the branch alone', async () => {
  const { map, act, question } = await asked();
  let saved = await act({ type: 'request-research', questionId: question.id });
  assert.equal(researchJobs(saved).length, 1);
  assert.equal(researchJobs(saved)[0].subjectId, question.id);
  assert.equal(saved.nodes[0].status, 'awaiting-answer'); assert.equal(saved.nodes[0].contentRevision, map.nodes[0].contentRevision);
  saved = await act({ type: 'request-research', questionId: question.id });
  assert.equal(researchJobs(saved).length, 1, 'a repeat request reuses the open job');
});

test('the agent gets the question, its idea, the findings and the ideas around it, under the packet budget', async () => {
  const { store, map } = await asked();
  // A long chain of ancestors above the idea whose question is researched.
  let parent = map.rootId, saved = map;
  for (let i = 0; i < 30; i++) {
    saved = await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: parent, type: 'suggest', title: `Level ${i}`, body: 'x'.repeat(1200) });
    parent = saved.nodes.at(-1).id;
  }
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: parent, type: 'activate' });
  const job = await store.claim('agent', map.id);
  saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Deep.', body: 'Sync is the hard part down here.', questions: ['Which sync model fits?'] });
  const deep = saved.nodes.find(n => n.id === parent);
  await store.action(map.id, { expectedRevision: saved.revision, nodeId: parent, type: 'request-research', questionId: deep.questions[0].id });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'question-research');
  assert.deepEqual(packet.question, { id: deep.questions[0].id, text: 'Which sync model fits?' });
  assert.equal(packet.node.id, parent); assert.match(packet.node.findings, /Sync is the hard part down here/);
  assert.ok(packet.context.length > 0 && packet.omittedContext > 0, 'nearby ideas are included until the budget, and the rest are counted');
  assert.match(packet.instruction, /Do not answer for the user/);
  assert.match(packet.instruction, /Do not ask questions or propose branches/);
  assert.ok(packet.contextCharacters <= 15500);
});

test('research carries the current answer and the user\'s other answers on the idea, with how sure they are', async () => {
  const { store, map, act, question } = await asked();
  const other = map.nodes[0].questions[1];
  await act({ type: 'answer', questionId: question.id, answer: 'Merge automatically.' });
  await act({ type: 'answer', questionId: other.id, answer: 'Two of us.', answerState: 'decided' });
  await store.claim('agent', map.id); // The branch's continuation, queued by the last answer.
  await act({ type: 'request-research', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  assert.equal(packet.jobType, 'question-research');
  assert.deepEqual(packet.question, { id: question.id, text: 'Which sync model fits?', currentAnswer: 'Merge automatically.' });
  assert.deepEqual(packet.node.answers, [{ question: 'Who edits notes?', answer: 'Two of us.', answerState: 'decided' }]);
});

test('nearby ideas come nearest first, keep their review state and certainty, and the farthest are left out first', async () => {
  const { store, map } = await asked();
  let parent = map.rootId, saved = map;
  for (let i = 0; i < 30; i++) {
    saved = await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: parent, type: 'suggest', title: `Level ${i}`, body: 'x'.repeat(1200) });
    parent = saved.nodes.at(-1).id;
  }
  const chain = saved.nodes.slice(1).map(n => n.id);
  await store.action(map.id, { expectedRevision: (await store.get(map.id)).revision, nodeId: parent, type: 'activate' });
  const run = await store.claim('agent', map.id);
  saved = await store.complete(map.id, run.jobId, run.claimKey, { summary: 'Deep.', body: 'Sync is hard here.', questions: ['Which sync model fits?'] });
  await store.action(map.id, { expectedRevision: saved.revision, nodeId: parent, type: 'request-research', questionId: saved.nodes.find(n => n.id === parent).questions[0].id });
  const packet = await store.claim('agent', map.id);
  const ids = packet.context.map(n => n.id);
  assert.equal(ids[0], map.rootId, 'the original idea first');
  assert.equal(ids[1], chain.at(-2), 'then the direct parent');
  assert.ok(!ids.includes(chain[0]), 'the farthest are left out');
  assert.equal(packet.omittedContext, chain.length - 1 - (ids.length - 1));
  assert.equal(packet.context[0].reviewState, 'unreviewed'); assert.equal(packet.context[0].stale, false);
  assert.ok(packet.context[0].answers.every(a => a.answerState), 'answers keep how sure they are');
  // An investigation packet orders its context the same way.
  const investigation = store.packet(await store.get(map.id), { id: 'job-x', nodeId: parent, reason: 'r' }, { claimKey: 'k' });
  assert.equal(investigation.context[0].id, map.rootId); assert.equal(investigation.context[1].id, chain.at(-2));
});

test('research is checked like options and stays on the job, never as an answer', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-research', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  const before = await store.get(map.id);
  for (const extra of [{ questions: ['More?'] }, { suggestions: [{ title: 'x', body: 'y' }] }, { links: [] }, { answer: 'Merge.' }, { body: 'Findings.' }])
    await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { ...result, ...extra }), error => error.status === 400, Object.keys(extra)[0]);
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'No options.' }), error => error.status === 400, 'options are required');
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { options }), error => error.status === 400, 'a recommendation is required');
  await assert.rejects(store.complete(map.id, packet.jobId, packet.claimKey, { ...result, sources: [{ title: 'x', url: 'javascript:alert(1)', note: 'y' }] }), error => error.status === 400);
  assert.equal((await store.get(map.id)).revision, before.revision, 'rejected results change nothing');
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, result);
  const job = researchJobs(saved)[0];
  assert.equal(job.status, 'completed'); assert.equal(job.stale, false);
  assert.equal(job.result.recommendation.optionId, 'crdt'); assert.equal(job.result.options[0].suggestedAnswer, 'I want edits merged automatically.');
  assert.equal(job.result.sources[0].url, 'https://example.org/local-first');
  const node = saved.nodes[0];
  assert.equal(node.status, 'awaiting-answer'); assert.equal(isCompleted(saved, node), false);
  assert.equal(node.questions[0].answer, null); assert.equal(node.options, undefined, 'the branch keeps its own comparison');
  assert.equal(node.summary, 'Depends on the field.');
  assert.equal(questionJobs(saved.jobs, RESEARCH, question.id).latest.id, job.id);
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /### Which sync model fits\?\n\n_Awaiting the user._\n\n_Agent research to help you answer, not your answer._/);
  assert.match(markdown, /Merge edits automatically \(crdt\)/);
  assert.match(markdown, /Recommended: Merge edits automatically/);
});

test('"No recommendation yet" is a valid research result', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-research', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { options, recommendation: { optionId: null, missing: 'How many people edit one note.' } });
  assert.deepEqual(researchJobs(saved)[0].result.recommendation, { optionId: null, missing: 'How many people edit one note.' });
});

test('a failed, stopped or interrupted research job leaves the idea as it was', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-research', questionId: question.id });
  let packet = await store.claim('agent', map.id);
  let saved = await store.fail(map.id, packet.jobId, packet.claimKey, 'No sources.');
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  saved = await act({ type: 'request-research', questionId: question.id });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'cancel-job', jobId: researchJobs(saved).at(-1).id });
  assert.equal(saved.nodes[0].status, 'awaiting-answer');
  await act({ type: 'request-research', questionId: question.id });
  packet = await store.claim('agent', map.id);
  await new Store(store.directory).recover();
  saved = await store.get(map.id);
  assert.equal(researchJobs(saved).at(-1).status, 'interrupted'); assert.equal(saved.nodes[0].status, 'awaiting-answer');
  assert.equal(saved.nodes[0].summary, 'Depends on the field.'); assert.equal(isCompleted(saved, saved.nodes[0]), false);
});

test('research becomes earlier research when its context changes after it arrived, in the view and in Markdown', async () => {
  const { store, map, act, question } = await asked();
  await act({ type: 'request-research', questionId: question.id });
  const packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, result);
  assert.equal(researchJobs(store.view(await store.get(map.id)))[0].stale, false);
  await act({ type: 'answer', questionId: map.nodes[0].questions[1].id, answer: 'Only me.' });
  const view = store.view(await store.get(map.id));
  assert.equal(researchJobs(view)[0].stale, true, 'the view checks again');
  assert.equal(researchSuggestion(view.jobs, researchJobs(view)[0].id, 'crdt'), null, 'and copy is no longer offered');
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /_Earlier agent research, from before the question or its context changed\. Not your answer\._/);
});

test('an empty or null summary counts as no summary', async () => {
  for (const summary of [null, '']) {
    const { store, map, act, question } = await asked();
    await act({ type: 'request-research', questionId: question.id });
    const packet = await store.claim('agent', map.id);
    const saved = await store.complete(map.id, packet.jobId, packet.claimKey, { ...result, summary });
    assert.equal(researchJobs(saved)[0].result.summary, undefined);
  }
});

test('research that arrives after the premise or an answer changed is kept as stale', async () => {
  for (const change of [{ type: 'revise', body: 'Notes that sync over mesh radio.' }, { type: 'answer', questionIndex: 1, answer: 'Only me.' }]) {
    const { store, map, act, question } = await asked();
    await act({ type: 'request-research', questionId: question.id });
    const packet = await store.claim('agent', map.id);
    const { questionIndex, ...input } = change;
    await act(questionIndex === undefined ? input : { ...input, questionId: map.nodes[0].questions[questionIndex].id });
    const saved = await store.complete(map.id, packet.jobId, packet.claimKey, result);
    assert.equal(researchJobs(saved)[0].stale, true, change.type);
    assert.equal(saved.nodes[0].questions[0].answer, null);
  }
});

test('research is for current questions on unfinished branches, answered or saved for later included', async () => {
  const { act, question, map } = await asked();
  const other = map.nodes[0].questions[1];
  await act({ type: 'answer-later', questionId: other.id });
  await act({ type: 'request-research', questionId: other.id });
  await act({ type: 'answer', questionId: question.id, answer: 'Merge automatically.' });
  const saved = await act({ type: 'request-research', questionId: question.id });
  assert.equal(researchJobs(saved).length, 2, 'saved-for-later and answered questions on an unfinished branch can be researched');
  await act({ type: 'revise', body: 'A different premise.' });
  await assert.rejects(act({ type: 'request-research', questionId: other.id }), error => error.status === 409, 'superseded');
});

test('a question saved for later cannot be regenerated, so a running branch is never thrown back to waiting', async () => {
  const { act, map } = await asked();
  const [first, second] = map.nodes[0].questions;
  await act({ type: 'answer-later', questionId: first.id });
  await act({ type: 'answer', questionId: second.id, answer: 'Two of us.' });
  await assert.rejects(act({ type: 'regenerate-question', questionId: first.id }), error => error.status === 409 && /saved for later/.test(error.message));
});

test('research is refused on a finished branch and on a dismissed question', async () => {
  const { store, act, question, map } = await asked();
  const other = map.nodes[0].questions[1];
  await act({ type: 'dismiss-question', questionId: other.id });
  await assert.rejects(act({ type: 'request-research', questionId: other.id }), error => error.status === 409, 'dismissed');
  await act({ type: 'answer', questionId: question.id, answer: 'Merge automatically.' });
  const packet = await store.claim('agent', map.id);
  await store.complete(map.id, packet.jobId, packet.claimKey, { summary: 'Merging wins.', body: 'Done.' });
  await act({ type: 'accept' });
  await assert.rejects(act({ type: 'request-research', questionId: question.id }), error => error.status === 409, 'finished');
});

test('the menu offers Help me answer first, also on answered questions of unfinished branches', () => {
  const esc = String;
  const labels = html => [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(match => match[1]);
  assert.deepEqual(labels(questionMenuHtml({ id: 'q-1' }, { nodeId: 'node-1', kind: 'open', esc })).slice(0, 3), ['Help me answer', 'Explain this question', 'Answer later']);
  assert.deepEqual(labels(questionMenuHtml({ id: 'q-1', answer: 'x' }, { nodeId: 'node-1', kind: 'answered', esc })).slice(0, 2), ['Help me answer', 'Change answer']);
  assert.ok(!labels(questionMenuHtml({ id: 'q-1', answer: 'x' }, { nodeId: 'node-1', kind: 'answered', completed: true, esc })).includes('Help me answer'), 'not on a finished branch');
  assert.deepEqual(labels(questionMenuHtml({ id: 'q-1', deferredAt: 'x' }, { nodeId: 'node-1', kind: 'waiting', esc })), ['Help me answer', 'Explain this question', 'Good question', 'Bad question'], 'saved for later: nothing that disturbs a running branch');
  assert.ok(!labels(questionMenuHtml({ id: 'q-1', dismissedAt: 'x' }, { nodeId: 'node-1', kind: 'answered', esc })).includes('Help me answer'), 'not on a dismissed question');
});

test('research shows its options, recommendation and sources under the question, with copy only while current', () => {
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const question = { id: 'q-1', text: 'Which sync model?' };
  const job = (status, extra = {}) => ({ id: `job-${status}`, type: 'question-research', subjectId: 'q-1', status, stale: false, ...(status === 'completed' ? { result } : {}), ...extra });
  const html = (jobs, more = {}) => questionResearchHtml({ question, jobs, listening: false, seen: new Set(), esc, ...more });
  assert.match(html([job('queued')]), /Queued for your agent\./);
  assert.match(html([job('queued')], { listening: true }), /Your agent will pick this up next\./, 'a queued job is not yet being researched');
  assert.match(html([job('running')], { listening: true }), /Your agent is researching this question/);
  assert.match(html([job('queued')]), /data-stop-job="job-queued"/);
  const current = html([job('completed')]);
  assert.match(current, /<summary>Research from your agent, not your answer<\/summary>/);
  assert.match(current, /Merge edits automatically <span class="option-badge">Recommended<\/span>/);
  assert.match(current, /<strong>Why Merge edits automatically:<\/strong> Field teams edit together\./);
  assert.match(current, /<a href="https:\/\/example\.org\/local-first" target="_blank" rel="noopener noreferrer">Local-first software<\/a>/);
  assert.match(current, /<button type="button" class="text-button" data-copy-answer="crdt" data-research-job="job-completed" data-question-id="q-1">Copy to my answer<\/button>/);
  assert.doesNotMatch(current, /data-copy-answer="lock"/, 'only options with a suggested answer can be copied');
  assert.match(current, / open>/, 'opens the first time');
  assert.doesNotMatch(html([job('completed')], { seen: new Set(['job-completed']) }), / open>/);
  const stale = html([job('completed', { stale: true })]);
  assert.match(stale, /<summary>Earlier research<\/summary>/);
  assert.match(stale, /data-copy-answer="crdt"[^>]*disabled/);
  assert.match(html([job('completed', { result: { options, recommendation: { optionId: null, missing: 'Team size.' } } })]), /No recommendation yet\.<\/strong> Team size\./);
  assert.equal(html([]), '');
});

test('copying takes the suggested answer only from current research', () => {
  const jobs = [{ id: 'job-1', type: 'question-research', subjectId: 'q-1', status: 'completed', stale: false, result }, { id: 'job-2', type: 'question-research', subjectId: 'q-1', status: 'completed', stale: true, result }];
  assert.equal(researchSuggestion(jobs, 'job-1', 'crdt'), 'I want edits merged automatically.');
  assert.equal(researchSuggestion(jobs, 'job-1', 'lock'), null);
  assert.equal(researchSuggestion(jobs, 'job-2', 'crdt'), null, 'stale research cannot be copied');
  assert.equal(researchSuggestion(jobs, 'job-9', 'crdt'), null);
});
