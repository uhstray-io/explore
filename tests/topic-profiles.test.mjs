import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../skills/explore/scripts/store.mjs';
import { packageFiles } from '../skills/explore/scripts/doctor.mjs';
import { brokenReferenceLinks } from '../scripts/reference-links.mjs';
import { topicProfiles, runNoteHtml } from '../skills/explore/assets/workspace-view.js';

// Topic profiles (C6, #13). Illustrative maps under .test-output, never ideas/.
const skill = path.resolve('skills/explore'), names = ['general', 'software-versions', 'products-services', 'concepts-tradeoffs'];
const headings = ['When to use', 'Sources', 'What to compare', 'Freshness', 'When to stop', 'Uncertainty'];

test('four profiles, each with the six shared headings and within about 400 words, listed in the package', async () => {
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
  await cp(skill, copy, { recursive: true, filter: source => !source.includes(`${path.sep}node_modules`) });
  assert.deepEqual(await brokenReferenceLinks(copy), []);
  const guide = path.join(copy, 'references/exploration.md'), text = await readFile(guide, 'utf8');
  await writeFile(guide, text.replace('](topics/general.md)', '](topics/missing.md)'));
  assert.deepEqual(await brokenReferenceLinks(copy), ['references/exploration.md → topics/missing.md']);
  await writeFile(guide, text);
  assert.deepEqual(await brokenReferenceLinks(copy), []);
});

test('a result names its profile, which shows under the findings and in the run note; an unknown one changes nothing', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const store = new Store(path.join(await mkdtemp(path.join(root, 'profiles-')), 'ideas'));
  const map = await store.create({ title: 'Library upgrade', idea: 'Move to the next major version.' });
  const job = await store.claim('test', map.id);
  const before = await readFile(store.file(map.id), 'utf8');
  await assert.rejects(store.complete(map.id, job.jobId, job.claimKey, { summary: 'x', body: 'y', topicProfile: 'astrology' }), error => error.status === 400);
  assert.equal(await readFile(store.file(map.id), 'utf8'), before, 'nothing saved');
  const done = await store.complete(map.id, job.jobId, job.claimKey, { summary: 'Upgrade is safe.', body: 'Version 5 keeps the API.', topicProfile: 'software-versions' });
  const saved = done.jobs.find(entry => entry.id === job.jobId);
  assert.equal(saved.result.topicProfile, 'software-versions');
  assert.match(await readFile(path.join(path.dirname(store.file(map.id)), 'nodes', `${map.rootId}.md`), 'utf8'), /Guidance: Software and versions/);
  assert.match(runNoteHtml({ ...saved, contextCharacters: 1200 }), /Guidance: Software and versions/);
  assert.equal(topicProfiles['concepts-tradeoffs'], 'Concepts and design trade-offs');
  assert.doesNotMatch(runNoteHtml({ contextCharacters: 1200, result: {} }), /Guidance/, 'older results show nothing');
  assert.equal(runNoteHtml(null), '');
});
