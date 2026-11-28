import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { viewerFile, viewerData, viewerParts } from '../skills/explore/scripts/viewer.mjs';
import { startServer } from '../skills/explore/scripts/server.mjs';
import { packageFiles } from '../skills/explore/scripts/doctor.mjs';
import { previewCurrent, selectionKey } from '../skills/explore/assets/viewer-picker.js';

// Read-only viewer file (I4, #42). Illustrative maps only, never ideas/.
const node = (id, parentId, extra = {}) => ({ id, parentId, title: `Idea ${id}`, kind: 'research', prompt: `Premise ${id}.`, body: `Premise ${id}.`, summary: `Premise ${id}.`,
  status: 'suggested', reviewState: 'unreviewed', stale: false, contentRevision: 1, questions: [], sources: [], ...extra });
function fixture(titles = {}) {
  const nodes = [
    node('root', null, { kind: 'idea', title: 'Field notebook', status: 'explored', summary: 'Sync matters most.', body: 'Findings about sync.' }),
    node('sync', 'root', { title: 'Syncing', status: 'explored', reviewState: 'accepted', summary: 'Merge by hand.', body: 'Keep both copies.',
      questions: [{ id: 'q1', text: 'Who edits?', answer: 'Two of us.', answerState: 'decided' }, { id: 'q2', text: 'Which phones?', answer: null }, { id: 'q0', text: 'Old question?', answer: 'Old.', supersededAt: 'x' }],
      sources: [{ title: 'Field study', url: 'https://example.org/study', note: 'Teams used solar chargers.' }] }),
    node('power', 'sync', { title: 'Power', status: 'explored', stale: true, summary: 'Batteries last a day.', body: 'Batteries last a day in the field.',
      questions: [{ id: 'q3', text: 'Spare packs?', answer: 'Yes.' }] }),
    node('photos', 'root', { title: 'Photos', status: 'awaiting-answer', summary: 'Photos are large.', body: 'Compress them.' }),
    node('later', 'photos', { title: 'Later idea', status: 'explored', summary: 'Wait for storage.', body: 'Not yet.', questions: [{ id: 'q4', text: 'How much storage?', answer: null, deferredAt: 'x' }] }),
  ].map(entry => ({ ...entry, ...(titles[entry.id] ? { title: titles[entry.id] } : {}) }));
  return { schemaVersion: 1, id: 'map-0000000a', title: 'Field notebook', rootId: 'root', revision: 4, nodes,
    edges: nodes.slice(1).map(entry => ({ from: entry.parentId, to: entry.id, type: 'contains' })),
    jobs: [{ id: 'job-00000001', nodeId: 'root', status: 'running', claimKey: 'claim-secret-value', worker: 'worker-name-7' }],
    growth: { batches: [{ nodeIds: ['root'] }] }, history: [{ at: 'x', type: 'created', nodeId: 'root', detail: 'history-only text' }], view: { positions: { sync: { x: 40, y: 50 } } } };
}
const selection = [{ id: 'sync', answers: true, findings: true }, { id: 'power', answers: false, findings: true }, { id: 'later', answers: true, findings: false }];
const scripts = html => [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(match => ({ attributes: match[1], text: match[2] }));
const viewerScript = html => scripts(html).find(script => !script.attributes.includes('application/json')).text;
const viewerJson = html => JSON.parse(scripts(html).find(script => script.attributes.includes('application/json')).text);

test('only the selected ideas and the chosen fields go in; an unselected parent is left out entirely', () => {
  const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection });
  const data = viewerJson(html), byId = new Map(data.nodes.map(entry => [entry.id, entry]));
  assert.deepEqual(data.nodes.map(entry => entry.id), ['sync', 'power', 'later']);
  assert.deepEqual(data.nodes.map(entry => entry.parentId), [null, 'sync', null], 'a parent link only to a selected parent');
  assert.doesNotMatch(html, /Field notebook|Photos|Sync matters/, 'unselected ideas and the map title (the root’s) appear nowhere');
  assert.deepEqual(Object.keys(byId.get('power')).sort(), ['findings', 'id', 'kind', 'labels', 'parentId', 'position', 'premise', 'review', 'sources', 'summary', 'title']);
  assert.deepEqual([byId.get('sync').labels, byId.get('power').labels, byId.get('later').labels], [['Explored', 'accepted'], ['Explored', 'needs review'], ['Explored', 'not accepted']]);
  assert.equal(byId.get('later').findings, undefined); assert.equal(byId.get('later').summary, undefined);
  assert.deepEqual(byId.get('later').questions, [{ text: 'How much storage?', answer: null, certainty: null, status: 'later' }]);
  assert.deepEqual(byId.get('sync').questions.map(question => question.text), ['Who edits?', 'Which phones?'], 'answers set aside stay out');
  assert.equal(byId.get('sync').questions[0].certainty, 'Decided');
  assert.deepEqual(byId.get('sync').position, { x: 40, y: 50 }, 'the app’s layout');
});

test('no claim keys, workers, jobs, history, paths or tokens', async () => {
  const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection });
  for (const secret of [/claim-secret-value/, /claimKey/, /worker-name-7/, /job-00000001/, /history-only text/, /map\.json/, /ideas[\\/]/, /\.explore/]) assert.doesNotMatch(html, secret);
});

test('hostile text stays data: it cannot close the script block or run', () => {
  const separator = String.fromCharCode(0x2028), hostile = `</script><img src=x onerror=alert(1)> ${separator} & <!--`;
  const map = fixture({ sync: hostile }); map.nodes[1].questions[0].answer = hostile; map.nodes[1].body = hostile;
  const { html } = viewerFile(map, { expectedRevision: 4, nodes: selection });
  assert.equal((html.match(/<script/g) || []).length, 2); assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.doesNotMatch(html, /<img|<!--/); assert.ok(!html.includes(separator));
  assert.equal(viewerJson(html).nodes[0].title, hostile, 'the text comes back exactly');
  assert.doesNotMatch(viewerScript(html), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, 'map text enters only as text');
});

test('the policy allows only the file’s own script and style, by hash, and nothing is fetched', () => {
  const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection });
  const policy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
  const hash = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(policy, /^default-src 'none'; /);
  assert.ok(policy.includes(`script-src ${hash(viewerScript(html))};`)); assert.ok(policy.includes(`style-src ${hash(style)};`));
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/, '');
  assert.doesNotMatch(markup, /\s(src|href)=|<link|<iframe|<object/i); assert.doesNotMatch(style, /url\(|@import/);
});

test('search and navigation work from the file alone', () => {
  const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection });
  const context = vm.createContext({});
  vm.runInContext(viewerScript(html), context);
  const model = context.viewerModel(viewerJson(html));
  assert.deepEqual([...model.search('')], ['sync', 'power', 'later']);
  assert.deepEqual([...model.search('TWO OF US')], ['sync'], 'answers, case-insensitive');
  assert.deepEqual([...model.search('in the field')], ['power'], 'findings');
  assert.deepEqual([...model.search('storage')], ['later'], 'questions');
  const around = model.neighbours('power');
  assert.deepEqual([around.parent, [...around.children], around.previous, around.next], ['sync', [], 'sync', 'later']);
});

test('a stale revision, a bad selection and an oversized one are refused, never cut short', () => {
  const map = fixture();
  assert.throws(() => viewerFile(map, { expectedRevision: 3, nodes: selection }), error => error.status === 409);
  for (const nodes of [[], [{ id: 'nope', answers: true, findings: true }], [{ id: 'sync', answers: 'yes', findings: true }], [selection[0], selection[0]], 'all'])
    assert.throws(() => viewerData(map, nodes), error => error.status === 400, JSON.stringify(nodes));
  const big = fixture(); big.nodes.push(...Array.from({ length: 500 }, (_, i) => node(`n${i}`, 'root')));
  assert.throws(() => viewerData(big, big.nodes.map(entry => ({ id: entry.id, answers: true, findings: true }))), error => error.status === 413 && /at most 500/.test(error.message));
  const long = fixture(); long.nodes.push(...Array.from({ length: 300 }, (_, i) => node(`n${i}`, 'root', { status: 'explored', body: 'Long findings. '.repeat(1100) })));
  assert.throws(() => viewerFile(long, { expectedRevision: 4, nodes: long.nodes.map(entry => ({ id: entry.id, answers: true, findings: true })) }), error => error.status === 413 && /4 MiB/.test(error.message));
});

test('the server builds the file for the signed-in page only, checks the revision, and never includes its token', async () => {
  const root = path.resolve('.test-output'); await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, 'viewer-'));
  const app = await startServer({ workspace: dir, port: 0 });
  try {
    const map = await app.store.demo(), { token } = await (await fetch(`${app.address}/api/session`)).json();
    const post = (body, headers = { Authorization: `Bearer ${token}` }) => fetch(`${app.address}/api/maps/${map.id}/viewer`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const nodes = [{ id: map.nodes[1].id, answers: true, findings: true }];
    assert.equal((await post({ expectedRevision: map.revision, nodes }, {})).status, 401);
    assert.equal((await post({ expectedRevision: map.revision - 1, nodes })).status, 409);
    assert.equal((await post({ nodes })).status, 400, 'the preview names its revision');
    const reply = await (await post({ expectedRevision: map.revision, nodes })).json();
    assert.equal(reply.filename, 'Selected ideas-viewer.html', 'the root was not chosen, so its title is not in the name either'); assert.equal(reply.revision, map.revision); assert.equal(reply.data.nodes.length, 1);
    assert.ok(!reply.html.includes(token)); assert.match(reply.html, /^<!doctype html>/);
    assert.ok(packageFiles.includes('scripts/viewer.mjs') && packageFiles.includes('assets/viewer-page.js') && packageFiles.includes('assets/viewer.css') && packageFiles.includes('assets/viewer-picker.js'));
    assert.equal((await fetch(`${app.address}/viewer-picker.js`)).status, 200);
    assert.equal((await fetch(`${app.address}/viewer-page.js`)).status, 404, 'the file’s own script is never served to the app');
  } finally { await app.close(); }
});

test('Download needs a current preview: a new selection or a new revision clears it', () => {
  const picked = { sync: { answers: true, findings: true }, power: { answers: false, findings: true } };
  const preview = { mapId: 'map-a', revision: 4, key: selectionKey(picked) };
  assert.equal(previewCurrent(preview, { mapId: 'map-a', revision: 4, picked }), true);
  assert.equal(previewCurrent(null, { mapId: 'map-a', revision: 4, picked }), false);
  assert.equal(previewCurrent(preview, { mapId: 'map-a', revision: 5, picked }), false, 'the map changed');
  assert.equal(previewCurrent(preview, { mapId: 'map-b', revision: 4, picked }), false, 'another map at the same revision');
  assert.equal(previewCurrent(preview, { mapId: 'map-a', revision: 4, picked: { ...picked, power: { answers: true, findings: true } } }), false, 'a field changed');
  assert.equal(previewCurrent(preview, { mapId: 'map-a', revision: 4, picked: { sync: picked.sync } }), false, 'an idea was dropped');
});

test('the viewer’s own assets never reach the browser app, but the picker does', async () => {
  const source = await readFile(path.resolve('skills/explore/assets/viewer-page.js'), 'utf8');
  assert.doesNotMatch(source, /<\/script|<\/style/i, 'safe to inline');
  assert.doesNotMatch(await readFile(path.resolve('skills/explore/assets/viewer.css'), 'utf8'), /<\/style|url\(|@import/i);
});

test('a Windows checkout’s CRLF assets still match their hashes, because the browser hashes LF text', () => {
  const crlf = viewerParts(name => viewerParts()[name === 'viewer-page.js' ? 'script' : 'style'].replace(/\n/g, '\r\n'));
  const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection }, { parts: crlf });
  assert.ok(!html.includes('\r'), 'the inline code is LF only');
  const policy = html.match(/content="(default-src[^"]+)"/)[1], hash = text => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  assert.ok(policy.includes(hash(viewerScript(html)))); assert.ok(policy.includes(hash(html.match(/<style>([\s\S]*?)<\/style>/)[1])), 'the style too');
});

test('an idea saved before premises were kept apart keeps its findings', () => {
  const map = fixture(); delete map.nodes[2].prompt; // Power: explored, with only a body.
  const power = viewerData(map, [{ id: 'power', answers: false, findings: true }]).nodes[0];
  assert.equal(power.premise, undefined); assert.equal(power.findings, 'Batteries last a day in the field.'); assert.equal(power.summary, 'Batteries last a day.');
});

test('ideas come in tree order, and findings that were researched stay labelled even when work is queued again', () => {
  const map = fixture();
  map.nodes.push(node('late', 'sync', { title: 'Late child' })); // Added last, but belongs under Syncing.
  Object.assign(map.nodes[3], { status: 'queued' }); // Photos keeps its findings while queued again.
  const data = viewerData(map, map.nodes.map(entry => ({ id: entry.id, answers: true, findings: true })));
  assert.deepEqual(data.nodes.map(entry => entry.id), ['root', 'sync', 'power', 'late', 'photos', 'later']);
  const photos = data.nodes.find(entry => entry.id === 'photos');
  assert.deepEqual(photos.labels, ['Queued', 'not accepted']); assert.equal(photos.findings, 'Compress them.');
  assert.equal(data.heading, 'Field notebook', 'the map title appears once the root is chosen');
});

test('the page runs in a browser-like document: one idea shows no stray text, and Next and search work', () => {
  const run = selection => {
    const { html } = viewerFile(fixture(), { expectedRevision: 4, nodes: selection });
    const made = [], listeners = new Map();
    const element = tag => {
      const item = { tag, children: [], attributes: {}, textContent: '', value: '', hidden: false, className: '', classList: { toggle() {} },
        append(...nodes) { for (const child of nodes) { if (child === null || child === undefined || typeof child !== 'object') throw new Error(`appended ${child}`); this.children.push(child); } },
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }, setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] ?? null; }, removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, handler) { listeners.set(item, { ...(listeners.get(item) || {}), [type]: handler }); }, focus() {} };
      made.push(item); return item;
    };
    const root = element('div'), data = { textContent: scripts(html).find(script => script.attributes.includes('application/json')).text };
    const document = { getElementById: id => (id === 'viewer' ? root : id === 'viewer-data' ? data : null), createElement: element, createElementNS: (ns, tag) => element(tag),
      createTextNode: text => ({ tag: '#text', textContent: text }), querySelectorAll: () => [] };
    const context = vm.createContext({ document, history: { replaceState() {} }, location: { hash: '' }, window: { addEventListener() {} } });
    vm.runInContext(viewerScript(html), context);
    const text = item => item.textContent + (item.children || []).map(text).join('');
    const click = label => listeners.get(made.find(item => item.tag === 'button' && text(item) === label)).click();
    const heading = () => text(made.filter(item => item.tag === 'h2').at(-1));
    return { root, made, listeners, text, click, heading };
  };
  const one = run([selection[0]]);
  assert.equal(one.root.children.length, 2, 'header and main, with no overview for one idea');
  const page = run(selection);
  assert.equal(page.heading(), 'Syncing'); page.click('Next'); assert.equal(page.heading(), 'Power');
  const search = page.made.find(item => item.tag === 'input'); search.value = 'storage'; page.listeners.get(search).input();
  assert.deepEqual(page.made.filter(item => item.tag === 'li' && item.attributes['data-id']).map(item => item.hidden), [true, true, false]);
});
