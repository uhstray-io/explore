import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { packageFiles } from '../skills/explore/scripts/doctor.mjs';
import { brokenReferenceLinks } from '../scripts/reference-links.mjs';
import { topicProfiles, runNoteHtml } from '../skills/explore/assets/workspace-view.js';
import { readdir } from 'node:fs/promises';

// Topic profiles (C6, #13). Illustrative maps under .test-output, never ideas/.
const skill = path.resolve('skills/explore'), names = Object.keys(topicProfiles);
const headings = ['When to use', 'Sources', 'What to compare', 'Freshness', 'When to stop', 'Uncertainty'];

test('four profiles, each with the six shared headings and within about 400 words, listed in the package', async () => {
  assert.deepEqual((await readdir(path.join(skill, 'references/topics'))).sort(), names.map(name => `${name}.md`).sort(), 'one file per profile key');
  for (const name of names) {
    const text = await readFile(path.join(skill, 'references/topics', `${name}.md`), 'utf8');
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(match => match[1].trim()), headings, name);
    assert.ok(text.split(/\s+/).filter(Boolean).length <= 420, `${name} is short`);
    assert.ok(packageFiles.includes(`references/topics/${name}.md`), `${name} is a package file`);
  }
});

test('exploration.md chooses one profile, links all four, and names General as the default', async () => {
  const guide = await readFile(path.join(skill, 'references/exploration.md'), 'utf8');
  for (const name of names) assert.match(guide, new RegExp(`\\]\\(topics/${name}\\.md\\)`));
  assert.match(guide, /## Choose a topic profile/); assert.match(guide, /\| \[General\]\(topics\/general\.md\) \| The default/);
});

test('the reference check finds a broken link inside references/ and passes once it is fixed', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const copy = path.join(await mkdtemp(path.join(root, 'links-')), 'explore');
  await mkdir(copy); await cp(path.join(skill, 'SKILL.md'), path.join(copy, 'SKILL.md')); await cp(path.join(skill, 'references'), path.join(copy, 'references'), { recursive: true });
  assert.deepEqual(await brokenReferenceLinks(copy), []);
  const guide = path.join(copy, 'references/exploration.md'), text = await readFile(guide, 'utf8');
  await writeFile(guide, text.replace('](topics/general.md)', '](topics/missing.md)'));
  assert.deepEqual(await brokenReferenceLinks(copy), ['references/exploration.md → topics/missing.md']);
  await writeFile(guide, text);
  assert.deepEqual(await brokenReferenceLinks(copy), []);
  // What would break once installed: outside the skill, wrong case, absolute; titles and angle brackets still count.
  const extra = path.join(copy, 'references/extra.md');
  await writeFile(extra, '[a](../../AGENTS.md) [b](topics/General.md) [c](/etc/hosts) [d](missing.md "A title") [e](<topics/nope.md>)\n\n`[f](not-a-link.md)`\n\n```\n[g](also-not.md)\n```\n[h](topics/general.md#when-to-use) [i](https://example.org/x.md)\n');
  assert.deepEqual(await brokenReferenceLinks(copy), ['references/extra.md → ../../AGENTS.md', 'references/extra.md → topics/General.md', 'references/extra.md → /etc/hosts', 'references/extra.md → missing.md', 'references/extra.md → topics/nope.md']);
});

test('a result names its profile, which shows under the findings and in the run note; an unknown one changes nothing', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'profiles-')), 'ideas'));
  const map = await store.create({ title: 'Library upgrade', idea: 'Move to the next major version.' });
  const job = await store.claim('test', map.id);
  const before = await readFile(store.file(map.id), 'utf8');
  for (const topicProfile of ['astrology', ['general']]) await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'x', body: 'y', topicProfile }), error => error.status === 400 && /topicProfile must be one of/.test(error.message));
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const done = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Upgrade is safe.', body: 'Version 5 keeps the API.', topicProfile: 'software-versions' });
  const saved = done.jobs.find(entry => entry.id === job.jobId);
  assert.equal(saved.result.topicProfile, 'software-versions');
  assert.match(await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8'), /Guidance: Software and versions/);
  assert.match(runNoteHtml({ ...saved, contextCharacters: 1200 }), /Guidance: Software and versions/);
  assert.doesNotMatch(runNoteHtml({ contextCharacters: 1200, result: {} }), /Guidance/, 'older results show nothing');
  assert.equal(runNoteHtml(null), '');
  assert.equal(runNoteHtml({ contextCharacters: '<img src=x onerror=alert(1)>' }), '', 'only numbers reach the page');
});

test('a result without a profile keeps no key, and only the run whose findings show names its guidance', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'profiles-')), 'ideas'));
  let map = await store.create({ title: 'Library upgrade', idea: 'Move to the next major version.' });
  let job = await store.claim('test', map.id);
  map = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Upgrade is safe.', body: 'Version 5 keeps the API.', questions: ['Which version runs now?'] });
  assert.equal(Object.hasOwn(map.jobs.find(entry => entry.id === job.jobId).result, 'topicProfile'), false);
  const view = () => readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8');
  assert.doesNotMatch(await view(), /Guidance/);
  // A run that finishes after the premise changed is history, so its guidance is not credited to the premise.
  map = await store.action(map.id, { expectedRevision: map.revision, type: 'answer', nodeId: map.rootId, questionId: map.nodes[0].questions[0].id, answer: 'Version 4.' });
  job = await store.claim('test', map.id);
  map = await store.get(map.id);
  await store.action(map.id, { expectedRevision: map.revision, type: 'revise', nodeId: map.rootId, body: 'Move to a different library.' });
  await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Late.', body: 'Late findings.', topicProfile: 'software-versions' });
  const markdown = await view();
  assert.match(markdown, /Current premise \(not researched findings\)/); assert.doesNotMatch(markdown, /Guidance/);
});
