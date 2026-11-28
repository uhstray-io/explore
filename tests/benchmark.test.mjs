import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { loadCases, validateCases, guidanceHash, prepare, collect, compare, compareText, DIMENSIONS, GATES, NOT_MEASURED } from '../scripts/benchmark.mjs';

const root = path.resolve('.');
const temp = async () => { await mkdir('.test-output', { recursive: true }); return mkdtemp(path.resolve('.test-output/benchmark-test-')); };
const shipped = await loadCases();
const caseById = id => shipped.cases.find(entry => entry.id === id);
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
  assert.ok(shipped.cases.every(entry => entry.persona.length && entry.expectations.length));
  assert.ok(caseById('community-resumption').resume.questions.length === caseById('community-resumption').resume.answers.length);
});

test('a malformed case set is refused with the reason', () => {
  const one = { id: 'a-case', family: 'product-idea', split: 'development', title: 'T', idea: 'I', persona: ['p'], expectations: ['e'] };
  assert.doesNotThrow(() => validateCases({ version: 1, cases: [one] }));
  for (const [bad, reason] of [
    [{ version: 0, cases: [one] }, /version/],
    [{ version: 1, cases: [] }, /at least one case/],
    [{ version: 1, cases: [one, one] }, /a-case appears twice/],
    [{ version: 1, cases: [{ ...one, id: 'Bad Id' }] }, /id/],
    [{ version: 1, cases: [{ ...one, split: 'test' }] }, /split/],
    [{ version: 1, cases: [{ ...one, persona: [] }] }, /persona/],
    [{ version: 1, cases: [{ ...one, trap: 'other' }] }, /trap/],
    [{ version: 1, cases: [{ ...one, trap: 'resumption' }] }, /resume/],
    [{ version: 1, cases: [{ ...one, resume: { summary: 's', body: 'b', questions: ['q?'], answers: [] } }] }, /answer for each question/],
  ]) assert.throws(() => validateCases(bad), reason);
});

test('the guidance hash changes when SKILL.md or any reference changes, and only then', async () => {
  const skill = path.join(await temp(), 'skill');
  await mkdir(path.join(skill, 'references', 'topics'), { recursive: true }); await mkdir(path.join(skill, 'scripts'));
  await writeFile(path.join(skill, 'SKILL.md'), 'skill');
  await writeFile(path.join(skill, 'references', 'a.md'), 'a');
  await writeFile(path.join(skill, 'references', 'topics', 'b.md'), 'b');
  await writeFile(path.join(skill, 'scripts', 'x.mjs'), 'x');
  const first = await guidanceHash(skill);
  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.files.map(file => file.path), ['SKILL.md', 'references/a.md', 'references/topics/b.md']);
  assert.equal((await guidanceHash(skill)).sha256, first.sha256);
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
  // A project with its own maps and runtime folder, which prepare must never read or change.
  await mkdir(path.join(dir, 'ideas', 'map-owner'), { recursive: true }); await mkdir(path.join(dir, '.explore'));
  await writeFile(path.join(dir, 'ideas', 'map-owner', 'map.json'), '{"owner":true}'); await writeFile(path.join(dir, '.explore', 'connection.json'), '{}');
  const before = await snapshot(dir);
  const out = path.join(dir, 'run');
  const run = await prepare({ cases: 'all', out });
  assert.deepEqual(await snapshot(dir, file => file.startsWith(`run${path.sep}`)), before);
  assert.equal(run.caseSet.version, 1);
  assert.match(run.caseSet.sha256, /^[0-9a-f]{64}$/);
  assert.equal(run.guidance.sha256, (await guidanceHash()).sha256);
  assert.ok(run.guidance.files.some(file => file.path === 'references/exploration.md'));
  assert.deepEqual(run.cases.map(entry => entry.id), shipped.cases.map(entry => entry.id));
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'run.json'), 'utf8')), run);
  for (const entry of run.cases) {
    const workspace = path.join(out, entry.workspace);
    assert.equal(path.dirname(workspace), out);
    assert.deepEqual(await readdir(path.join(workspace, 'ideas')).then(names => names.filter(name => name.startsWith('map-'))), [entry.mapId]);
    const map = await new Store(path.join(workspace, 'ideas')).get(entry.mapId);
    const spec = caseById(entry.id);
    assert.equal(map.title, spec.title); assert.equal(map.originalIdea, spec.idea);
    assert.equal(map.jobs.filter(job => job.status === 'queued').length, 1, 'one job waits for the agent');
    if (spec.resume) {
      assert.deepEqual(map.nodes[0].questions.map(q => [q.text, q.answer]), spec.resume.questions.map((q, i) => [q, spec.resume.answers[i]]));
      assert.deepEqual(entry.setupJobs, [map.jobs[0].id]);
    } else assert.deepEqual(entry.setupJobs, []);
  }
  await assert.rejects(prepare({ cases: 'all', out }), /already exists/);
  await assert.rejects(prepare({ cases: 'all', out: path.join(dir, 'ideas', 'run') }), /ideas/);
  await assert.rejects(prepare({ cases: 'all', out: path.join(dir, '.explore', 'run') }), /\.explore/);
  await assert.rejects(prepare({ cases: 'no-such-case', out: path.join(dir, 'other') }), /no-such-case.*arch-offline-notes/s);
  const some = await prepare({ cases: 'creative-zine,arch-offline-notes', out: path.join(dir, 'some') });
  assert.deepEqual(some.cases.map(entry => entry.id), ['creative-zine', 'arch-offline-notes']);
});

// A run of two cases where a stand-in agent did one round on each, with known problems in its results.
async function fixtureRun(dir, name = 'run') {
  const out = path.join(dir, name);
  const run = await prepare({ cases: 'arch-offline-notes,community-resumption', out });
  const [notes, garden] = run.cases;
  let store = new Store(path.join(out, notes.workspace, 'ideas'));
  let packet = await store.claim('fixture-agent', notes.mapId);
  let map = await store.complete(notes.mapId, packet.jobId, packet.claimKey, {
    summary: 'Fixture round.', body: 'Fixture finding, not evidence.',
    questions: ['How often does the crew reach signal?', 'Who edits a note, and when?', 'Can a person merge by hand?', 'Which tablets do they use?'],
    suggestions: [{ title: 'One editor or many?', body: 'Fixture direction.' }, { title: 'What must survive a lost tablet?', body: 'Fixture direction.' }],
    sources: [{ title: 'Sync notes', url: 'https://example.com/sync', note: 'Sync notes' }, { title: 'Field study', url: 'https://example.com/field', note: 'Field crews lose a day of notes when a tablet fails.' }],
  });
  // Problems the protocol forbids or the guidance discourages, written as an agent's act calls would leave them.
  const [, editors, survive] = map.nodes;
  survive.title = 'one editor or many'; editors.reviewState = 'accepted';
  map.edges.push({ from: editors.id, to: survive.id, type: 'related_to' });
  await store.save(map);
  map = await store.action(notes.mapId, { type: 'activate', nodeId: editors.id, expectedRevision: map.revision });
  const usage = path.join(out, notes.workspace, '.explore', 'context-usage.jsonl');
  await mkdir(path.dirname(usage), { recursive: true });
  await appendFile(usage, [
    { at: '2026-11-28T10:00:00.000Z', command: 'next', mapId: notes.mapId, characters: 4200, utf8Bytes: 4210 },
    { at: '2026-11-28T10:05:00.000Z', command: 'act', mapId: notes.mapId, characters: 80, utf8Bytes: 80 },
    { at: '2026-11-28T10:06:00.000Z', command: 'result', mapId: notes.mapId, characters: 120, utf8Bytes: 120 },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  store = new Store(path.join(out, garden.workspace, 'ideas'));
  packet = await store.claim('fixture-agent', garden.mapId);
  await store.complete(garden.mapId, packet.jobId, packet.claimKey, { summary: 'Fixture continuation.', body: 'Fixture finding.', questions: ['How many litres do the tanks hold?'] });
  return { out, run };
}

test('collect reads the saved maps without changing them and writes stable results and a scoring template', async () => {
  const { out, run } = await fixtureRun(await temp());
  const before = await snapshot(out);
  const collected = await collect(out);
  assert.deepEqual(await snapshot(out, file => file === 'collected.json' || file === 'scores.json'), before, 'collect only adds its two files');
  const first = await readFile(path.join(out, 'collected.json'), 'utf8');
  assert.deepEqual(JSON.parse(first), collected);
  await collect(out);
  assert.equal(await readFile(path.join(out, 'collected.json'), 'utf8'), first, 'the same run collects to the same bytes');

  const [notes, garden] = collected.cases;
  assert.equal(collected.caseSetVersion, 1); assert.equal(collected.guidanceSha256, run.guidance.sha256);
  assert.deepEqual(notes.questions.map(q => q.text), ['How often does the crew reach signal?', 'Who edits a note, and when?', 'Can a person merge by hand?', 'Which tablets do they use?']);
  assert.deepEqual(notes.suggestions.map(s => s.title), ['One editor or many?', 'one editor or many']);
  assert.equal(notes.findings[0].summary, 'Fixture round.');
  assert.deepEqual(notes.sources.map(s => s.url), ['https://example.com/sync', 'https://example.com/field']);
  assert.deepEqual(notes.links.map(link => link.type), ['related_to']);
  assert.deepEqual(notes.jobs.map(job => [job.status, job.setup]), [['completed', false], ['queued', false]]);
  assert.ok(notes.results[0].packetCharacters > 0);
  assert.deepEqual(notes.checks.questionsPerResult, [{ jobId: notes.jobs[0].id, questions: 4, overLimit: true }]);
  assert.deepEqual(notes.checks.compoundQuestions, ['Who edits a note, and when?']);
  assert.deepEqual(notes.checks.duplicateSuggestionTitles, [['One editor or many?', 'one editor or many']]);
  assert.deepEqual(notes.checks.sourcesWithoutNotes, ['https://example.com/sync']);
  assert.deepEqual(notes.checks.acceptedNodes, ['One editor or many?']);
  assert.deepEqual(notes.checks.activatedNodes, ['One editor or many?']);
  assert.deepEqual(notes.automaticGates.map(gate => gate.gate), ['self-activated-or-accepted', 'self-activated-or-accepted']);
  assert.deepEqual(notes.agentActs, [{ at: '2026-11-28T10:05:00.000Z', mapId: notes.mapId, characters: 80 }]);
  assert.deepEqual(notes.cliOutput, { act: { calls: 1, characters: 80 }, next: { calls: 1, characters: 4200 }, result: { calls: 1, characters: 120 } });

  // The resumption case's own setup is not the agent's work.
  assert.deepEqual(garden.jobs.map(job => [job.status, job.setup]), [['completed', true], ['completed', false]]);
  assert.deepEqual(garden.checks.questionsPerResult, [{ jobId: garden.jobs[1].id, questions: 1, overLimit: false }]);
  assert.deepEqual(garden.automaticGates, []); assert.deepEqual(garden.agentActs, []);
  assert.deepEqual(garden.checks.compoundQuestions, [], 'the earlier session\'s own questions are not checked as the agent\'s');

  const scores = JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8'));
  assert.equal(scores.caseSetVersion, 1); assert.equal(scores.guidanceSha256, run.guidance.sha256);
  assert.deepEqual(Object.keys(scores.cases), ['arch-offline-notes', 'community-resumption']);
  for (const entry of Object.values(scores.cases)) {
    assert.deepEqual(Object.keys(entry.dimensions), DIMENSIONS.map(d => d.id));
    assert.ok(Object.values(entry.dimensions).every(d => d.score === NOT_MEASURED && d.evidence === ''));
    assert.deepEqual(Object.keys(entry.gates), GATES.map(g => g.id));
    assert.ok(Object.values(entry.gates).every(g => g.failed === NOT_MEASURED));
  }
  // Scores already being written are never replaced.
  scores.scorer = 'someone'; await writeFile(path.join(out, 'scores.json'), JSON.stringify(scores));
  await collect(out);
  assert.equal(JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8')).scorer, 'someone');
});

const score = (run, id, values, gates = {}) => {
  for (const [dimension, value] of Object.entries(values)) run.cases[id].dimensions[dimension] = { score: value, evidence: value === NOT_MEASURED ? '' : `excerpt for ${value}` };
  for (const [gate, failed] of Object.entries(gates)) run.cases[id].gates[gate] = { failed, evidence: failed === true ? 'quoted text' : '' };
};
async function scoredRun(dir, name, fill) {
  const out = path.join(dir, name);
  await prepare({ cases: 'arch-offline-notes,arch-stated-constraint,creative-zine', out });
  await collect(out);
  const scores = JSON.parse(await readFile(path.join(out, 'scores.json'), 'utf8'));
  fill(scores);
  await writeFile(path.join(out, 'scores.json'), JSON.stringify(scores, null, 2));
  return out;
}

test('compare reports each change by case and family, never averages a regression away, and flags hard gates', async () => {
  const dir = await temp();
  const before = await scoredRun(dir, 'before', scores => {
    score(scores, 'arch-offline-notes', { 'question-value': 2, 'one-thing': 3 });
    score(scores, 'arch-stated-constraint', { 'question-value': 2, 'one-thing': 1 });
    score(scores, 'creative-zine', { 'question-value': 1 });
  });
  const after = await scoredRun(dir, 'after', scores => {
    score(scores, 'arch-offline-notes', { 'question-value': 3, 'one-thing': 3 });
    score(scores, 'arch-stated-constraint', { 'question-value': 1, 'one-thing': 2 });
    score(scores, 'creative-zine', { 'question-value': NOT_MEASURED, 'evidence-grounding': 2 }, { 'invented-source': true });
  });
  const report = await compare(before, after);
  const arch = report.families.find(f => f.family === 'software-architecture');
  const value = arch.dimensions.find(d => d.dimension === 'question-value');
  assert.deepEqual(value, { dimension: 'question-value', measured: 2, before: 2, after: 2, regressions: 1, improvements: 1 });
  assert.deepEqual(report.regressions, [{ id: 'arch-stated-constraint', family: 'software-architecture', dimension: 'question-value', before: 2, after: 1 }]);
  const zine = report.cases.find(c => c.id === 'creative-zine');
  assert.deepEqual(zine.dimensions.find(d => d.dimension === 'question-value'), { dimension: 'question-value', before: 1, after: NOT_MEASURED, change: null });
  assert.deepEqual(zine.dimensions.find(d => d.dimension === 'evidence-grounding'), { dimension: 'evidence-grounding', before: NOT_MEASURED, after: 2, change: null });
  // Not measured is never a zero: creative work has no paired score, so no family mean.
  assert.deepEqual(report.families.find(f => f.family === 'creative-work').dimensions.find(d => d.dimension === 'question-value'), { dimension: 'question-value', measured: 0, before: null, after: null, regressions: 0, improvements: 0 });
  assert.deepEqual(report.gateFailures, [{ run: 'after', id: 'creative-zine', gate: 'invented-source', evidence: 'quoted text', automatic: false }]);
  assert.equal(report.sameGuidance, true);
  const text = compareText(report);
  assert.match(text, /Hard gates failed[\s\S]*after\s+creative-zine\s+invented-source/);
  assert.match(text, /Regressions[\s\S]*arch-stated-constraint\s+question-value\s+2 → 1/);
  assert.match(text, /software-architecture[\s\S]*question-value 2\.00 → 2\.00 over 2 cases, 1 regression/);
});

test('compare also fails a gate the collected checks found, and refuses runs it cannot compare', async () => {
  const dir = await temp();
  const { out: flagged } = await fixtureRun(dir, 'flagged');
  await collect(flagged);
  const clean = path.join(dir, 'clean');
  await prepare({ cases: 'arch-offline-notes,community-resumption', out: clean }); await collect(clean);
  const report = await compare(clean, flagged);
  assert.deepEqual(report.gateFailures.map(f => [f.run, f.id, f.gate, f.automatic]), [['after', 'arch-offline-notes', 'self-activated-or-accepted', true], ['after', 'arch-offline-notes', 'self-activated-or-accepted', true]]);

  const other = path.join(dir, 'other');
  await prepare({ cases: 'arch-offline-notes', out: other }); await collect(other);
  const runFile = path.join(other, 'run.json'), run = JSON.parse(await readFile(runFile, 'utf8'));
  const scoresFile = path.join(other, 'scores.json'), scores = JSON.parse(await readFile(scoresFile, 'utf8'));
  // A run of a later case set, scored against it.
  await writeFile(runFile, JSON.stringify({ ...run, caseSet: { ...run.caseSet, version: 2 } })); await writeFile(scoresFile, JSON.stringify({ ...scores, caseSetVersion: 2 }));
  await assert.rejects(compare(clean, other), /case set version 1.*version 2/s);
  await writeFile(scoresFile, JSON.stringify(scores));
  await assert.rejects(compare(clean, other), /scores\.json was made for another run/, 'scores must belong to their run');
  await writeFile(runFile, JSON.stringify({ ...run, caseSet: { ...run.caseSet, sha256: '0'.repeat(64) } }));
  await assert.rejects(compare(clean, other), /different cases under the same version/);
  await writeFile(runFile, JSON.stringify(run));

  scores.cases['arch-offline-notes'].dimensions['question-value'] = { score: 4, evidence: 'x' };
  await writeFile(scoresFile, JSON.stringify(scores));
  await assert.rejects(compare(clean, other), /question-value.*0 to 3/);
  scores.cases['arch-offline-notes'].dimensions['question-value'] = { score: 2, evidence: ' ' };
  await writeFile(scoresFile, JSON.stringify(scores));
  await assert.rejects(compare(clean, other), /question-value.*excerpt/);
  scores.cases['arch-offline-notes'].dimensions['question-value'] = { score: 2, evidence: 'x' };
  scores.cases['arch-offline-notes'].gates['invented-source'] = { failed: 'yes', evidence: '' };
  await writeFile(scoresFile, JSON.stringify(scores));
  await assert.rejects(compare(clean, other), /invented-source/);
  await rm(scoresFile);
  await assert.rejects(compare(clean, other), /Run collect/);
});

test('the benchmark makes no network request and starts no process', async () => {
  const source = await readFile('scripts/benchmark.mjs', 'utf8');
  for (const name of ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'child_process', 'worker_threads', 'cluster']) assert.doesNotMatch(source, new RegExp(`from ['"](node:)?${name}['"]|import\\(['"](node:)?${name}['"]`), name);
  const require = createRequire(import.meta.url), calls = [], kept = [];
  const stub = (module, names) => { for (const name of names) { kept.push([module, name, module[name]]); module[name] = (...args) => { calls.push(name); throw new Error(`${name} is not allowed`); }; } };
  stub(require('node:child_process'), ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
  stub(require('node:http'), ['request', 'get']); stub(require('node:https'), ['request', 'get']); stub(require('node:net'), ['connect', 'createConnection']);
  const fetch = globalThis.fetch; globalThis.fetch = async () => { calls.push('fetch'); throw new Error('fetch is not allowed'); };
  syncBuiltinESMExports();
  try {
    const dir = await temp();
    const { out } = await fixtureRun(dir);
    await collect(out); await prepare({ cases: 'arch-offline-notes,community-resumption', out: path.join(dir, 'b') }); await collect(path.join(dir, 'b'));
    compareText(await compare(out, path.join(dir, 'b')));
  } finally {
    globalThis.fetch = fetch;
    for (const [module, name, value] of kept) module[name] = value;
    syncBuiltinESMExports();
  }
  assert.deepEqual(calls, []);
});

test('the command line prepares, collects and compares, and nothing reaches the installed skill', async () => {
  const dir = await temp(), out = path.join(dir, 'cli');
  const run = (...args) => spawnSync(process.execPath, ['scripts/benchmark.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const prepared = run('prepare', '--cases', 'arch-offline-notes', '--out', out);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /Prepared 1 case/);
  assert.match(prepared.stdout, /server\.mjs --workspace .*arch-offline-notes/);
  assert.match(prepared.stdout, /persona/);
  assert.match(prepared.stdout, /collect --run/);
  const collected = run('collect', '--run', out);
  assert.equal(collected.status, 0, collected.stderr); assert.match(collected.stdout, /scores\.json/);
  const compared = run('compare', '--before', out, '--after', out);
  assert.equal(compared.status, 0, compared.stderr); assert.match(compared.stdout, /same guidance/i);
  const scoresFile = path.join(out, 'scores.json'), scores = JSON.parse(await readFile(scoresFile, 'utf8'));
  scores.cases['arch-offline-notes'].gates['answer-for-user'] = { failed: true, evidence: 'act answer: "Once a day."' };
  await writeFile(scoresFile, JSON.stringify(scores));
  const gated = run('compare', '--before', out, '--after', out);
  assert.equal(gated.status, 1, 'a hard gate failed after the change fails the comparison'); assert.match(gated.stdout, /answer-for-user/);
  const refused = run('prepare', '--cases', 'arch-offline-notes', '--out', out);
  assert.equal(refused.status, 1); assert.match(refused.stderr, /already exists/);
  const unknown = run('rank');
  assert.equal(unknown.status, 2); assert.match(unknown.stderr, /prepare --cases/);

  const packaged = await readdir('skills/explore', { recursive: true });
  assert.deepEqual(packaged.filter(file => /benchmark/i.test(file)), []);
});
