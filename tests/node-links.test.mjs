import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeReference, parseNodeReference, referenceRoute, nodeMenuHtml, questionMenuHtml } from '../skills/explore/assets/workspace-view.js';

// Link to an idea (H2, #31). Pure helpers; the browser wires them to the address bar and Find an idea.
const map = { id: 'map-3e4d4390', rootId: 'node-00000001', nodes: [{ id: 'node-00000001', title: 'Root' }, { id: 'node-20f918e5', title: 'Offline *sync* [v2]' }] };

test('a copied reference names the map, the idea, its title and its view, and nothing else', () => {
  const text = nodeReference(map.id, map.nodes[1]);
  assert.equal(text, 'Explore idea "Offline \\*sync\\* \\[v2\\]": map-3e4d4390/node-20f918e5 (ideas/map-3e4d4390/nodes/node-20f918e5.md)');
  assert.deepEqual(parseNodeReference(text), { mapId: 'map-3e4d4390', nodeId: 'node-20f918e5' });
});

test('references are found in pasted text, paths and addresses; malformed ones are ignored', () => {
  const ref = { mapId: 'map-3e4d4390', nodeId: 'node-20f918e5' };
  for (const text of ['see map-3e4d4390/node-20f918e5 please', 'ideas/map-3e4d4390/nodes/node-20f918e5.md', 'map-3e4d4390/node-20f918e5', 'http://127.0.0.1:4317/#map-3e4d4390/node-20f918e5', '(map-3e4d4390/node-20f918e5)'])
    assert.deepEqual(parseNodeReference(text), ref, text);
  for (const text of ['map-3e4d439/node-20f918e5', 'map-3e4d43901/node-20f918e5', 'map-3e4d4390/node-20f918e', 'map-3e4d4390/node-20f918e5/extra', 'ideas/../map-3e4d4390/node-20f918e5',
    'ideas/map-3e4d4390/nodes/sub/node-20f918e5.md', '../map-3e4d4390/node-20f918e5', 'map-3E4D4390/node-20f918e5', 'nothing here', '', null])
    assert.equal(parseNodeReference(text), null, String(text));
});

test('a reference opens its map, then focuses the idea; a missing map or idea is said plainly', () => {
  const mapIds = [map.id, 'map-aaaaaaaa'];
  assert.deepEqual(referenceRoute({ mapId: map.id, nodeId: 'node-20f918e5' }, { mapIds, map }), { focus: 'node-20f918e5' });
  assert.deepEqual(referenceRoute({ mapId: 'map-aaaaaaaa', nodeId: 'node-20f918e5' }, { mapIds, map }), { openMap: 'map-aaaaaaaa' });
  assert.deepEqual(referenceRoute({ mapId: 'map-aaaaaaaa', nodeId: null }, { mapIds, map: null }), { openMap: 'map-aaaaaaaa' });
  assert.match(referenceRoute({ mapId: 'map-bbbbbbbb', nodeId: 'node-20f918e5' }, { mapIds, map }).message, /isn't in this workspace\. It may be on another branch or not pulled yet\./);
  const missingNode = referenceRoute({ mapId: map.id, nodeId: 'node-99999999' }, { mapIds, map });
  assert.equal(missingNode.focus, map.rootId); assert.match(missingNode.message, /wasn't found/);
  assert.deepEqual(referenceRoute({ mapId: map.id, nodeId: null }, { mapIds, map }), { focus: null });
});

test('the idea menu offers Copy link and shares the question menu\'s structure', () => {
  const esc = String;
  const menu = nodeMenuHtml(map.nodes[1], { esc });
  assert.match(menu, /<button type="button" class="item-more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-node-20f918e5" data-menu="node-20f918e5" aria-label="More for this idea">⋯<\/button>/);
  assert.match(menu, /role="menuitem"[^>]*data-copy-link="node-20f918e5"[^>]*>Copy link</);
  const questions = questionMenuHtml({ id: 'q-1' }, { nodeId: 'node-1', kind: 'answered', esc });
  assert.match(questions, /class="item-more"[^>]*data-menu="q-1"/); assert.match(questions, /class="item-menu"/);
});
