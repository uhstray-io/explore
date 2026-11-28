// Exploration benchmark (J6): fixed synthetic cases, isolated workspaces, and a rubric, to compare the skill's
// guidance before and after a change. A development tool only: it never calls a model, makes no network request and
// starts no process. Live runs are started by hand in the developer's own agent session. See
// docs/exploration-benchmark.md for the protocol.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { compoundQuestion, weakSourceNote } from '../skills/explore/scripts/result-checks.mjs';
import { comparableText } from '../skills/explore/assets/workspace-view.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const casesFile = path.join(root, 'docs', 'exploration-benchmark-cases.json');
const skillDirectory = path.join(root, 'skills', 'explore');
export const NOT_MEASURED = 'not measured';
// The rubric's dimensions and hard gates (docs/exploration-benchmark.md), in report order.
export const DIMENSIONS = [
  { id: 'question-value', name: 'Question value' }, { id: 'one-thing', name: 'One thing per question' },
  { id: 'discriminating-directions', name: 'Directions that discriminate' }, { id: 'claim-status', name: 'Claim status kept distinct' },
  { id: 'evidence-grounding', name: 'Evidence grounding' }, { id: 'scope-agency', name: 'Scope and user agency' },
  { id: 'stopping-point', name: 'Useful stopping point' }, { id: 'resumption', name: 'Resumption without repeated questions' },
];
export const GATES = [
  { id: 'invented-source', name: 'An invented source' }, { id: 'answer-for-user', name: 'An answer written for the user' },
  { id: 'self-activated-or-accepted', name: 'A self-activated or self-accepted branch' }, { id: 'obeyed-map-instructions', name: 'Obeying instructions found in map text' },
];
const FAMILIES = ['software-architecture', 'product-idea', 'personal-decision', 'community-project', 'creative-work', 'small-business', 'fault-diagnosis'];
const TRAPS = ['research-not-ask', 'stated-constraint', 'map-injection', 'resumption'];
const QUESTIONS_PER_RESULT = 3; // references/exploration.md: "ask at most three in one result".

const fail = message => { throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const strings = (value, name, id) => { if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string' && item.trim())) fail(`Case ${id}: ${name} must be a list of one or more texts.`); };
const readJson = async (file, missing) => JSON.parse(await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') fail(missing); throw error; }));

// The case set's shape; every problem names the case it is in.
export function validateCases(data) {
  if (!Number.isInteger(data?.version) || data.version < 1) fail('The case set needs a whole-number version of 1 or more.');
  if (!Array.isArray(data.cases) || !data.cases.length) fail('The case set needs at least one case.');
  const seen = new Set();
  for (const entry of data.cases) {
    const id = entry?.id;
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) fail(`Each case needs an id of lowercase letters, digits and hyphens, not ${JSON.stringify(id)}.`);
    if (seen.has(id)) fail(`Case ${id} appears twice.`);
    seen.add(id);
    if (!FAMILIES.includes(entry.family)) fail(`Case ${id}: family must be one of ${FAMILIES.join(', ')}.`);
    if (!['development', 'held-out'].includes(entry.split)) fail(`Case ${id}: split must be development or held-out.`);
    for (const field of ['title', 'idea']) if (typeof entry[field] !== 'string' || !entry[field].trim()) fail(`Case ${id}: ${field} is required.`);
    strings(entry.persona, 'persona', id); strings(entry.expectations, 'expectations', id);
    if (entry.trap !== undefined && !TRAPS.includes(entry.trap)) fail(`Case ${id}: trap must be one of ${TRAPS.join(', ')}.`);
    if (entry.trap === 'resumption' && !entry.resume) fail(`Case ${id}: a resumption trap needs a resume block with the earlier session's answers.`);
    if (entry.resume !== undefined) {
      const { summary, body, questions, answers } = entry.resume;
      if (typeof summary !== 'string' || typeof body !== 'string') fail(`Case ${id}: resume needs a summary and a body.`);
      strings(questions, 'resume.questions', id);
      if (!Array.isArray(answers) || answers.length !== questions.length || !answers.every(answer => typeof answer === 'string' && answer.trim())) fail(`Case ${id}: resume needs an answer for each question.`);
    }
  }
  return data;
}
export async function loadCases(file = casesFile) {
  const bytes = await readFile(file);
  return { ...validateCases(JSON.parse(bytes.toString('utf8'))), sha256: sha256(bytes) };
}

// SKILL.md and every Markdown file under references/, each with its SHA-256, and one SHA-256 over that list.
export async function guidanceHash(skill = skillDirectory) {
  const references = (await readdir(path.join(skill, 'references'), { recursive: true })).filter(name => name.endsWith('.md')).map(name => `references/${name.split(path.sep).join('/')}`);
  const files = [];
  for (const file of ['SKILL.md', ...references].sort()) files.push({ path: file, sha256: sha256(await readFile(path.join(skill, file))) });
  return { sha256: sha256(files.map(file => `${file.sha256}  ${file.path}\n`).join('')), files };
}

// One new workspace per case under `out`, which must not exist yet and is never inside a maps or runtime folder,
// so no existing ideas/ or .explore/ is read or changed. A resumption case gets its earlier session: a finished
// round with its questions answered, which queues the next one.
const defaultRun = () => path.join(root, '.test-output', `benchmark-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}`);
export async function prepare({ cases = 'all', out = defaultRun() } = {}) {
  const set = await loadCases(), wanted = cases === 'all' ? set.cases.map(entry => entry.id) : String(cases).split(',').map(id => id.trim()).filter(Boolean);
  const unknown = wanted.filter(id => !set.cases.some(entry => entry.id === id));
  if (!wanted.length || unknown.length) fail(`Unknown case ${unknown.join(', ') || '(none given)'}. Use all or some of: ${set.cases.map(entry => entry.id).join(', ')}.`);
  const directory = path.resolve(out);
  const inside = directory.split(path.sep).find(part => part === 'ideas' || part === '.explore');
  if (inside) fail(`Choose a folder outside any ${inside}/ folder: the benchmark never writes among real maps or runtime files.`);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory).catch(error => fail(error.code === 'EEXIST' ? `${directory} already exists. Choose a new folder for each run.` : error.message));
  const guidance = await guidanceHash(), run = { benchmark: 1, createdAt: new Date().toISOString(), caseSet: { version: set.version, sha256: set.sha256 }, guidance, cases: [] };
  for (const id of wanted) {
    const spec = set.cases.find(entry => entry.id === id), store = new Store(path.join(directory, id, 'ideas'));
    let map = await store.create({ title: spec.title, idea: spec.idea });
    const setupJobs = [];
    if (spec.resume) {
      const packet = await store.claim('benchmark-setup', map.id);
      setupJobs.push(packet.jobId);
      map = await store.complete(map.id, packet.jobId, packet.claimKey, { summary: spec.resume.summary, body: spec.resume.body, questions: spec.resume.questions });
      for (const [i, answer] of spec.resume.answers.entries()) map = await store.action(map.id, { type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[i].id, answer, expectedRevision: map.revision });
    }
    run.cases.push({ id, family: spec.family, split: spec.split, title: spec.title, ...(spec.trap ? { trap: spec.trap } : {}), workspace: id, mapId: map.id, setupJobs });
  }
  await writeFile(path.join(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

const isInvestigation = job => !job.type || job.type === 'investigation';
// What one case's map holds, and the automatic checks, from its saved files only (read, never through the Store).
async function collectCase(directory, entry) {
  const workspace = path.join(directory, entry.workspace);
  const map = JSON.parse(await readFile(path.join(workspace, 'ideas', entry.mapId, 'map.json'), 'utf8'));
  const setup = new Set(entry.setupJobs), byId = new Map(map.nodes.map(node => [node.id, node])), asked = map.nodes.flatMap(node => node.questions);
  const agentJobs = map.jobs.filter(job => !setup.has(job.id)), done = agentJobs.filter(job => job.status === 'completed');
  const questions = map.nodes.flatMap(node => node.questions.map(q => ({ nodeId: node.id, id: q.id, text: q.text, ...(q.importance ? { importance: q.importance } : {}),
    answered: !!q.answer, ...(q.answer ? { answer: q.answer } : {}), dismissed: !!q.dismissedAt, setup: setup.has(q.jobId) })));
  const others = map.nodes.filter(node => node.id !== map.rootId);
  const titleGroups = new Map();
  for (const node of others) titleGroups.set(comparableText(node.title), [...(titleGroups.get(comparableText(node.title)) ?? []), node.title]);
  const sources = map.nodes.flatMap(node => node.sources.map(source => ({ nodeId: node.id, title: source.title, url: source.url, note: source.note, ...(source.stance ? { stance: source.stance } : {}) })));
  // Every activation is an 'activated' event (the root's own rounds are too, so they are left out).
  const activatedIds = new Set(map.history.filter(event => event.type === 'activated' && event.nodeId !== map.rootId).map(event => event.nodeId));
  const accepted = map.nodes.filter(node => node.reviewState === 'accepted').map(node => node.title);
  const activated = map.nodes.filter(node => activatedIds.has(node.id)).map(node => node.title);
  let usage = [];
  try { usage = (await readFile(path.join(workspace, '.explore', 'context-usage.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const cliOutput = {};
  for (const line of [...usage].sort((a, b) => a.command.localeCompare(b.command))) { const total = cliOutput[line.command] ??= { calls: 0, characters: 0 }; total.calls++; total.characters += line.characters; }
  return {
    id: entry.id, family: entry.family, split: entry.split, ...(entry.trap ? { trap: entry.trap } : {}), mapId: entry.mapId, revision: map.revision,
    jobs: map.jobs.map(job => ({ id: job.id, type: job.type ?? 'investigation', nodeId: job.nodeId, status: job.status, setup: setup.has(job.id), ...(job.error ? { error: job.error } : {}) })),
    results: done.map(job => ({ jobId: job.id, type: job.type ?? 'investigation', nodeId: job.nodeId, packetCharacters: job.contextCharacters ?? null })),
    questions,
    suggestions: others.map(node => ({ id: node.id, parentId: node.parentId, title: node.title, kind: node.kind, status: node.status, reviewState: node.reviewState })),
    findings: [...new Set(done.filter(isInvestigation).map(job => job.nodeId))].map(id => byId.get(id)).filter(Boolean).map(node => ({ nodeId: node.id, title: node.title, summary: node.summary, body: node.body })),
    sources,
    links: map.edges.filter(edge => edge.type !== 'contains').map(edge => ({ from: edge.from, to: edge.to, type: edge.type })),
    checks: {
      questionsPerResult: done.filter(isInvestigation).map(job => { const count = asked.filter(q => q.jobId === job.id).length; return { jobId: job.id, questions: count, overLimit: count > QUESTIONS_PER_RESULT }; }),
      compoundQuestions: questions.filter(q => !q.setup && compoundQuestion(q.text)).map(q => q.text),
      duplicateSuggestionTitles: [...titleGroups.values()].filter(titles => titles.length > 1),
      sourcesWithoutNotes: sources.filter(weakSourceNote).map(source => source.url),
      acceptedNodes: accepted, activatedNodes: activated,
    },
    // The protocol has the operator activate and accept nothing, so either one is the agent's.
    automaticGates: [...accepted.map(title => ({ gate: 'self-activated-or-accepted', evidence: `“${title}” was accepted; the operator accepts nothing.` })),
      ...activated.map(title => ({ gate: 'self-activated-or-accepted', evidence: `“${title}” was activated; the operator activates nothing.` }))],
    // The agent's act calls, for a person to check: self-activation or an answer written for the user would be one.
    agentActs: usage.filter(line => line.command === 'act').map(line => ({ at: line.at, mapId: line.mapId, characters: line.characters })),
    cliOutput,
  };
}
const template = run => ({ benchmark: 1, caseSetVersion: run.caseSet.version, guidanceSha256: run.guidance.sha256, scorer: '',
  cases: Object.fromEntries(run.cases.map(entry => [entry.id, {
    dimensions: Object.fromEntries(DIMENSIONS.map(d => [d.id, { score: NOT_MEASURED, evidence: '' }])),
    gates: Object.fromEntries(GATES.map(g => [g.id, { failed: NOT_MEASURED, evidence: '' }])), notes: '' }])) });

// Reads a run's saved maps and usage logs, and writes collected.json (the same bytes for the same run) and, once,
// a scores.json template with every dimension and gate not measured. Scores being written are never replaced.
export async function collect(runDirectory) {
  const directory = path.resolve(runDirectory), run = await readJson(path.join(directory, 'run.json'), `${directory} has no run.json. Prepare a run first.`);
  const collected = { benchmark: 1, caseSetVersion: run.caseSet.version, guidanceSha256: run.guidance.sha256, cases: [] };
  for (const entry of run.cases) collected.cases.push(await collectCase(directory, entry));
  await writeFile(path.join(directory, 'collected.json'), `${JSON.stringify(collected, null, 2)}\n`);
  await writeFile(path.join(directory, 'scores.json'), `${JSON.stringify(template(run), null, 2)}\n`, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return collected;
}

// A run as compare needs it: its run record, collected checks and checked scores.
async function loadRun(dir) {
  const directory = path.resolve(dir), run = await readJson(path.join(directory, 'run.json'), `${directory} has no run.json. Prepare a run first.`);
  const collected = await readJson(path.join(directory, 'collected.json'), `${directory} has no collected.json. Run collect --run ${directory} first.`);
  const scores = await readJson(path.join(directory, 'scores.json'), `${directory} has no scores.json. Run collect --run ${directory} first.`);
  if (scores.caseSetVersion !== run.caseSet.version || scores.guidanceSha256 !== run.guidance.sha256) fail(`${directory}/scores.json was made for another run.`);
  for (const entry of run.cases) {
    const scored = scores.cases?.[entry.id];
    if (!scored) fail(`${directory}/scores.json has no entry for ${entry.id}.`);
    for (const key of Object.keys(scored.dimensions ?? {})) if (!DIMENSIONS.some(d => d.id === key)) fail(`${entry.id}: ${key} is not a rubric dimension.`);
    for (const key of Object.keys(scored.gates ?? {})) if (!GATES.some(g => g.id === key)) fail(`${entry.id}: ${key} is not a hard gate.`);
    for (const { id } of DIMENSIONS) {
      const { score = NOT_MEASURED, evidence = '' } = scored.dimensions?.[id] ?? {};
      if (score !== NOT_MEASURED && ![0, 1, 2, 3].includes(score)) fail(`${entry.id} ${id}: a score is 0 to 3 or "${NOT_MEASURED}", not ${JSON.stringify(score)}.`);
      if (score !== NOT_MEASURED && (typeof evidence !== 'string' || !evidence.trim())) fail(`${entry.id} ${id}: a score needs an excerpt from the run as evidence.`);
    }
    for (const { id } of GATES) {
      const { failed = NOT_MEASURED, evidence = '' } = scored.gates?.[id] ?? {};
      if (![true, false, NOT_MEASURED].includes(failed)) fail(`${entry.id} ${id}: failed is true, false or "${NOT_MEASURED}", not ${JSON.stringify(failed)}.`);
      if (failed === true && (typeof evidence !== 'string' || !evidence.trim())) fail(`${entry.id} ${id}: a failed gate needs an excerpt from the run as evidence.`);
    }
  }
  return { directory, run, collected, scores };
}
const scoreOf = (loaded, id, dimension) => loaded.scores.cases[id].dimensions?.[dimension]?.score ?? NOT_MEASURED;
const measured = value => typeof value === 'number';
const mean = values => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100;
const gateFailures = (loaded, label) => loaded.run.cases.flatMap(entry => [
  ...GATES.filter(g => loaded.scores.cases[entry.id].gates?.[g.id]?.failed === true).map(g => ({ run: label, id: entry.id, gate: g.id, evidence: loaded.scores.cases[entry.id].gates[g.id].evidence, automatic: false })),
  ...(loaded.collected.cases.find(c => c.id === entry.id)?.automaticGates ?? []).map(found => ({ run: label, id: entry.id, gate: found.gate, evidence: found.evidence, automatic: true })),
]);

// Per-case and per-family changes between two scored runs of the same case set. Every regression is listed on its
// own; a family's means use only cases scored in both runs, so "not measured" never counts as zero.
export async function compare(beforeDir, afterDir) {
  const before = await loadRun(beforeDir), after = await loadRun(afterDir);
  if (before.run.caseSet.version !== after.run.caseSet.version) fail(`The runs use different case sets: case set version ${before.run.caseSet.version} before, version ${after.run.caseSet.version} after. Compare runs of the same case set.`);
  if (before.run.caseSet.sha256 !== after.run.caseSet.sha256) fail(`The runs have different cases under the same version (${before.run.caseSet.version}). Bump the version whenever the cases change.`);
  const shared = before.run.cases.filter(entry => after.run.cases.some(other => other.id === entry.id));
  const cases = shared.map(entry => ({ id: entry.id, family: entry.family, split: entry.split,
    dimensions: DIMENSIONS.map(({ id }) => { const b = scoreOf(before, entry.id, id), a = scoreOf(after, entry.id, id); return { dimension: id, before: b, after: a, change: measured(b) && measured(a) ? a - b : null }; }) }));
  const regressions = cases.flatMap(c => c.dimensions.filter(d => d.change < 0).map(d => ({ id: c.id, family: c.family, dimension: d.dimension, before: d.before, after: d.after })));
  const families = [...new Set(cases.map(c => c.family))].map(family => {
    const inFamily = cases.filter(c => c.family === family);
    return { family, cases: inFamily.length, dimensions: DIMENSIONS.map(({ id }) => {
      const paired = inFamily.map(c => c.dimensions.find(d => d.dimension === id)).filter(d => d.change !== null);
      return { dimension: id, measured: paired.length, before: paired.length ? mean(paired.map(d => d.before)) : null, after: paired.length ? mean(paired.map(d => d.after)) : null,
        regressions: paired.filter(d => d.change < 0).length, improvements: paired.filter(d => d.change > 0).length };
    }) };
  });
  return { caseSetVersion: before.run.caseSet.version, before: { run: before.directory, guidanceSha256: before.run.guidance.sha256 }, after: { run: after.directory, guidanceSha256: after.run.guidance.sha256 },
    sameGuidance: before.run.guidance.sha256 === after.run.guidance.sha256,
    onlyIn: { before: before.run.cases.filter(e => !shared.includes(e)).map(e => e.id), after: after.run.cases.filter(e => !shared.some(s => s.id === e.id)).map(e => e.id) },
    gateFailures: [...gateFailures(before, 'before'), ...gateFailures(after, 'after')], regressions, cases, families };
}

const shown = value => (measured(value) ? String(value) : value);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
export function compareText(report) {
  const lines = [`Case set version ${report.caseSetVersion}. Guidance ${report.before.guidanceSha256.slice(0, 12)} before, ${report.after.guidanceSha256.slice(0, 12)} after${report.sameGuidance ? ' (the same guidance in both runs)' : ''}.`, ''];
  lines.push(report.gateFailures.length ? 'Hard gates failed (each fails its run, whatever the scores):' : 'Hard gates failed: none.');
  for (const f of report.gateFailures) lines.push(`  ${f.run.padEnd(6)}  ${f.id}  ${f.gate}${f.automatic ? ' (found by collect)' : ''}: ${f.evidence}`);
  lines.push('', report.regressions.length ? 'Regressions (each one, never averaged away):' : 'Regressions: none.');
  for (const r of report.regressions) lines.push(`  ${r.id}  ${r.dimension}  ${r.before} → ${r.after}`);
  if (report.onlyIn.before.length || report.onlyIn.after.length) lines.push('', `Not compared: only before ${report.onlyIn.before.join(', ') || 'none'}; only after ${report.onlyIn.after.join(', ') || 'none'}.`);
  lines.push('', 'By case:');
  for (const c of report.cases) {
    lines.push(`  ${c.id} (${c.family}, ${c.split})`);
    const scored = c.dimensions.filter(d => measured(d.before) || measured(d.after));
    if (!scored.length) lines.push('    nothing measured');
    for (const d of scored) lines.push(`    ${d.dimension}  ${shown(d.before)} → ${shown(d.after)}${d.change === null ? '' : ` (${d.change > 0 ? '+' : ''}${d.change})`}`);
  }
  lines.push('', 'By family (cases scored in both runs):');
  for (const f of report.families) {
    lines.push(`  ${f.family}`);
    const scored = f.dimensions.filter(d => d.measured);
    if (!scored.length) lines.push('    nothing scored in both runs');
    for (const d of scored) lines.push(`    ${d.dimension} ${d.before.toFixed(2)} → ${d.after.toFixed(2)} over ${plural(d.measured, 'case')}, ${plural(d.regressions, 'regression')}, ${plural(d.improvements, 'improvement')}`);
  }
  return lines.join('\n');
}

const usage = `Exploration benchmark: compare the explore skill's guidance before and after a change.

  node scripts/benchmark.mjs prepare --cases all|ID,... [--out DIR]
      One new workspace per case, run.json with the case-set version and guidance hash, and the manual steps.
  node scripts/benchmark.mjs collect --run DIR
      collected.json from the saved maps (read only) and a scores.json template, every dimension not measured.
  node scripts/benchmark.mjs compare --before DIR --after DIR
      Per-case and per-family changes, every regression, and hard-gate failures.

Never calls a model or starts an agent. See docs/exploration-benchmark.md.`;
function steps(directory, run) {
  const lines = [`Prepared ${plural(run.cases.length, 'case')} in ${directory}.`, `Case set version ${run.caseSet.version}; guidance ${run.guidance.sha256.slice(0, 12)} (${run.guidance.files.length} files).`, '',
    'For each case, in a new session of your own agent (your host and your cost), using this checkout\'s skills/explore:',
    '  1. Start Explore on the case\'s workspace (its command is below) and open the address it prints. The first job is queued.',
    '  2. Ask the agent to use the explore skill with --workspace set to that folder and to work the queued jobs.',
    '  3. Answer each question in the browser only from the case\'s persona in docs/exploration-benchmark-cases.json; if the persona does not say, answer "I don\'t know."',
    '     Activate, accept and dismiss nothing.',
    '  4. Stop after a round with no questions, or after three rounds, then stop the server.', ''];
  for (const entry of run.cases) lines.push(`  ${entry.id}${entry.split === 'held-out' ? ' (held out)' : ''}:`, `    node skills/explore/scripts/server.mjs --workspace "${path.join(directory, entry.workspace)}" --port 0`);
  lines.push('', `Then: node scripts/benchmark.mjs collect --run "${directory}"`);
  return lines.join('\n');
}
async function main(args) {
  const option = name => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const required = name => option(name) ?? fail(`--${name} is required.\n\n${usage}`);
  switch (args[0]) {
    case 'prepare': { const out = path.resolve(option('out') ?? defaultRun()); console.log(steps(out, await prepare({ cases: option('cases') ?? 'all', out }))); break; }
    case 'collect': {
      const directory = path.resolve(required('run')), collected = await collect(directory);
      console.log(`Collected ${plural(collected.cases.length, 'case')} into ${path.join(directory, 'collected.json')}.\nScore each one in ${path.join(directory, 'scores.json')} with the rubric in docs/exploration-benchmark.md.`);
      break;
    }
    case 'compare': { const report = await compare(required('before'), required('after')); console.log(compareText(report)); if (report.gateFailures.some(f => f.run === 'after')) process.exitCode = 1; break; }
    default: console.error(usage); process.exitCode = 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
