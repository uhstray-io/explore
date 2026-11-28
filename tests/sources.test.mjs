import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { sourceLibrary, normalizeSourceUrl, sourcesHtml } from '../skills/explore/assets/sources.js';

// Map-wide source library (K10, #56). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const source = (url, extra = {}) => ({ title: `Title of ${url}`, url, note: 'A note.', retrievedAt: '2026-01-01T00:00:00.000Z', ...extra });
const idea = (id, sources = [], extra = {}) => ({ id, parentId: id === 'root' ? null : 'root', title: `Idea ${id}`, summary: `Summary ${id}`, body: `Body ${id}`, status: 'explored', reviewState: 'unreviewed', questions: [], sources, ...extra });
const library = map => sourceLibrary({ id: 'map-1', rootId: 'root', jobs: [], edges: [], ...map });

test('citations of one URL group together, ignoring the fragment and a trailing slash but keeping the query', () => {
  assert.equal(normalizeSourceUrl('https://example.org/docs/#offline'), 'https://example.org/docs');
  assert.equal(normalizeSourceUrl('https://example.org/'), 'https://example.org/', 'the root keeps its slash');
  assert.equal(normalizeSourceUrl('https://example.org/a?v=2#x'), 'https://example.org/a?v=2');
  const entries = library({ nodes: [idea('root'), idea('a', [source('https://example.org/docs#offline')]), idea('b', [source('https://example.org/docs/', { title: 'Docs' })]), idea('c', [source('https://example.org/docs?v=2')])] });
  const docs = entries.find(entry => entry.url === 'https://example.org/docs');
  assert.deepEqual(docs.citations.map(citation => citation.nodeId), ['a', 'b']); assert.deepEqual(docs.titles, ['Title of https://example.org/docs#offline', 'Docs']);
  assert.equal(docs.host, 'example.org'); assert.equal(entries.length, 2, 'the query keeps a different page apart');
});

test('a source cited by two contradicting ideas is flagged unless one cites it as a challenge; for and against is a note', () => {
  const nodes = [idea('root'), idea('a', [source('https://e.org/x', { stance: 'supports' })]), idea('b', [source('https://e.org/x')]), idea('c', [source('https://e.org/y', { stance: 'supports' })]), idea('d', [source('https://e.org/y', { stance: 'challenges' })])];
  const edges = [{ from: 'b', to: 'a', type: 'contradicts' }, { from: 'c', to: 'd', type: 'contradicts' }];
  const entries = library({ nodes, edges });
  const x = entries.find(entry => entry.url === 'https://e.org/x'), y = entries.find(entry => entry.url === 'https://e.org/y');
  assert.deepEqual(x.flags, [{ nodeIds: ['a', 'b'], text: 'Cited in support of findings that contradict each other' }]);
  assert.deepEqual(y.flags, [], 'one citation marked challenges is no conflict'); assert.equal(y.forAndAgainst, true); assert.equal(x.forAndAgainst, false);
  assert.deepEqual(x.counts, { supports: 1, challenges: 0, context: 0, unrecorded: 1 });
  assert.equal(entries[0], x, 'flagged sources come first');
});

test('earlier results are listed and labelled, and never flag; claims that cite a source are listed under it', () => {
  const old = { id: 'job-old', nodeId: 'a', status: 'completed', stale: true, result: { summary: 'Old.', body: 'Old body.', sources: [source('https://e.org/z')] } };
  const current = { id: 'job-new', nodeId: 'a', status: 'completed', result: { summary: 'Summary a', body: 'Body a', sources: [source('https://e.org/x')] } };
  const nodes = [idea('root'), idea('a', [source('https://e.org/x')], { claims: [{ id: 'c1', text: 'Works offline.', support: [{ source: 'https://e.org/x', passage: 'Stored first.' }] }] }), idea('b', [source('https://e.org/z')])];
  const entries = library({ nodes, jobs: [old, current], edges: [{ from: 'a', to: 'b', type: 'contradicts' }] });
  const z = entries.find(entry => entry.url === 'https://e.org/z');
  assert.deepEqual(z.citations.map(citation => [citation.nodeId, citation.earlier]), [['b', false], ['a', true]], 'current citations first, then earlier results');
  assert.deepEqual(z.flags, [], 'an earlier result never causes a flag'); assert.equal(z.ideas, 1, 'only current citations count as citing ideas');
  const x = entries.find(entry => entry.url === 'https://e.org/x');
  assert.deepEqual(x.citations.length, 1, 'the current result is not listed twice'); assert.deepEqual(x.citations[0].claims, ['Works offline.']);
});

test('the dialog lists each source with its counts, flags and citing ideas; it filters and says when it shows growth history', () => {
  const nodes = [idea('root'), idea('a', [source('https://e.org/x', { title: 'Vendor <docs>' })]), idea('b', [source('https://e.org/x', { stance: 'supports' })])];
  const entries = library({ nodes, edges: [{ from: 'a', to: 'b', type: 'contradicts' }] });
  const html = sourcesHtml(entries, { esc, query: '', flaggedOnly: false, historic: false });
  assert.match(html, /<a href="https:\/\/e\.org\/x" target="_blank" rel="noreferrer">Vendor &lt;docs&gt;<\/a>/); assert.doesNotMatch(html, /<docs>/);
  assert.match(html, /e\.org · 2 ideas · 1 supports · 1 stance not recorded/);
  assert.match(html, /Cited in support of findings that contradict each other: Idea a and Idea b/);
  assert.match(html, /<button type="button" class="relationship" data-focus-node="a">Idea a<\/button><small>Stance not recorded<\/small>/);
  assert.doesNotMatch(sourcesHtml(entries, { esc, query: 'nothing like it', flaggedOnly: false, historic: false }), /Vendor/);
  assert.match(sourcesHtml(entries, { esc, query: 'vendor', flaggedOnly: true, historic: true }), /reflects today's content[\s\S]*Vendor/);
  assert.match(sourcesHtml([], { esc, query: '', flaggedOnly: false, historic: false }), /No sources are cited on this map yet\./);
});

async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'sources-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  return { store, map, job, deliver: sources => store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', sources }) };
}

test('a result can say whether each source supports, challenges or gives context; any other stance rejects it', async () => {
  let { store, map, deliver } = await workspace();
  const before = await readFile(store.file(map.id), 'utf8');
  await assert.rejects(deliver([{ title: 'T', url: 'https://e.org/x', note: 'N.', stance: 'agrees' }]), error => error.status === 400 && /supports, challenges or context/.test(error.message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await deliver([{ title: 'Docs', url: 'https://e.org/x', note: 'Works offline.', stance: 'supports' }, { title: 'Report', url: 'https://e.org/y', note: 'Unclear.' }]);
  assert.equal(saved.nodes[0].sources[0].stance, 'supports'); assert.equal(Object.hasOwn(saved.nodes[0].sources[1], 'stance'), false, 'none given, none stored');
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /- \[Docs\]\(https:\/\/e\.org\/x\) \(supports; retrieved [^)]+\): Works offline\./);
  assert.match(markdown, /- \[Report\]\(https:\/\/e\.org\/y\) \(retrieved [^)]+\): Unclear\./, 'an unrecorded stance adds nothing');
  const read = contextExcerpt(saved, map.rootId, { section: 'sources' });
  assert.match(read.excerpt, /Stance: supports/); assert.match(read.excerpt, /Stance: not recorded/);
});
