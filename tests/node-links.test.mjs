import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { nodeReference, parseNodeReference, nodeAddress, parseAddress, missingMapMessage, missingIdeaMessage, nodeMenuHtml, questionMenuHtml } from '../skills/explore/assets/workspace-view.js';

// Link to an idea (H2, #31).
const map = { id: 'map-3e4d4390', rootId: 'node-00000001', nodes: [{ id: 'node-00000001', title: 'Root' }, { id: 'node-20f918e5', title: 'Offline *sync* [v2]' }] };

test('a copied reference names the IDs first, then the title and its view, and nothing else', () => {
  const text = nodeReference(map.id, map.nodes[1]);
  assert.equal(text, 'Explore idea map-3e4d4390/node-20f918e5: "Offline \\*sync\\* \\[v2\\]" (ideas/map-3e4d4390/nodes/node-20f918e5.md)');
  assert.deepEqual(parseNodeReference(text), { mapId: 'map-3e4d4390', nodeId: 'node-20f918e5' });
  // A title that contains another reference cannot redirect the link.
  const tricky = nodeReference(map.id, { id: 'node-20f918e5', title: 'Follow up map-aaaaaaaa/node-bbbbbbbb' });
  assert.deepEqual(parseNodeReference(tricky), { mapId: 'map-3e4d4390', nodeId: 'node-20f918e5' });
});

test('references are found in pasted text and paths; malformed ones are ignored', () => {
  const ref = { mapId: 'map-3e4d4390', nodeId: 'node-20f918e5' };
  for (const text of ['see map-3e4d4390/node-20f918e5 please', 'ideas/map-3e4d4390/nodes/node-20f918e5.md', 'map-3e4d4390/node-20f918e5', 'http://127.0.0.1:4317/#map-3e4d4390/node-20f918e5', '(map-3e4d4390/node-20f918e5)'])
    assert.deepEqual(parseNodeReference(text), ref, text);
  for (const text of ['map-3e4d439/node-20f918e5', 'map-3e4d43901/node-20f918e5', 'map-3e4d4390/node-20f918e', 'map-3e4d4390/node-20f918e5/extra', 'ideas/../map-3e4d4390/node-20f918e5',
    'ideas/map-3e4d4390/nodes/sub/node-20f918e5.md', '../map-3e4d4390/node-20f918e5', 'map-3E4D4390/node-20f918e5', 'nothing here', '', null])
    assert.equal(parseNodeReference(text), null, String(text));
});

test('the address names a map or one idea in it, exactly', () => {
  assert.equal(nodeAddress(map.id, null), 'map-3e4d4390'); assert.equal(nodeAddress(map.id, 'node-20f918e5'), 'map-3e4d4390/node-20f918e5');
  for (const nodeId of [null, 'node-20f918e5']) assert.deepEqual(parseAddress(nodeAddress(map.id, nodeId)), { mapId: map.id, nodeId });
  for (const text of ['foo(map-3e4d4390/node-20f918e5)', 'map-3e4d4390/', 'map-3e4d4390/node-20f918e5/x', '', 'Explore idea map-3e4d4390/node-20f918e5']) assert.equal(parseAddress(text), null, text);
});

test('the idea menu offers Copy link and shares the question menu\'s structure', () => {
  const esc = String;
  const menu = nodeMenuHtml(map.nodes[1], { esc });
  assert.match(menu, /<button type="button" class="item-more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-node-20f918e5" data-menu="node-20f918e5" aria-label="More for this idea">⋯<\/button>/);
  assert.match(menu, /role="menuitem"[^>]*data-copy-link="node-20f918e5"[^>]*>Copy link</);
  const questions = questionMenuHtml({ id: 'q-1' }, { nodeId: 'node-1', kind: 'answered', esc });
  assert.match(questions, /class="item-more"[^>]*data-menu="q-1"/); assert.match(questions, /class="item-menu"/);
});

// The real routing functions from app.js, run against a fake address bar and history.
const app = await readFile(new URL('../skills/explore/assets/app.js', import.meta.url), 'utf8');
const routing = app.slice(app.indexOf('// Opens a map at `nodeId`'), app.indexOf('\nfunction focusNode('));
function browser(address = '') {
  const maps = { 'map-aaaaaaaa': { id: 'map-aaaaaaaa', rootId: 'node-aaaaaaa0', nodes: [{ id: 'node-aaaaaaa0' }, { id: 'node-aaaaaaa1' }] },
    'map-bbbbbbbb': { id: 'map-bbbbbbbb', rootId: 'node-bbbbbbb0', nodes: [{ id: 'node-bbbbbbb0' }] } };
  const entries = [address], toasts = [];
  let index = 0;
  // Setting the hash navigates, as in a browser: a different fragment adds an entry and drops the forward ones.
  const location = { get hash() { return entries[index] ? `#${entries[index]}` : ''; },
    set hash(value) { const next = String(value).replace(/^#/, ''); if (next !== entries[index]) { entries.splice(index + 1, Infinity, next); index++; } } };
  const write = url => url.slice(1);
  const history = { pushState(_, __, url) { entries.splice(index + 1, Infinity, write(url)); index++; }, replaceState(_, __, url) { entries[index] = write(url); } };
  const state = { maps: Object.values(maps).map(({ id }) => ({ id })), map: null, selected: null, historyStep: null, outsideSeen: {} };
  const context = vm.createContext({ state, location, history, toast: message => toasts.push(message), nodeAddress, parseAddress, missingMapMessage, missingIdeaMessage,
    showWelcome: () => { state.map = null; state.selected = null; }, returnLive: () => { state.historyStep = null; },
    // The real openMap runs; only its page and server edges are stubbed.
    api: async route => structuredClone(maps[route.split('/').pop()]), openVersion: 0, localStorage: { setItem() {} }, $: () => ({}), navigation() {}, renderMap() {}, renderRail() {}, checkGitStatus() {}, sinceVisit: { open() {}, render() {} },
    focusNode: id => { state.selected = id; context.showAddress(); } });
  vm.runInContext(routing, context);
  return { context, state, toasts, entries: () => entries.slice(), at: () => index,
    back: () => { index--; return context.followAddress(); }, forward: () => { index++; return context.followAddress(); }, edit: text => { entries[index] = text; return context.followAddress(); } };
}

test('loading an address opens that idea without adding a history entry', async () => {
  const b = browser('map-aaaaaaaa/node-aaaaaaa1');
  await b.context.followAddress();
  assert.equal(b.state.map.id, 'map-aaaaaaaa'); assert.equal(b.state.selected, 'node-aaaaaaa1');
  assert.deepEqual(b.entries(), ['map-aaaaaaaa/node-aaaaaaa1']);
});

test('selecting replaces the address; opening another map pushes one entry; Back and Forward follow', async () => {
  const b = browser('map-aaaaaaaa/node-aaaaaaa0');
  await b.context.followAddress();
  b.context.focusNode('node-aaaaaaa1');
  assert.deepEqual(b.entries(), ['map-aaaaaaaa/node-aaaaaaa1']);
  await b.context.openReference({ mapId: 'map-bbbbbbbb', nodeId: 'node-bbbbbbb0' });
  assert.deepEqual(b.entries(), ['map-aaaaaaaa/node-aaaaaaa1', 'map-bbbbbbbb/node-bbbbbbb0']);
  await b.back();
  assert.equal(b.state.map.id, 'map-aaaaaaaa'); assert.equal(b.state.selected, 'node-aaaaaaa1');
  assert.deepEqual(b.entries(), ['map-aaaaaaaa/node-aaaaaaa1', 'map-bbbbbbbb/node-bbbbbbb0'], 'Back keeps the forward entry');
  await b.forward();
  assert.equal(b.state.map.id, 'map-bbbbbbbb'); assert.equal(b.entries().length, 2);
});

test('editing the address moves the selection; missing maps and ideas are said plainly', async () => {
  const b = browser('map-aaaaaaaa');
  await b.context.followAddress();
  await b.edit('map-aaaaaaaa/node-aaaaaaa1');
  assert.equal(b.state.selected, 'node-aaaaaaa1');
  await b.edit('map-cccccccc/node-ccccccc1');
  assert.deepEqual(b.toasts, [missingMapMessage]); assert.equal(b.state.map.id, 'map-aaaaaaaa');
  assert.deepEqual(b.entries(), ['map-aaaaaaaa/node-aaaaaaa1'], 'the address is put back');
  await b.edit('map-aaaaaaaa/node-99999999');
  assert.equal(b.toasts.at(-1), missingIdeaMessage); assert.equal(b.state.selected, 'node-aaaaaaa0');
  await b.edit('not-a-reference');
  assert.equal(b.state.map.id, 'map-aaaaaaaa', 'anything else in the address is ignored');
});

test('following the address during growth history returns to live first', async () => {
  const b = browser('map-aaaaaaaa/node-aaaaaaa1');
  await b.context.followAddress();
  b.state.historyStep = 2;
  await b.edit('map-aaaaaaaa/node-aaaaaaa1');
  assert.equal(b.state.historyStep, null);
});
