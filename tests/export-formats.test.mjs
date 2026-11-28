import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportAs, exportScope, exportFormats } from '../skills/explore/assets/export-formats.js';
import { Store } from '../skills/explore/scripts/store.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { packageFiles } from '../skills/explore/scripts/doctor.mjs';

// Diagram and document exports (I3, #41). Illustrative maps only, never ideas/.
const node = (id, parentId, extra = {}) => ({ id, parentId, title: `Idea ${id}`, kind: 'research', prompt: `Premise ${id}.`, body: `Premise ${id}.`, summary: `Premise ${id}.`,
  status: 'suggested', reviewState: 'unreviewed', stale: false, questions: [], sources: [], ...extra });
function fixture(titles = {}) {
  const nodes = [
    node('root', null, { kind: 'idea', title: 'Field notebook', status: 'explored', summary: 'Sync matters most.', body: 'Findings about sync.' }),
    node('sync', 'root', { title: 'Syncing', status: 'explored', reviewState: 'accepted', summary: 'Merge by hand.', body: 'Keep both copies.',
      questions: [{ id: 'q1', text: 'Who edits?', answer: 'Two of us.', answerState: 'decided' }, { id: 'q2', text: 'Which phones?', answer: null }],
      sources: [{ title: 'Field study', url: 'https://example.org/study', note: 'Teams used solar chargers.' }] }),
    node('power', 'sync', { title: 'Power', status: 'explored', stale: true, summary: 'Batteries last a day.', body: 'Batteries last a day in the field.' }),
    node('photos', 'root', { title: 'Photos', status: 'awaiting-answer', summary: 'Photos are large.', body: 'Compress them.',
      questions: [{ id: 'q3', text: 'How many photos a day?', answer: null }, { id: 'q4', text: 'Colour or grey?', answer: null, deferredAt: 'x' }],
      sources: [{ title: 'Camera notes', url: 'javascript:alert(1)', note: 'Not a web address.' }] }),
    node('later', 'photos', { title: 'Later idea' }),
  ].map(entry => ({ ...entry, ...(titles[entry.id] ? { title: titles[entry.id] } : {}) }));
  return { schemaVersion: 1, id: 'map-0000000a', title: nodes[0].title, rootId: 'root', revision: 4, nodes,
    edges: [...nodes.slice(1).map(entry => ({ from: entry.parentId, to: entry.id, type: 'contains' })), { from: 'power', to: 'photos', type: 'depends_on' }, { from: 'later', to: 'sync', type: 'supports', addedBy: 'user', note: 'A note.' }],
    jobs: [{ id: 'job-00000001', nodeId: 'root', status: 'running', claimKey: 'claim-secret-value', worker: 'worker-name-7' }],
    growth: { batches: [{ nodeIds: ['root'] }] }, history: [], view: { positions: {} } };
}
const forbidden = [/claim-secret-value/, /claimKey/, /worker-name-7/, /job-00000001/, /map\.json/, /ideas[\\/]/];

test('a branch export holds exactly that idea and everything below it, in every format', () => {
  const map = fixture();
  assert.deepEqual(exportScope(map, 'photos').nodes.map(entry => entry.id), ['photos', 'later']);
  assert.deepEqual(exportScope(map).nodes.map(entry => entry.id), ['root', 'sync', 'power', 'photos', 'later']);
  assert.throws(() => exportScope(map, 'node-missing'), /not in this map/);
  const branch = format => exportAs(map, format, { nodeId: 'photos' }).text;
  assert.equal(branch('mermaid').split('\n').filter(line => /^ {2}n\d+\["/.test(line)).length, 2);
  assert.equal(JSON.parse(branch('canvas')).nodes.length, 2);
  assert.equal((branch('svg').match(/<circle /g) || []).length, 2);
  assert.equal((branch('print').match(/<section class="idea"/g) || []).length, 2);
  for (const format of Object.keys(exportFormats)) {
    const text = branch(format);
    assert.doesNotMatch(text, /Syncing|Field notebook — Power|Batteries last/, `${format}: no ancestors or siblings`);
  }
  // Links count only when both ends are in scope.
  assert.doesNotMatch(branch('mermaid'), /supports|depends on/);
  assert.match(exportAs(map, 'mermaid').text, /n2 -\.->\|depends on\| n3/);
  assert.match(exportAs(map, 'mermaid').text, /n4 -\.->\|supports\| n1/);
});

test('hostile titles never change the Mermaid structure', () => {
  const map = fixture({ sync: 'He said "hi"] --> x', power: '%%{init: {"theme":"dark"}}%%', photos: 'Pics\nclick n0 href "javascript:alert(1)"', later: 'click n1 call alert(); #quot; `md` <b>x</b>' });
  const text = exportAs(map, 'mermaid').text, lines = text.trimEnd().split('\n');
  assert.equal(lines[0], 'flowchart TD');
  for (const line of lines.slice(1)) assert.match(line, /^ {2}(n\d+\["[^"\n]*"\]|n\d+ --> n\d+|n\d+ -\.->\|[a-z ]+\| n\d+)$/, line);
  assert.doesNotMatch(text, /%%/); assert.doesNotMatch(text, /^\s*click/m); assert.doesNotMatch(text, /<b>|`/);
  assert.match(text, /He said #34;hi#34;#93; --#62; x/, 'quotes and brackets become entity codes');
  assert.match(exportAs(fixture({ sync: 'Sync — the team’s “best” option…' }), 'mermaid').text, /\["Sync — the team’s “best” option…<br\/>/, 'typographic punctuation stays readable');
});

test('JSON Canvas follows the 1.0 shapes, and cards never overlap', async () => {
  const canvas = JSON.parse(exportAs(fixture(), 'canvas').text);
  const ids = new Set(canvas.nodes.map(card => card.id));
  for (const card of canvas.nodes) {
    assert.deepEqual(Object.keys(card).sort(), ['height', 'id', 'text', 'type', 'width', 'x', 'y']);
    assert.equal(card.type, 'text'); for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(card[key]), key);
  }
  for (const edge of canvas.edges) {
    for (const key of Object.keys(edge)) assert.ok(['id', 'fromNode', 'fromSide', 'fromEnd', 'toNode', 'toSide', 'toEnd', 'color', 'label'].includes(key), key);
    assert.ok(ids.has(edge.fromNode) && ids.has(edge.toNode));
  }
  assert.deepEqual(canvas.edges.filter(edge => edge.label).map(edge => edge.label).sort(), ['depends on', 'supports']);
  const overlaps = cards => cards.some((a, i) => cards.slice(i + 1).some(b => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'export-')), 'ideas'));
  const demo = await store.demo();
  assert.equal(overlaps(JSON.parse(exportAs(demo, 'canvas').text).nodes), false, 'the demo map');
  // Saved positions piled on one spot still give separate cards.
  const crowded = fixture(); crowded.view.positions = Object.fromEntries(crowded.nodes.map(entry => [entry.id, { x: 10, y: 10 }]));
  assert.equal(overlaps(JSON.parse(exportAs(crowded, 'canvas').text).nodes), false, 'a crowded map');
});

test('the SVG has no script, foreign content, events or external references, and hostile titles stay text', () => {
  const text = exportAs(fixture({ sync: '<script>alert(1)</script>', power: '<foreignObject onload="x()"><a href="https://evil.example">', photos: 'Bell\u0007 & "quotes"' }), 'svg').text;
  assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // Markup only: a hostile title may say href= or https: as escaped text, which is harmless.
  const markup = text.replace(/>[^<]*</g, '><');
  assert.doesNotMatch(markup, /<script|<foreignObject|<a[\s>]|<image|<use|\son[a-z]+=|href=|url\(|@import/i);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/, 'no character XML forbids');
  assert.equal((markup.match(/https?:/g) || []).length, 1, 'only the SVG namespace');
  assert.match(text, />&lt;foreignObject</); assert.match(text, />onload=&quot;x\(\)&quot;&gt;&lt;a</, 'wrapped, but still text');
  assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('the printable page has no script and includes every answer and source in scope', () => {
  const map = fixture({ later: '</style><script>alert(1)</script>' });
  const text = exportAs(map, 'print').text;
  assert.doesNotMatch(text, /<script/i);
  assert.match(text, /Content-Security-Policy" content="default-src 'none'/); assert.match(text, /@media print/);
  for (const expected of ['Two of us.', 'Decided', 'Which phones?', 'Waiting for an answer', 'Saved for later', 'Field study', 'https://example.org/study', 'Teams used solar chargers.', 'Camera notes', 'Not a web address.', '&lt;/style&gt;&lt;script&gt;'])
    assert.ok(text.includes(expected), expected);
  assert.match(text, /<a href="https:\/\/example\.org\/study">/); assert.doesNotMatch(text, /href="javascript/i, 'only web addresses become links');
});

test('every format shows unreviewed and needs-review states, and none carries jobs, workers or paths', () => {
  for (const format of Object.keys(exportFormats)) {
    const text = exportAs(fixture(), format).text;
    assert.match(text, /needs review/, `${format}: a stale finding`); assert.match(text, /unreviewed/, `${format}: an unreviewed finding`);
    assert.match(text, /accepted/, `${format}: an accepted finding`);
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${format}: ${pattern}`);
  }
});

test('an oversized scope is refused with a suggestion, never cut short', () => {
  const big = fixture(); big.nodes.push(...Array.from({ length: 497 }, (_, i) => node(`n${i}`, 'root')));
  assert.throws(() => exportAs(big, 'mermaid'), error => /502 ideas/.test(error.message) && /at most 500/.test(error.message) && /branch/.test(error.message));
  const long = fixture(); long.nodes.push(...Array.from({ length: 300 }, (_, i) => node(`n${i}`, 'root', { status: 'explored', body: 'Long findings. '.repeat(1100) })));
  assert.throws(() => exportAs(long, 'print'), error => /4 MiB/.test(error.message) && /branch/.test(error.message));
});

test('file names follow the map, or the map and branch', () => {
  assert.deepEqual([exportAs(fixture(), 'mermaid').filename, exportAs(fixture(), 'canvas', { nodeId: 'photos' }).filename], ['Field notebook.mmd', 'Field notebook - Photos.canvas']);
  assert.deepEqual([exportAs(fixture(), 'svg').filename, exportAs(fixture(), 'print').filename], ['Field notebook.svg', 'Field notebook.html']);
});

test('the CLI writes each format for a map or a branch, refuses to overwrite, and the assets are served and packaged', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'export-cli-'));
  const app = await startServer({ workspace: dir, port: 0 });
  const cli = args => promisify(execFile)(process.execPath, [path.resolve('skills/explore/scripts/cli.mjs'), ...args, '--workspace', dir]);
  try {
    const map = await app.store.demo(), branch = map.nodes[1];
    await cli(['export', '--map', map.id, '--format', 'mermaid', '--out', path.join(dir, 'map.mmd')]);
    assert.match(await readFile(path.join(dir, 'map.mmd'), 'utf8'), /^flowchart TD/);
    await cli(['export', '--map', map.id, '--format', 'canvas', '--node', branch.id, '--out', path.join(dir, 'branch.canvas')]);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'branch.canvas'), 'utf8')).nodes.length, exportScope(map, branch.id).nodes.length);
    await writeFile(path.join(dir, 'taken.svg'), 'keep');
    await assert.rejects(cli(['export', '--map', map.id, '--format', 'svg', '--out', path.join(dir, 'taken.svg')]), /already exists/);
    assert.equal(await readFile(path.join(dir, 'taken.svg'), 'utf8'), 'keep');
    await assert.rejects(cli(['export', '--map', map.id, '--format', 'pdf', '--out', path.join(dir, 'x.pdf')]), /--format must be/);
    for (const file of ['export-formats.js', 'export-dialog.js']) {
      assert.ok(packageFiles.includes(`assets/${file}`), file);
      assert.equal((await fetch(`${app.address}/${file}`)).status, 200, file);
    }
  } finally { await app.close(); }
});
