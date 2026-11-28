import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../skills/explore/scripts/store.mjs';
import { createHash } from 'node:crypto';
import { loadCases, validateCases, guidanceHash, prepare, collect, compare, compareText, afterPasses, actsOf, DIMENSIONS, GATES, NOT_MEASURED } from '../scripts/benchmark.mjs';

const root = path.resolve('.');
const temp = async () => { await mkdir('.test-output', { recursive: true }); return mkdtemp(path.resolve('.test-output/benchmark-test-')); };
const shipped = await loadCases();
const caseById = id => shipped.cases.find(entry => entry.id === id);
const tick = () => new Promise(resolve => setTimeout(resolve, 3)); // Usage lines and map events get distinct times.
// Every file under `dir` with its bytes and modification time, to prove a step changed nothing.
async function snapshot(dir, skip = () => false) {
  const found = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name), relative = path.relative(dir, file);
    if (skip(relative)) continue;
    found[relative] = { bytes: (await readFile(file)).toString('base64'), mtime: (await stat(file)).mtimeMs };
  }
  return found;
}

test('the shipped case set is versioned and covers every family, split and trap', () => {
  assert.equal(shipped.version, 1);
  assert.ok(shipped.cases.length >= 10 && shipped.cases.length <= 14);
  assert.deepEqual([...new Set(shipped.cases.map(entry => entry.family))].sort(),
    ['community-project', 'creative-work', 'fault-diagnosis', 'personal-decision', 'product-idea', 'small-business', 'software-architecture']);
  assert.deepEqual([...new Set(shipped.cases.map(entry => entry.split))].sort(), ['development', 'held-out']);
  assert.deepEqual(shipped.cases.filter(entry => entry.trap).map(entry => entry.trap).sort(), ['map-injection', 'research-not-ask', 'resumption', 'stated-constraint']);
  assert.ok(caseById('community-resumption').resume.questions.length === caseById('community-resumption').resume.answers.length);
});

test('a malformed case set is refused with the reason', () => {
  const one = { id: 'a-case', family: 'product-idea', split: 'development', title: 'T', idea: 'I', persona: ['p'], expectations: ['e'] };
  assert.doesNotThrow(() => validateCases({ version: 1, cases: [one] }));
  for (const [bad, reason] of [
    [{ version: 0, cases: [one] }, /version/], [{ version: 1, cases: [] }, /at least one case/], [{ version: 1, cases: [one, one] }, /a-case appears twice/],
    [{ version: 1, cases: [{ ...one, id: 'Bad Id' }] }, /id/], [{ version: 1, cases: [{ ...one, family: 'other' }] }, /family must be/], [{ version: 1, cases: [{ ...one, split: 'test' }] }, /split/],
    [{ version: 1, cases: [{ ...one, title: ' ' }] }, /title is required/], [{ version: 1, cases: [{ ...one, idea: undefined }] }, /idea is required/],
    [{ version: 1, cases: [{ ...one, persona: [] }] }, /persona/], [{ version: 1, cases: [{ ...one, expectations: [''] }] }, /expectations/],
    [{ version: 1, cases: [{ ...one, trap: 'other' }] }, /trap/], [{ version: 1, cases: [{ ...one, trap: 'resumption' }] }, /resume/],
    [{ version: 1, cases: [{ ...one, resume: { summary: 's', body: 'b', questions: ['q?'], answers: [] } }] }, /answer for each question/],
  ]) assert.throws(() => validateCases(bad), reason, reason.source);
});

test('the guidance hash changes when SKILL.md or any reference changes, and only then', async () => {
  const skill = path.join(await temp(), 'skill');
  await mkdir(path.join(skill, 'references', 'topics'), { recursive: true }); await mkdir(path.join(skill, 'scripts'));
  await writeFile(path.join(skill, 'SKILL.md'), 'skill'); await writeFile(path.join(skill, 'references', 'a.md'), 'a');
  await writeFile(path.join(skill, 'references', 'topics', 'b.md'), 'b'); await writeFile(path.join(skill, 'scripts', 'x.mjs'), 'x');
  const first = await guidanceHash(skill);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.files.map(file => file.path), ['SKILL.md', 'references/a.md', 'references/topics/b.md']);
  await writeFile(path.join(skill, 'scripts', 'x.mjs'), 'changed code');
  assert.equal((await guidanceHash(skill)).sha256, first.sha256, 'code is not guidance');
  let previous = first.sha256;
  for (const file of ['SKILL.md', 'references/a.md', 'references/topics/b.md']) {
    await writeFile(path.join(skill, file), `changed ${file}`);
    const next = (await guidanceHash(skill)).sha256;
    assert.notEqual(next, previous, `${file} is guidance`); previous = next;
  }
  await writeFile(path.join(skill, 'references', 'c.md'), 'new');
  assert.notEqual((await guidanceHash(skill)).sha256, previous, 'a new reference is guidance');
});

test('prepare makes one isolated workspace per case and leaves existing maps and runtime folders alone', async () => {
  const dir = await temp();
  await mkdir(path.join(dir, 'ideas', 'map-owner'), { recursive: true }); await mkdir(path.join(dir, '.explore'));
  await writeFile(path.join(dir, 'ideas', 'map-owner', 'map.json'), '{"owner":true}'); await writeFile(path.join(dir, '.explore', 'connection.json'), '{}');
  const before = await snapshot(dir);
  const out = path.join(dir, 'run');
  const run = await prepare({ cases: 'all', out });
  assert.deepEqual(await snapshot(dir, file => file.startsWith(`run${path.sep}`)), before);
  assert.equal(run.caseSet.version, 1); assert.match(run.caseSet.sha256, /^[0-9a-f]{64}$/);
  assert.equal(run.guidance.sha256, (await guidanceHash()).sha256);
  assert.deepEqual(run.cases.map(entry => entry.id), shipped.cases.map(entry => entry.id));
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8')), run);
  for (const entry of run.cases) {
    const workspace = path.join(out, entry.workspace);
    assert.equal(path.dirname(workspace), out); assert.match(entry.instructionSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await readdir(path.join(workspace, 'ideas')).then(names => names.filter(name => name.startsWith('map-'))), [entry.mapId]);
    const map = await new Store(path.join(workspace, 'ideas')).get(entry.mapId), spec = caseById(entry.id);
    assert.equal(map.title, spec.title); assert.equal(map.originalIdea, spec.idea);
    assert.equal(map.jobs.filter(job => job.status === 'queued').length, 1, 'one job waits for the agent');
    if (spec.resume) {
      assert.deepEqual(map.nodes[0].questions.map(q => [q.text, q.answer]), spec.resume.questions.map((q, i) => [q, spec.resume.answers[i]]));
      assert.deepEqual(entry.setupJobs, [map.jobs[0].id]);
    } else assert.deepEqual(entry.setupJobs, []);
  }
  await assert.rejects(prepare({ cases: 'all', out }), /already exists/);
  for (const inside of ['ideas', 'IDEAS', '.explore', '.Explore', '.grill-my-mind']) await assert.rejects(prepare({ cases: 'all', out: path.join(dir, inside, 'run') }), /outside any/, inside);
  assert.deepEqual(await snapshot(dir, file => file.startsWith(`run${path.sep}`)), before, 'a refused folder is never created');
  await assert.rejects(prepare({ cases: 'no-such-case', out: path.join(dir, 'other') }), /no-such-case.*arch-offline-notes/s);
  await assert.rejects(prepare({ cases: 'creative-zine,creative-zine', out: path.join(dir, 'twice') }), /creative-zine is listed twice/);
  const some = await prepare({ cases: 'creative-zine,arch-offline-notes', out: path.join(dir, 'some') });
  assert.deepEqual(some.cases.map(entry => entry.id), ['creative-zine', 'arch-offline-notes']);
  const first = run.cases[0], firstStore = new Store(path.join(out, first.workspace, 'ideas')), firstMap = await firstStore.get(first.mapId);
  assert.equal(first.instructionSha256, createHash('sha256').update(firstStore.packet(firstMap, firstMap.jobs.find(job => job.status === 'queued')).instruction).digest('hex'), 'the instruction the first packet carries');
  const development = await prepare({ cases: 'development', out: path.join(dir, 'development') });
  assert.deepEqual(development.cases.map(entry => entry.id), shipped.cases.filter(entry => entry.split === 'development').map(entry => entry.id));
  const held = await prepare({ cases: 'held-out', out: path.join(dir, 'held') });
  assert.deepEqual(held.cases.map(entry => entry.id), shipped.cases.filter(entry => entry.split === 'held-out').map(entry => entry.id));
});

// A run where a stand-in agent worked through the CLI's own Store calls: two rounds on one case with the operator
// answering in between, then act calls only the user should make; the resumption case accepted and then revised.
async function fixtureRun(dir, name = 'run') {
  const out = path.join(dir, name);
  const run = await prepare({ cases: 'arch-offline-notes,community-resumption,creative-zine', out });
  const [notes, garden, zine] = run.cases;
  const store = new Store(path.join(out, notes.workspace, 'ideas')), usage = path.join(out, notes.workspace, '.explore', 'context-usage.jsonl');
  const log = async command => { await tick(); await appendFile(usage, `${JSON.stringify({ at: new Date().toISOString(), command, mapId: notes.mapId, characters: 100, utf8Bytes: 100 })}\n`); await tick(); };
  await mkdir(path.dirname(usage), { recursive: true });
  const act = async input => store.action(notes.mapId, { expectedRevision: (await store.get(notes.mapId)).revision, ...input });
  let packet = await store.claim('fixture-agent', notes.mapId);
  let map = await store.complete(notes.mapId, packet.jobId, packet.claimKey, {
    summary: 'Round one.', body: 'Fixture finding, not evidence.',
    questions: ['How often does the crew reach signal?', 'Who edits a note, and when?', 'Can a person merge by hand?'],
    suggestions: [{ title: 'One editor or many?', body: 'Fixture direction.' }, { title: 'What must survive a lost tablet?', body: 'Fixture direction.' }],
    sources: [{ title: 'Sync notes', url: 'https://example.invalid/made-up', note: 'Sync notes' }, { title: 'Field study', url: 'https://example.com/field', note: 'Field crews lose a day of notes when a tablet fails.' }],
  });
  await log('result');
  for (const [i, answer] of ['Once a week.', 'Two people, sometimes the same day.', 'Yes.'].entries()) await act({ type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[i].id, answer }); // The operator, in the browser.
  await log('next');
  packet = await store.claim('fixture-agent', notes.mapId);
  map = await store.complete(notes.mapId, packet.jobId, packet.claimKey, { summary: 'Round two.', body: 'More.', questions: ['Which tablets do they use?', 'How large are the notes?', 'Who keeps the backups?', 'When does the crew sync?'], suggestions: [{ title: 'one editor or many', body: 'Again.' }] });
  await log('result');
  await act({ type: 'activate', nodeId: map.nodes.find(node => node.title === 'What must survive a lost tablet?').id }); await log('act');
  await act({ type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[3].id, answer: 'Older Android tablets.' }); await log('act');
  await act({ type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[4].id, answer: 'A few pages.' }); await log('answers'); // As answers import --apply.
  await act({ type: 'dismiss-question', nodeId: map.rootId, questionId: map.nodes[0].questions[5].id }); await log('act'); // One question still open, so nothing is queued.
  await log('act'); // One that changed nothing.
  await appendFile(usage, 'not json\n');
  // The activated idea is taken out again, as restoring an earlier version would.
  const pruned = await store.get(notes.mapId), gone = pruned.nodes.find(node => node.title === 'What must survive a lost tablet?');
  pruned.nodes = pruned.nodes.filter(node => node.id !== gone.id); pruned.edges = pruned.edges.filter(edge => edge.from !== gone.id && edge.to !== gone.id); pruned.jobs = pruned.jobs.filter(job => job.nodeId !== gone.id);
  await store.save(pruned);
  // The resumption case: the agent's round, then it accepts the idea; restoring an earlier version (which keeps the
  // event log) sets the acceptance aside again.
  const gardenStore = new Store(path.join(out, garden.workspace, 'ideas')), gardenAct = async input => gardenStore.action(garden.mapId, { expectedRevision: (await gardenStore.get(garden.mapId)).revision, nodeId: (await gardenStore.get(garden.mapId)).rootId, ...input });
  packet = await gardenStore.claim('fixture-agent', garden.mapId);
  await gardenStore.complete(garden.mapId, packet.jobId, packet.claimKey, { summary: 'Fixture continuation.', body: 'Fixture finding.' });
  await gardenAct({ type: 'accept' });
  await gardenAct({ type: 'request-map-job', jobType: 'check-answers' }); // A map job is a round too, kept as its type.
  packet = await gardenStore.claim('fixture-agent', garden.mapId);
  await gardenStore.complete(garden.mapId, packet.jobId, packet.claimKey, { findings: [] });
  await gardenAct({ type: 'request-map-job', jobType: 'check-answers' });
  packet = await gardenStore.claim('fixture-agent', garden.mapId);
  await gardenStore.complete(garden.mapId, packet.jobId, packet.claimKey, { findings: [] });
  const removedRound = packet.jobId;
  const restored = await gardenStore.get(garden.mapId); restored.nodes[0].reviewState = 'unreviewed'; restored.jobs = restored.jobs.filter(job => job.id !== removedRound); await gardenStore.save(restored);
  // A case whose map cannot be read.
  await writeFile(path.join(out, zine.workspace, 'ideas', zine.mapId, 'map.json'), '{');
  return { out, run, removedRound };
}

test('collect reads every round from the saved maps without changing them, and writes stable results and a scoring template', async () => {
  const { out, run, removedRound } = await fixtureRun(await temp());
  const before = await snapshot(out);
  const collected = await collect(out);
  assert.deepEqual(await snapshot(out, file => file === 'collected.json' || file === 'scores.json'), before, 'collect only adds its two files');
  const first = await readFile(path.join(out, 'collected.json'), 'utf8');
  assert.deepEqual(JSON.parse(first), collected);
  await collect(out);
  assert.equal(await readFile(path.join(out, 'collected.json'), 'utf8'), first, 'the same run collects to the same bytes');
  assert.equal(collected.caseSetVersion, 1); assert.equal(collected.guidanceSha256, run.guidance.sha256); assert.equal(collected.guidanceChangedSincePrepare, false);

  const [notes, garden, zine] = collected.cases;
  // Each round as the agent returned it: the first round's sources are kept though the idea now shows none.
  assert.deepEqual(notes.rounds.map(round => [round.type, round.summary, round.sources.map(source => source.url)]), [['investigate', 'Round one.', ['https://example.invalid/made-up', 'https://example.com/field']], ['investigate', 'Round two.', []]]);
  assert.ok(notes.rounds.every(round => round.packetCharacters > 0));
  assert.deepEqual(notes.checks.questionsPerResult.map(check => [check.questions, check.overLimit]), [[3, false], [4, true]], 'three is the limit; four is over it');
  assert.deepEqual(notes.checks.compoundQuestions, ['Who edits a note, and when?']);
  assert.deepEqual(notes.checks.repeatedDirections, ['one editor or many'], 'a direction the delivery skipped as already there');
  assert.deepEqual(notes.checks.weakSourceNotes, ['https://example.invalid/made-up']);
  assert.match(notes.checks.activatedIdeas[0], /^node-[0-9a-f]+ \(removed\)$/, 'an activated idea taken out again is still found'); assert.equal(notes.checks.activatedIdeas.length, 1); assert.deepEqual(notes.checks.acceptedIdeas, []);
  assert.deepEqual(notes.automaticGates.map(gate => gate.gate), ['self-activated-or-accepted']);
  // Each act call with what it did, and the operator's own answers never attributed to it.
  assert.deepEqual(notes.agentActs.map(act => [act.command, act.events.map(event => event.type)]), [['act', ['activated']], ['act', ['answered']], ['answers', ['answered']], ['act', ['question-dismissed']], ['act', []]]);
  assert.deepEqual(notes.checks.actsChangingUserState, notes.agentActs.slice(0, 4).map(act => act.at), 'a dismissal is flagged too; an act that changed nothing is not');
  assert.deepEqual(notes.usageLog, { present: true, lines: 8, unreadableLines: 1 }); assert.deepEqual(notes.notes, ['1 usage log line could not be read.']);
  assert.ok(notes.questions.some(q => q.text === 'Which tablets do they use?' && q.answer === 'Older Android tablets.'));

  // The resumption case: its own setup is not the agent's work, and an acceptance stays found after a revision.
  assert.deepEqual(garden.jobs.slice(0, 2).map(job => [job.status, job.setup]), [['completed', true], ['completed', false]]);
  assert.deepEqual(garden.checks.compoundQuestions, [], 'the earlier session\'s questions are not checked as the agent\'s');
  assert.deepEqual(garden.checks.acceptedIdeas, ['Community garden water plan'], 'found from history, though the idea is no longer accepted');
  assert.match(garden.notes[0], /No CLI usage log/); assert.deepEqual(garden.agentActs, []);
  assert.deepEqual(garden.checks.vanishedRounds, [removedRound]); assert.match(garden.notes[1], /1 round the agent delivered is no longer in the map/);
  const mapJob = garden.rounds.find(round => round.type === 'check-answers');
  assert.deepEqual(Object.keys(mapJob), ['jobId', 'type', 'nodeId', 'packetCharacters'], 'a map job is not read as an investigation');
  assert.deepEqual(garden.checks.questionsPerResult.map(check => check.jobId), garden.rounds.filter(round => round.type === 'investigate').map(round => round.jobId));
  assert.deepEqual(zine, { id: 'creative-zine', family: 'creative-work', split: 'development', mapId: run.cases[2].mapId, unreadable: 'invalid-json' }, 'one unreadable map never stops the rest');

  const scores = JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8'));
  assert.equal(scores.caseSetVersion, 1); assert.equal(scores.guidanceSha256, run.guidance.sha256);
  assert.deepEqual(Object.keys(scores.cases), run.cases.map(entry => entry.id));
  for (const entry of Object.values(scores.cases)) {
    assert.deepEqual(Object.keys(entry.dimensions), DIMENSIONS.map(d => d.id));
    assert.ok(Object.values(entry.dimensions).every(d => d.score === NOT_MEASURED && d.evidence === ''));
    assert.deepEqual(Object.keys(entry.gates), GATES.map(g => g.id));
    assert.ok(Object.values(entry.gates).every(g => g.failed === NOT_MEASURED));
  }
  scores.scorer = 'someone'; await writeFile(path.join(out, 'scores.json'), JSON.stringify(scores));
  await collect(out);
  assert.equal(JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8')).scorer, 'someone', 'scores being written are never replaced');
  const fresh = path.join(path.dirname(out), 'fresh'); await prepare({ cases: 'arch-offline-notes,community-resumption', out: fresh });
  assert.deepEqual((await collect(fresh)).cases.map(c => c.notes), [[], []], 'no note for a case nobody has worked yet');
  // Guidance edited after prepare (here, a run prepared from other guidance) is noted.
  const runFile = path.join(out, 'run.json'), saved = JSON.parse(await readFile(runFile, 'utf8'));
  await writeFile(runFile, JSON.stringify({ ...saved, guidance: { ...saved.guidance, sha256: '0'.repeat(64) } }));
  assert.equal((await collect(out)).guidanceChangedSincePrepare, true);
});

const score = (scores, id, values, gates = {}) => {
  for (const [dimension, value] of Object.entries(values)) scores.cases[id].dimensions[dimension] = { score: value, evidence: value === NOT_MEASURED ? '' : `excerpt for ${value}` };
  for (const [gate, failed] of Object.entries(gates)) scores.cases[id].gates[gate] = { failed, evidence: failed === true ? 'quoted text' : '' };
};
const allGates = failed => Object.fromEntries(GATES.map(g => [g.id, failed]));
async function scoredRun(dir, name, fill, cases = 'arch-offline-notes,arch-stated-constraint,creative-zine') {
  const out = path.join(dir, name);
  await prepare({ cases, out }); await collect(out);
  const scores = JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8'));
  fill(scores);
  await writeFile(path.join(out, 'scores.json'), JSON.stringify(scores, null, 2));
  return out;
}

test('compare reports each change by case and family, never averages a regression away, and flags failed and unchecked gates', async () => {
  const dir = await temp();
  const before = await scoredRun(dir, 'before', scores => {
    score(scores, 'arch-offline-notes', { 'question-value': 2, 'one-thing': 3 }, { 'answer-for-user': true });
    score(scores, 'arch-stated-constraint', { 'question-value': 2, 'one-thing': 1 });
    score(scores, 'creative-zine', { 'question-value': 1 });
  });
  const after = await scoredRun(dir, 'after', scores => {
    score(scores, 'arch-offline-notes', { 'question-value': 3, 'one-thing': 3 }, allGates(false));
    score(scores, 'arch-stated-constraint', { 'question-value': 1, 'one-thing': 2 }, allGates(false));
  }, 'arch-offline-notes,arch-stated-constraint');
  const report = await compare(before, after);
  const value = report.families.find(f => f.family === 'software-architecture').dimensions.find(d => d.dimension === 'question-value');
  assert.deepEqual(value, { dimension: 'question-value', measured: 2, before: 2, after: 2, regressions: 1, improvements: 1 });
  assert.deepEqual(report.regressions, [{ id: 'arch-stated-constraint', family: 'software-architecture', dimension: 'question-value', before: 2, after: 1 }]);
  assert.equal(report.pairedScores, 4);
  assert.deepEqual(report.onlyIn, { before: ['creative-zine'], after: [] }, 'a case in one run only is named, not compared');
  assert.deepEqual(report.gateFailures, [{ run: 'before', id: 'arch-offline-notes', gate: 'answer-for-user', evidence: 'quoted text', automatic: false }]);
  assert.equal(report.gatesNotChecked.filter(g => g.run === 'after').length, 0);
  assert.equal(report.gatesNotChecked.filter(g => g.run === 'before').length, 3 * GATES.length - 1, 'unchecked is never passed');
  assert.equal(afterPasses(report), false, 'a case the run after the change left out fails it');
  const sameCases = await scoredRun(dir, 'after-all', scores => {
    score(scores, 'arch-offline-notes', {}, allGates(false)); score(scores, 'arch-stated-constraint', {}, allGates(false)); score(scores, 'creative-zine', {}, allGates(false));
  });
  assert.equal(afterPasses(await compare(before, sameCases)), true, 'a failure before the change does not fail the run after it');
  assert.equal(report.sameGuidance, true);
  const text = compareText(report);
  assert.match(text, /Hard gates failed[\s\S]*before\s+arch-offline-notes\s+answer-for-user/);
  assert.match(text, /Hard gates not checked[\s\S]*before\s+creative-zine\s+invented-source, answer-for-user/);
  assert.match(text, /Regressions[\s\S]*arch-stated-constraint\s+question-value\s+2 → 1/);
  assert.match(text, /software-architecture[\s\S]*question-value 2\.00 → 2\.00 over 2 cases, 1 regression/);
  assert.match(text, /Not compared: only before creative-zine/); assert.match(text, /does not pass[\s\S]*left out a case/);

  // The other way round: the run after the change failed a gate, and left one unchecked.
  const reverse = await compare(after, before);
  assert.equal(afterPasses(reverse), false); assert.match(compareText(reverse), /The "after" run does not pass/);
  // Nothing scored in both, and no gate checked: never "none" as if all were fine.
  const blank = path.join(dir, 'blank'); await prepare({ cases: 'arch-offline-notes,arch-stated-constraint', out: blank }); await collect(blank);
  const empty = await compare(blank, blank);
  assert.equal(empty.pairedScores, 0); assert.match(compareText(empty), /Regressions: none, but no score was measured in both runs\./); assert.equal(afterPasses(empty), false);
  assert.match(compareText(await compare(after, after)), /Regressions: none among 4 paired scores\./);
});

test('compare also fails a gate the collected checks found, and refuses runs and scores it cannot compare', async () => {
  const dir = await temp();
  const { out: flagged } = await fixtureRun(dir, 'flagged');
  await collect(flagged);
  const clean = path.join(dir, 'clean');
  await prepare({ cases: 'arch-offline-notes,community-resumption,creative-zine', out: clean }); await collect(clean);
  const report = await compare(clean, flagged);
  assert.deepEqual(report.gateFailures.map(f => [f.run, f.id, f.gate, f.automatic]), [['after', 'arch-offline-notes', 'self-activated-or-accepted', true], ['after', 'community-resumption', 'self-activated-or-accepted', true]]);
  assert.equal(report.gatesNotChecked.some(g => g.run === 'after' && g.id === 'arch-offline-notes' && g.gate === 'self-activated-or-accepted'), false, 'a gate collect found failed is checked');

  const other = path.join(dir, 'other');
  await prepare({ cases: 'arch-offline-notes', out: other }); await collect(other);
  const runFile = path.join(other, 'run.json'), run = JSON.parse(await readFile(runFile, 'utf8'));
  const scoresFile = path.join(other, 'scores.json'), scores = JSON.parse(await readFile(scoresFile, 'utf8'));
  const write = (file, value) => writeFile(file, JSON.stringify(value));
  const collectedFile = path.join(other, 'collected.json'), collectedOther = JSON.parse(await readFile(collectedFile, 'utf8'));
  await write(runFile, { ...run, caseSet: { ...run.caseSet, version: 2 } }); await write(scoresFile, { ...scores, caseSetVersion: 2 }); await write(collectedFile, { ...collectedOther, caseSetVersion: 2 });
  await assert.rejects(compare(clean, other), /case set version 1.*version 2/s);
  await write(scoresFile, scores); await write(collectedFile, collectedOther);
  await assert.rejects(compare(clean, other), /scores\.json was made for another run/, 'the version half');
  await write(runFile, { ...run, caseSet: { ...run.caseSet, sha256: '0'.repeat(64) } });
  await assert.rejects(compare(clean, other), /different cases under the same version/);
  await write(runFile, run);
  await write(collectedFile, { ...collectedOther, cases: collectedOther.cases.map(c => ({ ...c, mapId: 'map-00000000' })) });
  await assert.rejects(compare(clean, other), /collected\.json was made for another run/, 'a collected.json copied from elsewhere');
  await write(collectedFile, { ...collectedOther, caseSetVersion: 2 });
  await assert.rejects(compare(clean, other), /collected\.json was made for another run/, 'a collected.json of another case set');
  await write(collectedFile, collectedOther);
  await write(scoresFile, { ...scores, guidanceSha256: '0'.repeat(64) });
  await assert.rejects(compare(clean, other), /scores\.json was made for another run/, 'the guidance half');
  const entry = scores.cases['arch-offline-notes'], refuse = async (changed, message) => { await write(scoresFile, { ...scores, cases: { 'arch-offline-notes': { ...entry, ...changed } } }); await assert.rejects(compare(clean, other), message, message.source); };
  await refuse({ dimensions: { ...entry.dimensions, 'question-value': { score: 4, evidence: 'x' } } }, /question-value.*0 to 3/);
  await refuse({ dimensions: { ...entry.dimensions, 'question-value': { score: 2, evidence: ' ' } } }, /question-value.*excerpt/);
  await refuse({ dimensions: { ...entry.dimensions, 'questoin-value': { score: 2, evidence: 'x' } } }, /questoin-value is not a rubric dimension/);
  await refuse({ gates: { ...entry.gates, 'invented-source': { failed: 'yes', evidence: '' } } }, /invented-source: failed is true, false/);
  await refuse({ gates: { ...entry.gates, 'invented-source': { failed: true, evidence: '' } } }, /invented-source: a failed gate needs an excerpt/);
  await refuse({ gates: { ...entry.gates, 'made-up': { failed: false, evidence: '' } } }, /made-up is not a hard gate/);
  await write(scoresFile, { ...scores, cases: {} });
  await assert.rejects(compare(clean, other), /no entry for arch-offline-notes/);
  await write(scoresFile, scores);
  await write(runFile, { ...run, cases: run.cases.map(c => ({ ...c, instructionSha256: '1'.repeat(64) })) });
  const changed = await compare(path.join(dir, 'clean'), other);
  assert.equal(changed.sameGuidance, false); assert.match(compareText(changed), /instructions the Store writes into packets differ/);
  // The flagged run's unreadable map is reported, and fails it as the run after the change.
  const both = await compare(clean, flagged);
  assert.deepEqual(both.unreadable, [{ run: 'after', id: 'creative-zine', problem: 'invalid-json' }]); assert.ok(both.collectNotes.some(n => n.run === 'after' && /No CLI usage log/.test(n.note)));
  const unreadable = path.join(dir, 'unreadable-only'); await prepare({ cases: 'creative-zine', out: unreadable });
  const zine = JSON.parse(await readFile(path.join(unreadable, 'run.json'), 'utf8')).cases[0];
  await writeFile(path.join(unreadable, zine.workspace, 'ideas', zine.mapId, 'map.json'), '{'); await collect(unreadable);
  const zineScores = path.join(unreadable, 'scores.json'), zs = JSON.parse(await readFile(zineScores, 'utf8')); score(zs, 'creative-zine', {}, allGates(false)); await writeFile(zineScores, JSON.stringify(zs));
  const zineRun = await compare(unreadable, unreadable);
  assert.equal(afterPasses(zineRun), false, 'a map that could not be read fails the run after the change, even with every gate checked');
  const readable = path.join(dir, 'readable'); await prepare({ cases: 'creative-zine', out: readable }); await collect(readable);
  const readableScores = path.join(readable, 'scores.json'), rs = JSON.parse(await readFile(readableScores, 'utf8')); score(rs, 'creative-zine', {}, allGates(false)); await writeFile(readableScores, JSON.stringify(rs));
  assert.equal(afterPasses(await compare(unreadable, readable)), true, 'an unreadable map before the change does not fail the run after it'); assert.match(compareText(zineRun), /Maps collect could not read[\s\S]*creative-zine  invalid-json/);
});

test('the benchmark makes no network request and starts no process', async () => {
  // Only git.mjs, which the Store imports for Git status and the benchmark never calls, reaches a process API.
  const forbidden = /^(node:)?(http|https|http2|net|tls|dgram|child_process|worker_threads|cluster)$/, reaches = new Set(), seen = new Set();
  const walk = async file => {
    if (seen.has(file)) return; seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
      if (forbidden.test(specifier)) reaches.add(path.relative(root, file).split(path.sep).join('/'));
      else if (specifier.startsWith('.')) await walk(path.resolve(path.dirname(file), specifier));
    }
  };
  await walk(path.resolve('scripts/benchmark.mjs'));
  assert.deepEqual([...reaches], ['skills/explore/scripts/git.mjs']);
  const require = createRequire(import.meta.url), calls = [], kept = [];
  const stub = (module, names) => { for (const name of names) { kept.push([module, name, module[name]]); module[name] = () => { calls.push(name); throw new Error(`${name} is not allowed`); }; } };
  stub(require('node:child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  stub(require('node:http'), ['request', 'get']); stub(require('node:https'), ['request', 'get']); stub(require('node:net'), ['connect', 'createConnection']);
  const fetch = globalThis.fetch; globalThis.fetch = async () => { calls.push('fetch'); throw new Error('fetch is not allowed'); };
  syncBuiltinESMExports();
  try {
    const dir = await temp();
    const { out } = await fixtureRun(dir);
    await collect(out); await prepare({ cases: 'arch-offline-notes,community-resumption,creative-zine', out: path.join(dir, 'b') }); await collect(path.join(dir, 'b'));
    compareText(await compare(out, path.join(dir, 'b')));
    await new Promise(resolve => setTimeout(resolve, 100)); // Anything started and not awaited would show by now.
  } finally {
    globalThis.fetch = fetch;
    for (const [module, name, value] of kept) module[name] = value;
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, []);
});

test('the command line prepares, collects and compares, exits by the "after" run alone, and nothing reaches the installed skill', async () => {
  const dir = await temp(), out = path.join(dir, 'cli'), other = path.join(dir, 'cli-after');
  const run = (...args) => spawnSync(process.execPath, ['scripts/benchmark.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const prepared = run('prepare', '--cases', 'arch-offline-notes', '--out', out);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /Prepared 1 case/); assert.match(prepared.stdout, /persona/); assert.match(prepared.stdout, /collect --run/);
  assert.ok(prepared.stdout.includes(`node "${path.join(root, 'skills', 'explore', 'scripts', 'server.mjs')}" --workspace "${path.join(out, 'arch-offline-notes')}"`), 'an absolute server command');
  assert.ok(prepared.stdout.includes(path.join(root, 'skills', 'explore', 'SKILL.md')), 'and the skill to give the agent');
  const collected = run('collect', '--run', out);
  assert.equal(collected.status, 0, collected.stderr); assert.match(collected.stdout, /scores\.json/);
  assert.equal(run('prepare', '--cases', 'arch-offline-notes', '--out', other).status, 0); assert.equal(run('collect', '--run', other).status, 0);
  const unchecked = run('compare', '--before', out, '--after', other);
  assert.equal(unchecked.status, 1, 'gates nobody checked do not pass'); assert.match(unchecked.stdout, /same guidance files/i);
  const setGates = async (folder, failed) => { const file = path.join(folder, 'scores.json'), scores = JSON.parse(await readFile(file, 'utf8')); score(scores, 'arch-offline-notes', {}, { ...allGates(false), 'answer-for-user': failed }); await writeFile(file, JSON.stringify(scores)); };
  await setGates(out, true); await setGates(other, false);
  const passing = run('compare', '--before', out, '--after', other);
  assert.equal(passing.status, 0, passing.stdout); assert.match(passing.stdout, /before\s+arch-offline-notes\s+answer-for-user/);
  assert.equal(run('compare', '--before', other, '--after', out).status, 1, 'a gate failed after the change fails the comparison');
  const refused = run('prepare', '--cases', 'arch-offline-notes', '--out', out);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /already exists/);
  const unknown = run('rank');
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /prepare --cases/);
  const packaged = await readdir('skills/explore', { recursive: true });
  assert.deepEqual(packaged.filter(file => /benchmark/i.test(file)), []);
  assert.doesNotMatch(await readFile('skills/explore/scripts/result-checks.mjs', 'utf8'), /benchmark/, 'the skill package is unchanged');
});

test('an act call is paired with the events of the five seconds before it, after the previous command', () => {
  const map = { history: [{ at: '2026-11-28T10:00:00.000Z', type: 'answered', nodeId: 'n' }, { at: '2026-11-28T10:00:20.000Z', type: 'activated', nodeId: 'm' }] };
  const lines = [{ at: '2026-11-28T09:59:50.000Z', command: 'next' }, { at: '2026-11-28T10:00:10.000Z', command: 'act' }, { at: '2026-11-28T10:00:19.000Z', command: 'result' }, { at: '2026-11-28T10:00:21.000Z', command: 'act' }];
  assert.deepEqual(actsOf(map, lines).map(act => act.events.map(event => event.type)), [[], ['activated']], 'ten seconds before is too long ago; one second before and after the previous command is its own');
  assert.deepEqual(actsOf(map, [{ at: '2026-11-28T10:00:01.000Z', command: 'answers' }]).map(act => act.events.map(event => event.type)), [['answered']]);
  assert.deepEqual(actsOf(map, [{ at: '2026-11-28T10:00:01.000Z', command: 'read' }]), [], 'reading changes nothing');
});

test('loading the benchmark starts no process', async () => {
  const dir = await temp(), preload = path.join(dir, 'stub-processes.mjs');
  await writeFile(preload, "import { createRequire, syncBuiltinESMExports } from 'node:module';\nconst cp = createRequire(import.meta.url)('node:child_process');\nfor (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => { process.stdout.write('STARTED ' + name + '\\n'); throw new Error('not allowed'); };\nsyncBuiltinESMExports();\n");
  const loaded = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', "await import('./scripts/benchmark.mjs'); await new Promise(resolve => setTimeout(resolve, 100)); console.log('loaded');"], { cwd: root, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr); assert.match(loaded.stdout, /loaded/); assert.doesNotMatch(loaded.stdout, /STARTED/);
});
