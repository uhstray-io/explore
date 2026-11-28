import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { validateMap } from '../skills/explore/scripts/map-validation.mjs';
import { sourceList } from '../skills/explore/scripts/fields.mjs';
import { sourceLibrary, normalizeSourceUrl, sourcesHtml, matchingSources } from '../skills/explore/assets/sources.js';
import { sourcesDialog } from '../skills/explore/assets/sources-dialog.js';
import { readOnlyNote } from '../skills/explore/assets/history.js';

// Map-wide source library (K10, #56). Illustrative fixtures only, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const source = (url, extra = {}) => ({ title: `Title of ${url}`, url, note: 'A note.', retrievedAt: '2026-01-01T00:00:00.000Z', ...extra });
const idea = (id, sources = [], extra = {}) => ({ id, parentId: id === 'root' ? null : 'root', title: `Idea ${id}`, summary: `Summary ${id}`, body: `Body ${id}`, status: 'explored', reviewState: 'unreviewed', questions: [], sources, ...extra });
const library = map => sourceLibrary({ id: 'map-1', rootId: 'root', jobs: [], edges: [], ...map });
const entryOf = (entries, url) => entries.find(entry => entry.url === url);
const html = (entries, options = {}) => sourcesHtml(entries, { esc, query: '', flaggedOnly: false, note: '', ...options });

test('citations of one URL group together, ignoring the fragment, a trailing slash and an empty query but keeping a query', () => {
  assert.equal(normalizeSourceUrl('https://example.org/docs/#offline'), 'https://example.org/docs');
  assert.equal(normalizeSourceUrl('https://example.org/'), 'https://example.org/', 'the root keeps its slash');
  assert.equal(normalizeSourceUrl('https://example.org/a?v=2#x'), 'https://example.org/a?v=2');
  assert.equal(normalizeSourceUrl('https://example.org/a?'), 'https://example.org/a');
  const entries = library({ nodes: [idea('root'), idea('a', [source('https://example.org/docs#offline')]), idea('b', [source('https://example.org/docs/', { title: 'Docs' })]), idea('c', [source('https://example.org/docs?v=2')])] });
  const docs = entryOf(entries, 'https://example.org/docs');
  assert.deepEqual(docs.citations.map(citation => citation.nodeId), ['a', 'b']); assert.deepEqual(docs.titles, ['Title of https://example.org/docs#offline', 'Docs']);
  assert.equal(docs.host, 'example.org'); assert.equal(entries.length, 2, 'the query keeps a different page apart');
});

test('a source backing two ideas linked as contradicting each other is flagged, unless one cites it as a challenge', () => {
  const nodes = [idea('root'), idea('a', [source('https://e.org/x', { stance: 'supports' })]), idea('b', [source('https://e.org/x')]), idea('c', [source('https://e.org/y', { stance: 'supports' })]), idea('d', [source('https://e.org/y', { stance: 'challenges' })]),
    idea('e', [source('https://e.org/z', { stance: 'context' })]), idea('f', [source('https://e.org/z', { stance: 'supports' })]), idea('g', [source('https://e.org/w')]), idea('h', [source('https://e.org/w')])];
  const edges = [{ from: 'b', to: 'a', type: 'contradicts' }, { from: 'a', to: 'b', type: 'contradicts' }, { from: 'c', to: 'd', type: 'contradicts' }, { from: 'e', to: 'f', type: 'contradicts' },
    { from: 'g', to: 'h', type: 'supports' }, { from: 'g', to: 'g', type: 'contradicts' }];
  const entries = library({ nodes, edges });
  assert.deepEqual(entryOf(entries, 'https://e.org/x').flags, [{ nodeIds: ['a', 'b'], text: 'Cited in support of findings that contradict each other' }], 'links both ways are one flag');
  assert.deepEqual(entryOf(entries, 'https://e.org/y').flags, [], 'a citation as a challenge is no conflict');
  assert.equal(entryOf(entries, 'https://e.org/z').flags.length, 1, 'giving context is not a challenge');
  assert.deepEqual(entryOf(entries, 'https://e.org/w').flags, [], 'only contradicts links between two ideas flag');
  assert.deepEqual(entryOf(entries, 'https://e.org/x').counts, { supports: 1, challenges: 0, context: 0, unrecorded: 1 });
  assert.equal(entries[0].flags.length + entries[1].flags.length, 2, 'flagged sources come first');
});

test('for and against needs one idea citing it in support and another as a challenge', () => {
  const both = library({ nodes: [idea('root'), idea('a', [source('https://e.org/x', { stance: 'supports' })]), idea('b', [source('https://e.org/x', { stance: 'challenges' })])] });
  assert.equal(both[0].forAndAgainst, true);
  const one = library({ nodes: [idea('root'), idea('a', [source('https://e.org/x#one', { stance: 'supports' }), source('https://e.org/x#two', { stance: 'challenges' })])] });
  assert.equal(one[0].forAndAgainst, false, 'one idea citing two parts of a page both ways is not two places');
});

test('earlier results are listed and labelled, never flag and never count; only investigation results are earlier results', () => {
  const stale = { id: 'job-stale', nodeId: 'a', status: 'completed', stale: true, result: { summary: 'Summary a', body: 'Body a', sources: [source('https://e.org/z')] } };
  const replaced = { id: 'job-replaced', nodeId: 'b', status: 'completed', result: { summary: 'Summary b', body: 'An older body.', sources: [source('https://e.org/z', { stance: 'supports' })] } };
  const resummarised = { id: 'job-resummarised', nodeId: 'b', status: 'completed', result: { summary: 'An older summary.', body: 'Body b', sources: [source('https://e.org/v')] } };
  const current = { id: 'job-current', nodeId: 'a', status: 'completed', result: { summary: 'Summary a', body: 'Body a', sources: [source('https://e.org/x')] } };
  const other = { id: 'job-tidy', type: 'tidy', nodeId: 'a', status: 'completed', result: { summary: 'Other', body: 'Other', sources: [source('https://e.org/other')] } };
  const nodes = [idea('root'), idea('a', [source('https://e.org/x')], { claims: [{ id: 'c1', text: 'Works offline.', support: [{ source: 'https://e.org/x#part', passage: 'Stored first.' }] }] }), idea('b', [source('https://e.org/z')])];
  const entries = library({ nodes, jobs: [stale, replaced, resummarised, current, other], edges: [{ from: 'a', to: 'b', type: 'contradicts' }] });
  const z = entryOf(entries, 'https://e.org/z');
  assert.deepEqual(z.citations.map(citation => [citation.nodeId, citation.from]), [['b', 'idea'], ['a', 'earlier'], ['b', 'earlier']], 'current citations first, then earlier results');
  assert.deepEqual(z.flags, [], 'an earlier result never causes a flag'); assert.equal(z.ideas, 1); assert.equal(z.earlier, 2);
  assert.deepEqual(z.counts, { supports: 0, challenges: 0, context: 0, unrecorded: 1 }, 'earlier citations are not counted by stance');
  assert.ok(entryOf(entries, 'https://e.org/v'), 'a changed summary makes a result earlier too');
  assert.equal(entryOf(entries, 'https://e.org/other'), undefined, 'other job types are not investigation results');
  const x = entryOf(entries, 'https://e.org/x');
  assert.equal(x.citations.length, 1, 'the current result is not listed twice'); assert.deepEqual(x.citations[0].claims, ['Works offline.']);
  const onlyEarlier = library({ nodes: [idea('root'), idea('a')], jobs: [{ ...stale, result: { ...stale.result, sources: [source('https://e.org/q')] } }] });
  assert.match(html(onlyEarlier), /e\.org · 1 earlier result</, 'a source cited only by an earlier result says so, not "0 ideas"');
});

test('Help me answer research is listed under its idea and question, labelled, with no stance, and never flags', () => {
  const research = { id: 'job-r', type: 'question-research', subjectId: 'q1', nodeId: 'a', status: 'completed', result: { summary: 'S', sources: [source('https://e.org/x', { stance: 'supports' })] } };
  const nodes = [idea('root'), idea('a', [], { questions: [{ id: 'q1', text: 'Which phones first?', answer: null }] }), idea('b', [source('https://e.org/x')])];
  const entries = library({ nodes, jobs: [research], edges: [{ from: 'a', to: 'b', type: 'contradicts' }] });
  const x = entryOf(entries, 'https://e.org/x');
  assert.deepEqual(x.citations.map(citation => [citation.nodeId, citation.from, citation.stance]), [['b', 'idea', null], ['a', 'help', null]]);
  assert.deepEqual(x.flags, []); assert.equal(x.help, 1); assert.equal(x.ideas, 1);
  assert.match(html(entries), /data-focus-node="a">Help me answer<strong>Idea a<\/strong><\/button><p class="source-claim">Question: Which phones first\?<\/p>/);
  assert.match(html(entries), /e\.org · 1 idea · 1 in Help me answer · 1 stance not recorded/);
});

test('the dialog lists each source with its counts, flags and citing ideas, escaping everything it shows', () => {
  const evil = '<img src=x>';
  const nodes = [idea('root'), idea('a', [source('https://e.org/x?q="<b>"', { title: `Vendor ${evil}`, note: `Note ${evil}` })], { title: `Idea ${evil}`, claims: [{ id: 'c', text: `Claim ${evil}`, support: [{ source: 'https://e.org/x?q="<b>"' }] }] }),
    idea('b', [source('https://e.org/x?q="<b>"', { stance: 'supports' })])];
  const out = html(library({ nodes, edges: [{ from: 'a', to: 'b', type: 'contradicts' }] }));
  assert.doesNotMatch(out, /<img/); assert.doesNotMatch(out, /href="[^"]*"<b>/, 'the address is escaped');
  assert.match(out, /<a href="https:\/\/e\.org\/x\?q=&quot;&lt;b&gt;&quot;" target="_blank" rel="noopener noreferrer">Vendor &lt;img src=x&gt; <span aria-hidden="true">↗<\/span><\/a>/);
  assert.match(out, /e\.org · 2 ideas · 1 supports · 1 stance not recorded/);
  assert.match(out, /Cited in support of findings that contradict each other: Idea &lt;img src=x&gt; and Idea b/);
  assert.match(out, /<button type="button" class="relationship" data-focus-node="a">Stance not recorded<strong>Idea &lt;img src=x&gt;<\/strong><\/button><p>Note &lt;img src=x&gt;<\/p><p class="source-claim">Claim: Claim &lt;img src=x&gt;<\/p>/);
  assert.match(out, /data-focus-node="b">Supports<strong>Idea b<\/strong>/);
  assert.match(html(library({ nodes: [idea('root'), idea('a', [source('https://e.org/x', { stance: 'supports' })]), idea('b', [source('https://e.org/x', { stance: 'challenges' })])] })), /<p class="source-note">Cited both for and against<\/p>/);
  const earlier = library({ nodes: [idea('root'), idea('a')], jobs: [{ id: 'j', nodeId: 'a', status: 'completed', stale: true, result: { summary: 'S', body: 'B', sources: [source('https://e.org/q', { stance: 'challenges' })] } }] });
  assert.match(html(earlier), />Challenges · earlier result<strong>Idea a<\/strong>/);
  assert.match(html([]), /No sources are cited on this map yet\./); assert.match(html([], { note: 'At an earlier step.' }), /At an earlier step\.<\/p><p class="form-note">No sources are cited on these ideas\./);
});

test('the list filters by title, site, citing idea or note, keeps flagged sources only when asked, and sorts by citing ideas', () => {
  // two.org has the most citing ideas, three.org is flagged (b and c contradict each other), one.org has one.
  const nodes = [idea('root'), idea('a', [source('https://one.org/p', { note: 'Battery figures.' }), source('https://two.org/p')]), idea('b', [source('https://two.org/p'), source('https://three.org/p')]),
    idea('c', [source('https://three.org/p')]), idea('d', [source('https://two.org/p')]), idea('e', [source('https://four.org/p')])];
  const entries = library({ nodes, edges: [{ from: 'b', to: 'c', type: 'contradicts' }] });
  assert.deepEqual(entries.map(entry => entry.host), ['three.org', 'two.org', 'four.org', 'one.org'], 'flagged first, then by the number of citing ideas, then by title');
  const hosts = options => matchingSources(entries, { query: '', flaggedOnly: false, ...options }).map(entry => entry.host);
  assert.deepEqual(hosts({ query: 'battery' }), ['one.org'], 'by a note'); assert.deepEqual(hosts({ query: 'ONE.ORG' }), ['one.org'], 'by site, ignoring case');
  assert.deepEqual(hosts({ query: 'idea c' }), ['three.org'], 'by a citing idea'); assert.deepEqual(hosts({ flaggedOnly: true }), ['three.org']);
  assert.match(html(entries, { query: 'nothing like it' }), /No sources match\./); assert.doesNotMatch(html(entries, { flaggedOnly: true }), /one\.org/);
});

// A small fake DOM for the dialog: elements by ID, with listeners and a modal state.
function fakeDialog({ map, note = () => '' }) {
  const elements = new Map(), focused = [];
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', textContent: '', value: '', checked: false, open: false, writes: 0,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { (handlers[type] || []).forEach(fn => fn(event)); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() { focused.push(id); } });
    }
    return elements.get(id);
  };
  const body = element('sources-body');
  let html = '';
  Object.defineProperty(body, 'innerHTML', { get: () => html, set: value => { html = value; body.writes++; } });
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const chosen = [];
  const dialog = sourcesDialog({ esc, map, note, focusNode: id => chosen.push(id) });
  return { element, focused, chosen, dialog };
}

test('the dialog opens from Map tools, filters, follows the map while open, and choosing an idea closes it and focuses that idea', () => {
  let map = { id: 'map-1', rootId: 'root', jobs: [], edges: [{ from: 'a', to: 'b', type: 'contradicts' }], nodes: [idea('root'), idea('a', [source('https://e.org/x')]), idea('b', [source('https://e.org/x'), source('https://f.org/y')])] };
  const io = fakeDialog({ map: () => map });
  try {
    io.element('tools-dialog').open = true; io.element('sources-filter').value = 'old'; io.element('sources-flagged').checked = true;
    io.element('sources-open').fire('click');
    assert.equal(io.element('sources-dialog').open, true); assert.equal(io.element('tools-dialog').open, false); assert.deepEqual(io.focused, ['sources-filter']);
    assert.equal(io.element('sources-filter').value, '', 'each opening starts unfiltered'); assert.equal(io.element('sources-flagged').checked, false);
    assert.match(io.element('sources-summary').textContent, /^2 sources cited across the map · 1 flagged\. Your agent's reading of its sources, not a verification\.$/);
    assert.equal(io.element('sources-count').textContent, '2 sources shown');
    io.element('sources-flagged').checked = true; io.element('sources-flagged').fire('change');
    assert.equal(io.element('sources-count').textContent, '1 source shown'); assert.doesNotMatch(io.element('sources-body').innerHTML, /f\.org/);
    const writes = io.element('sources-body').writes;
    io.element('sources-filter').fire('input');
    assert.equal(io.element('sources-body').writes, writes, 'the same list is not written again');
    map = { ...map, nodes: [...map.nodes, idea('c', [source('https://g.org/z')])] }; io.element('sources-flagged').checked = false;
    io.dialog.mapChanged();
    assert.match(io.element('sources-body').innerHTML, /g\.org/, 'a map change redraws the open dialog'); assert.match(io.element('sources-summary').textContent, /^3 sources/);
    io.element('sources-body').fire('click', { target: { closest: () => ({ dataset: { focusNode: 'b' } }) } });
    assert.equal(io.element('sources-dialog').open, false); assert.deepEqual(io.chosen, ['b']);
  } finally { delete globalThis.document; }
});

test('in growth history or a saved version the dialog shows the inspector\'s own read-only note and says it covers the ideas shown', () => {
  const at = '2026-03-01T10:00:00.000Z';
  assert.equal(readOnlyNote({ historyStep: null }), '');
  assert.equal(readOnlyNote({ historyStep: 2, versionPreview: null }), 'Read-only growth history. These are today’s findings and status, not a past version of the research.');
  const saved = readOnlyNote({ historyStep: 0, versionPreview: { version: { at } } });
  assert.match(saved, /^A saved version from .+, read-only\. These are the findings and status as they were then\.$/);
  const map = { id: 'map-1', rootId: 'root', jobs: [], edges: [], nodes: [idea('root', [source('https://e.org/x')])] };
  const io = fakeDialog({ map: () => map, note: () => saved });
  try {
    io.element('sources-open').fire('click');
    assert.match(io.element('sources-body').innerHTML, /^<p class="form-note">A saved version from .+ as they were then\.<\/p>/); assert.doesNotMatch(io.element('sources-body').innerHTML, /today/);
    assert.match(io.element('sources-summary').textContent, /^1 source cited on the ideas shown\./);
  } finally { delete globalThis.document; }
});

test('a pulled map with a stance that is not one is reported, and generated views never print it', () => {
  const map = { schemaVersion: 1, id: 'map-1', title: 'T', rootId: 'root', nodes: [idea('root', [source('https://e.org/x', { stance: 'agrees' }), source('https://e.org/y', { stance: { not: 'text' } })])], edges: [], jobs: [], history: [] };
  const { errors } = validateMap(map);
  assert.deepEqual(errors.filter(error => /stance/.test(error.at)).map(error => error.code), ['unknown-value', 'unknown-value']);
  const read = contextExcerpt(map, 'root', { section: 'sources' });
  assert.equal(read.excerpt.match(/Stance: not recorded/g).length, 2); assert.doesNotMatch(read.excerpt, /agrees|object/);
});

async function workspace() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'sources-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  return { store, map, job, deliver: sources => store.complete(map.id, job.jobId, job.claimKey, { summary: 'S.', body: 'B.', sources }) };
}

test('a result can say whether each source supports, challenges or gives context; any other stance rejects it', async () => {
  const { store, map, deliver } = await workspace();
  const before = await readFile(store.file(map.id), 'utf8');
  for (const stance of ['agrees', 3, { supports: true }]) {
    await assert.rejects(deliver([{ title: 'T', url: 'https://e.org/x', note: 'N.', stance }]), error => error.status === 400 && /supports, challenges or context/.test(error.message), String(stance));
  }
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const saved = await deliver([{ title: 'Docs', url: 'https://e.org/x', note: 'Works offline.', stance: 'supports' }, { title: 'Report', url: 'https://e.org/y', note: 'Unclear.' },
    { title: 'Blank', url: 'https://e.org/z', note: 'N.', stance: '' }, { title: 'Null', url: 'https://e.org/w', note: 'N.', stance: null }]);
  assert.equal(saved.nodes[0].sources[0].stance, 'supports');
  assert.deepEqual(saved.nodes[0].sources.slice(1).map(s => Object.hasOwn(s, 'stance')), [false, false, false], 'left out, empty or null: none stored');
  const markdown = await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.match(markdown, /- \[Docs\]\(https:\/\/e\.org\/x\) \(supports; retrieved [^)]+\): Works offline\./);
  assert.match(markdown, /- \[Report\]\(https:\/\/e\.org\/y\) \(retrieved [^)]+\): Unclear\./, 'an unrecorded stance adds nothing');
  const read = contextExcerpt(saved, map.rootId, { section: 'sources' });
  assert.match(read.excerpt, /Stance: supports/); assert.match(read.excerpt, /Stance: not recorded/);
});

test('Help me answer research ignores a stance, which has no meaning there', async () => {
  const fail = message => { throw new Error(message); };
  assert.deepEqual(sourceList([{ title: 'T', url: 'https://e.org/x', note: 'N.', stance: 'agrees' }], fail, { at: 'at', stance: false }), [{ title: 'T', url: 'https://e.org/x', note: 'N.', retrievedAt: 'at' }]);
  // Through the Store: a result that sends any stance is accepted, and none is kept.
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'sources-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const first = await store.claim('agent', map.id);
  let saved = await store.complete(map.id, first.jobId, first.claimKey, { summary: 'S.', body: 'B.', questions: ['Which sync model fits?'] });
  const question = saved.nodes[0].questions[0];
  await store.action(map.id, { type: 'request-research', nodeId: map.rootId, questionId: question.id, expectedRevision: saved.revision });
  const research = await store.claim('agent', map.id);
  saved = await store.complete(map.id, research.jobId, research.claimKey, { summary: 'Two models.',
    options: [{ id: 'crdt', title: 'Merge edits automatically', description: 'Each device merges changes.', fit: 'Several people edit offline.' }, { id: 'lock', title: 'One editor at a time', description: 'A note is locked while edited.', fit: 'One person edits each note.' }],
    recommendation: { optionId: 'crdt', rationale: 'Field teams edit together.', mainTradeoff: 'More engineering.' }, sources: [{ title: 'Local-first', url: 'https://e.org/lf', note: 'Compares them.', stance: 'agrees' }, { title: 'Docs', url: 'https://e.org/d', note: 'N.', stance: 'supports' }] });
  const sources = saved.jobs.find(job => job.id === research.jobId).result.sources;
  assert.deepEqual(sources.map(s => Object.hasOwn(s, 'stance')), [false, false]);
});

test('node Markdown never prints a stance that is not one', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'sources-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const edited = structuredClone(map);
  edited.nodes[0].sources = [source('https://e.org/x', { stance: 'agrees' }), source('https://e.org/y', { stance: 'challenges' })]; // A hand edit.
  const page = store.renderViews(edited).nodes.get(map.rootId);
  assert.match(page, /\(https:\/\/e\.org\/x\) \(retrieved /); assert.doesNotMatch(page, /agrees/); assert.match(page, /\(https:\/\/e\.org\/y\) \(challenges; retrieved /);
});

test('Help me answer for a dismissed question is left out, research for an earlier premise is labelled, and a question\'s words find it', () => {
  const research = (id, subjectId, extra = {}) => ({ id, type: 'question-research', subjectId, nodeId: 'a', status: 'completed', result: { summary: 'S', sources: [source(`https://e.org/${id}`)] }, ...extra });
  const nodes = [idea('root'), idea('a', [], { questions: [{ id: 'q1', text: 'Which phones first?', answer: null }, { id: 'q2', text: 'Set aside?', answer: null, dismissedAt: '2026-01-01' }, { id: 'q3', text: 'Older?', answer: null }] })];
  const entries = library({ nodes, jobs: [research('r1', 'q1'), research('r2', 'q2'), research('r3', 'q3', { stale: true })] });
  assert.deepEqual(entries.map(entry => entry.url).sort(), ['https://e.org/r1', 'https://e.org/r3']);
  assert.match(html(entries), /data-focus-node="a">Help me answer, for an earlier premise<strong>Idea a<\/strong>/);
  assert.deepEqual(matchingSources(entries, { query: 'phones', flaggedOnly: false }).map(entry => entry.url), ['https://e.org/r1']);
  assert.match(html(entries, { note: 'Read <only>.' }), /^<p class="form-note">Read &lt;only&gt;\.<\/p>/, 'the note is escaped too');
});
