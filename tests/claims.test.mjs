import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { mapBrief } from '../skills/explore/scripts/brief.mjs';
import { contextExcerpt } from '../skills/explore/scripts/context.mjs';
import { claimsHtml, basisHtml } from '../skills/explore/assets/claims.js';

// Claims linked to evidence (C2, #11). Illustrative maps under .test-output, never ideas/.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const A = 'https://example.org/a', B = 'https://example.org/b';
const sources = [{ title: 'Vendor docs', url: A, note: 'Sync works offline.' }, { title: 'Field report', url: B, note: 'Conflicts were rare.' }];
const supported = { id: 'offline', text: 'The app keeps working without a signal.', support: [{ source: A, passage: 'All edits are stored on the device first.', locator: 'Offline mode' }] };
const unknown = { id: 'rare', text: 'Edit conflicts are rare for small crews.', support: [] };
async function explored() {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'claims-')), 'ideas'));
  const map = await store.create({ title: 'Field notebook', idea: 'Notes that work offline.' });
  const job = await store.claim('agent', map.id);
  const markdown = () => readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  return { store, map, job, markdown, deliver: result => store.complete(map.id, job.jobId, job.claimKey, { summary: 'Buying works offline.', body: 'Findings.', sources, ...result }) };
}

test('a result’s key claims point to passages of its own sources, in Markdown, the brief and a section read', async () => {
  const { map, deliver, markdown } = await explored();
  const saved = await deliver({ claims: [supported, unknown] });
  const node = saved.nodes.find(n => n.id === map.rootId);
  assert.deepEqual(node.claims, [supported, unknown]);
  const text = await markdown();
  assert.match(text, /## Key claims/); assert.match(text, /\(offline\) The app keeps working without a signal\. — \[Vendor docs\]\(https:\/\/example\.org\/a\): “All edits are stored on the device first\.” \(Offline mode\)/);
  assert.match(text, /Edit conflicts are rare for small crews\. \[support unknown\]/);
  const entry = mapBrief(saved).sections.find(section => section.id === 'findings').items[0];
  assert.equal(entry.basis, 'sources'); assert.equal(entry.unsupportedClaims, 1);
  const read = contextExcerpt(saved, map.rootId, { section: 'claims', query: 'conflicts' });
  assert.equal(read.totalRecords, 2); assert.equal(read.matchingRecords, 1); assert.match(read.excerpt, /\(rare\) Edit conflicts are rare for small crews\. \[support unknown\]/);
});

test('a claim citing a source the result does not have is rejected, as are duplicate URLs and over-limit values', async () => {
  const { store, map, deliver } = await explored();
  const before = await readFile(store.file(map.id), 'utf8');
  const broken = [
    [{ claims: [{ ...supported, support: [{ source: 'https://example.org/elsewhere', passage: 'x' }] }] }, /not in this result's sources/],
    [{ claims: [supported, { ...unknown, id: 'offline' }] }, /unique/],
    [{ claims: [{ ...supported, id: '9' }] }, /identifier/],
    [{ claims: [{ ...supported, text: 't'.repeat(501) }] }, /500/],
    [{ claims: [{ ...supported, support: [{ source: A, passage: 'p'.repeat(401) }] }] }, /400/],
    [{ claims: [{ ...supported, support: [{ source: A, passage: 'p', locator: 'l'.repeat(121) }] }] }, /120/],
    [{ claims: [{ ...supported, support: Array.from({ length: 4 }, () => ({ source: A, passage: 'p' })) }] }, /at most 3/],
    [{ claims: Array.from({ length: 13 }, (_, i) => ({ ...unknown, id: `c${i}` })) }, /at most 12/],
    [{ claims: [supported], sources: [...sources, { ...sources[0], note: 'Again.' }] }, /distinct/],
  ];
  for (const [result, message] of broken) await assert.rejects(deliver(result), error => error.status === 400 && message.test(error.message), message.source);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
});

test('an empty claims list means none, and a source URL is compared as saved, for claims and limitations', async () => {
  const { deliver } = await explored();
  let saved = await deliver({ claims: [], sources: [...sources, { ...sources[0], note: 'Again.' }] });
  assert.equal(Object.hasOwn(saved.nodes[0], 'claims'), false, 'no claims kept, and no distinct-URL rule without claims');
  const spaced = `${A} `;
  const second = await explored();
  saved = await second.deliver({ sources: [{ ...sources[0], url: spaced }, sources[1]], claims: [{ ...supported, support: [{ source: spaced, passage: 'Stored first.' }] }],
    limitations: [{ id: 'split', kind: 'conflict', summary: 'They disagree.', nextStep: 'Ask a crew.', sources: [spaced, B] }] });
  const node = saved.nodes[0];
  assert.equal(node.sources[0].url, A); assert.equal(node.claims[0].support[0].source, A); assert.deepEqual(node.limitations[0].sources, [A, B]);
});

test('findings with no sources are labelled as reasoning, including ideas saved before claims existed', async () => {
  const { store, map, job } = await explored();
  const saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Probably fine.', body: 'Reasoned from experience.' });
  const node = store.view(saved).nodes.find(n => n.id === map.rootId);
  assert.equal(node.hasFindings, true); assert.equal(Object.hasOwn(node, 'claims'), false);
  assert.match(basisHtml(node), /Reasoning — no sources consulted/);
  assert.equal(claimsHtml(node, { esc }), '', 'no claims section for a result without claims');
  const entry = mapBrief(saved).sections.find(section => section.id === 'findings').items[0];
  assert.equal(entry.basis, 'reasoning'); assert.match(mapBrief(saved).markdown, /reasoning only/);
  assert.match(await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8'), /_Reasoning — no sources consulted\._/);
  const compared = await explored(), option = id => ({ id, title: `Option ${id}`, description: 'What it is.', fit: 'When it fits.' });
  const withOptions = await compared.store.complete(compared.map.id, compared.job.jobId, compared.job.claimKey, { summary: 'Two ways.', body: 'Reasoned from experience.',
    options: [option('a'), option('b')], recommendation: { optionId: 'a', rationale: 'Simpler.', mainTradeoff: 'Less control.' },
    limitations: [{ id: 'gap', kind: 'missing-evidence', summary: 'No field data.', nextStep: 'Run one.' }] });
  assert.equal(withOptions.nodes[0].options.length, 2);
  assert.match(await compared.markdown(), /Reasoned from experience\.\n\n_Reasoning — no sources consulted\._\n/, 'the label follows the findings, not the last section');
  assert.equal(basisHtml({ ...node, hasFindings: false }), '', 'a premise is not labelled');
  assert.equal(basisHtml({ ...node, sources }), '', 'research with sources is not labelled');
});

test('a stale result keeps its claims in job history only; revise clears them; a continuing branch sees them', async () => {
  const { store, map, job } = await explored();
  let saved = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Depends.', body: 'Findings.', sources, claims: [supported], questions: ['Which phones?'] });
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'answer', nodeId: map.rootId, questionId: saved.nodes[0].questions[0].id, answer: 'Android.' });
  const next = await store.claim('agent', map.id);
  assert.deepEqual(next.selected.claims, [{ id: 'offline', text: supported.text }]);
  assert.match(next.instruction, /read --section options\|limitations\|claims\|assumptions and resend in full those that still hold/); assert.match(next.retrieval, /claims/);
  saved = await store.get(map.id);
  saved = await store.action(map.id, { expectedRevision: saved.revision, type: 'revise', nodeId: map.rootId, body: 'Notes that work offline for a year.' });
  assert.equal(saved.nodes[0].claims, undefined, 'revise clears them with the sources');
  saved = await store.complete(map.id, next.jobId, next.claimKey, { summary: 'Late.', body: 'Late findings.', sources, claims: [supported] });
  assert.equal(saved.nodes[0].claims, undefined, 'a stale result does not touch the idea');
  assert.deepEqual(saved.jobs.find(entry => entry.id === next.jobId).result.claims, [supported]);
});

test('the inspector names each claim’s support or says it is unknown, never “verified”, and escapes text', () => {
  const node = { id: 'n', hasFindings: true, sources, claims: [{ ...supported, text: 'Works <offline>.' }, unknown] };
  const html = claimsHtml(node, { esc });
  assert.match(html, /<h3 class="section-label">Key claims<\/h3><p class="form-note">[^<]*<\/p><div class="claims"><div class="claim">/);
  assert.match(html, /Works &lt;offline&gt;\./); assert.doesNotMatch(html, /<offline>/);
  assert.match(html, /<summary>Supported by Vendor docs<\/summary>[\s\S]*All edits are stored on the device first\.[\s\S]*Offline mode[\s\S]*<a href="https:\/\/example\.org\/a" target="_blank" rel="noreferrer">/);
  assert.match(html, /class="claim-unknown">Support unknown</);
  const twice = claimsHtml({ ...node, claims: [{ ...supported, support: [supported.support[0], { source: B, passage: 'Rare.' }] }] }, { esc });
  assert.deepEqual([...twice.matchAll(/<details class="claim-support" data-editor="([^"]+)">/g)].map(match => match[1]), ['claim-offline-0', 'claim-offline-1'],
    'the inspector keeps each passage open or closed across a redraw, as it does for other disclosures');
  assert.doesNotMatch(html, /verified/i);
});
