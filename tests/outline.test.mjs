import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineRows, outlineMove, outlineHtml, outlinePanel } from '../skills/explore/assets/outline.js';
import { mapAtGrowthStep } from '../skills/explore/assets/history.js';

// The outline (Z7, #65): every idea as an indented list in reading order. Illustrative fixtures only.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const glyphs = { idea: '✳', research: '◇', question: '?', decision: '✓', risk: '△' };
const day = n => `2026-01-0${n}T00:00:00.000Z`;
const idea = (id, parentId, extra = {}) => ({ id, parentId, kind: 'idea', title: `Idea ${id}`, status: 'suggested', reviewState: 'unreviewed', questions: [], sources: [], ...extra });
// Children in map order (b before a); `lost` has a parent that is gone, and a child of its own.
const fixture = () => ({ id: 'map-1', rootId: 'root', edges: [], nodes: [
  idea('root', null, { status: 'explored', createdAt: day(1) }),
  idea('b', 'root', { createdAt: day(2) }),
  idea('a', 'root', { status: 'awaiting-answer', kind: 'question', createdAt: day(3) }),
  idea('b1', 'b', { createdAt: day(4), stale: true }),
  idea('lost', 'gone', { createdAt: day(5) }),
  idea('lost1', 'lost', { createdAt: day(6) }),
] });
const shape = rows => rows.map(({ id, level, parentId, position, setSize, childCount, connected }) => [id, level, parentId, position, setSize, childCount, connected]);

test('rows follow the tree depth-first with children in map order, then ideas not under the starting idea', () => {
  const map = fixture(), before = structuredClone(map);
  assert.deepEqual(shape(outlineRows(map)), [
    ['root', 1, null, 1, 1, 2, true],
    ['b', 2, 'root', 1, 2, 1, true],
    ['b1', 3, 'b', 1, 1, 0, true],
    ['a', 2, 'root', 2, 2, 0, true],
    ['lost', 1, null, 1, 1, 1, false],
    ['lost1', 2, 'lost', 1, 1, 0, false],
  ]);
  assert.deepEqual(map, before, 'reading the outline never changes the map');
});

test('a growth step lists only the ideas present then, each once', () => {
  const rows = outlineRows(mapAtGrowthStep(fixture(), 2));
  assert.deepEqual(shape(rows), [['root', 1, null, 1, 1, 2, true], ['b', 2, 'root', 1, 2, 0, true], ['a', 2, 'root', 2, 2, 0, true]]);
});

test('keys move as the tree pattern says: Up, Down, Home, End, Left to the parent, Right to the first child', () => {
  const rows = outlineRows(fixture()), move = (id, key) => outlineMove(rows, id, key);
  assert.equal(move('root', 'ArrowDown'), 'b'); assert.equal(move('b', 'ArrowUp'), 'root');
  assert.equal(move('root', 'ArrowUp'), null); assert.equal(move('lost1', 'ArrowDown'), null);
  assert.equal(move('b1', 'Home'), 'root'); assert.equal(move('root', 'End'), 'lost1');
  assert.equal(move('b1', 'ArrowLeft'), 'b'); assert.equal(move('root', 'ArrowLeft'), null); assert.equal(move('lost', 'ArrowLeft'), null);
  assert.equal(move('b', 'ArrowRight'), 'b1'); assert.equal(move('b1', 'ArrowRight'), null, 'no child');
  assert.equal(move('a', 'ArrowRight'), null, 'the next row is not its child');
  assert.equal(move('root', 'x'), null);
});

test('each row is a treeitem with its level, position, state and flags, and one tab stop', () => {
  const map = fixture();
  map.nodes[1].title = 'Offline <sync>';
  const html = outlineHtml(outlineRows(map), { esc, glyphs, selected: 'a', active: 'a', muted: null });
  const rows = html.match(/<div role="treeitem"[^>]*>/g);
  assert.equal(rows.length, 6);
  assert.equal(rows.filter(row => row.includes('tabindex="0"')).length, 1); assert.match(html, /data-outline-node="a"[^>]*tabindex="0"/);
  assert.equal(rows.filter(row => row.includes('aria-selected="true"')).length, 1); assert.match(html, /data-outline-node="a"[^>]*aria-selected="true"/);
  assert.match(html, /data-outline-node="a"[^>]*aria-level="2" aria-setsize="2" aria-posinset="2"/);
  assert.match(html, /<span class="outline-glyph" aria-hidden="true">\?<\/span><span class="outline-title">Idea a<\/span><span class="outline-state">Needs your answer<\/span>/);
  assert.match(html, /Offline &lt;sync&gt;/); assert.doesNotMatch(html, /<sync>/);
  assert.match(html, /data-outline-node="b1"[^>]*><span[^>]*>✳<\/span><span class="outline-title">Idea b1<\/span><span class="outline-state">Unexplored · needs review<\/span>/);
  assert.match(html, /<div role="group" aria-label="Not connected to the starting idea">[\s\S]*data-outline-node="lost"[\s\S]*data-outline-node="lost1"[\s\S]*<\/div><\/div>$/);
  const dimmed = outlineHtml(outlineRows(map), { esc, glyphs, selected: 'a', active: 'a', muted: new Set(['a']) });
  assert.equal((dimmed.match(/filter-muted/g) || []).length, 5); assert.doesNotMatch(dimmed, /data-outline-node="a"[^>]*filter-muted|class="outline-row filter-muted" data-outline-node="a"/);
});

test('indentation stops at ten levels, and deeper rows say their level', () => {
  const nodes = [idea('n0', null)];
  for (let level = 1; level < 13; level++) nodes.push(idea(`n${level}`, `n${level - 1}`));
  const html = outlineHtml(outlineRows({ rootId: 'n0', nodes, edges: [] }), { esc, glyphs, selected: null, active: 'n0', muted: null });
  const rowOf = id => html.match(new RegExp(`<div role="treeitem"[^>]*data-outline-node="${id}"[^>]*>[\\s\\S]*?</div>`))[0];
  assert.match(rowOf('n9'), /aria-level="10"[^>]*--indent:9/); assert.doesNotMatch(rowOf('n9'), /· level/);
  assert.match(rowOf('n10'), /aria-level="11"[^>]*--indent:10/); assert.doesNotMatch(rowOf('n10'), /· level/, 'the deepest indented level needs no number');
  assert.match(rowOf('n11'), /aria-level="12"[^>]*--indent:10[\s\S]*· level 12<\/span>/);
  assert.match(rowOf('n12'), /aria-level="13"[^>]*--indent:10[\s\S]*· level 13<\/span>/);
});

// A fake page: the outline box, the view buttons and #workspace, with focus tracked by row id.
function page({ stored = null, map = fixture(), selected = 'root' } = {}) {
  const storage = new Map(stored ? [['explore-view', stored]] : []), state = { visibleMap: map, selected };
  const io = { writes: 0, focused: null, selections: [], shown: 0, html: '' };
  const row = id => (io.html.includes(`data-outline-node="${id}"`) ? { inBox: true, dataset: { outlineNode: id }, closest() { return this; }, scrollIntoView() {}, focus() { io.focused = id; globalThis.document.activeElement = this; } } : null);
  const box = { hidden: true, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, contains: element => !!element?.inBox,
    set innerHTML(value) { io.html = value; io.writes++; }, get innerHTML() { return io.html; } };
  const classes = new Set(), workspace = { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) } };
  const buttons = ['map', 'outline'].map(view => ({ dataset: { view }, attributes: { 'data-command': 'view' }, setAttribute(name, value) { this.attributes[name] = value; },
    toggleAttribute(name, on) { if (on) this.attributes[name] ??= ''; else delete this.attributes[name]; }, addEventListener(type, handler) { this.click = handler; } }));
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  globalThis.CSS = { escape: value => value };
  globalThis.document = { activeElement: null };
  const $ = selector => (selector === '#outline' ? box : selector === '#workspace' ? workspace : selector.startsWith('[data-outline-node="') ? row(selector.slice(20, -2)) : null);
  const $$ = selector => (selector === '[data-view]' ? buttons : []);
  const panel = outlinePanel({ $, $$, esc, glyphs, state, select: id => { state.selected = id; io.selections.push(id); }, showMap: () => io.shown++ });
  const key = (id, name) => box.listeners.keydown({ key: name, target: row(id), preventDefault() {} });
  return { panel, io, state, box, classes, buttons, storage, row, key, view: name => buttons.find(button => button.dataset.view === name) };
}
test.afterEach(() => { delete globalThis.localStorage; delete globalThis.CSS; delete globalThis.document; });

test('the view is remembered, and the outline replaces the map until the user switches back', () => {
  let p = page();
  assert.equal(p.panel.active(), false); assert.equal(p.box.hidden, true); assert.equal(p.io.writes, 0, 'no outline is drawn behind the map');
  assert.equal(p.view('map').attributes['aria-pressed'], 'true');
  const commands = () => p.buttons.filter(button => 'data-command' in button.attributes).map(button => button.dataset.view);
  assert.deepEqual(commands(), ['outline'], 'the command palette offers only the other view');
  p.view('outline').click();
  assert.deepEqual(commands(), ['map']);
  assert.equal(p.panel.active(), true); assert.equal(p.storage.get('explore-view'), 'outline'); assert.equal(p.classes.has('outline-mode'), true);
  assert.equal(p.box.hidden, false); assert.equal(p.io.writes, 1); assert.equal(p.view('outline').attributes['aria-pressed'], 'true');
  p.view('map').click();
  assert.equal(p.storage.get('explore-view'), 'map'); assert.equal(p.classes.has('outline-mode'), false); assert.equal(p.io.shown, 1, 'the map centres the selected idea again');
  p = page({ stored: 'outline' });
  assert.equal(p.panel.active(), true); assert.equal(p.box.hidden, false);
});

test('arrow keys move the one tab stop; Enter or Space selects and keeps focus; the map is never written', () => {
  const p = page({ stored: 'outline' }), before = structuredClone(p.state.visibleMap);
  p.row('root').focus();
  p.key('root', 'ArrowDown');
  assert.equal(p.io.focused, 'b'); assert.match(p.io.html, /data-outline-node="b"[^>]*tabindex="0"/); assert.match(p.io.html, /data-outline-node="root"[^>]*tabindex="-1"/);
  p.key('b', 'ArrowRight'); assert.equal(p.io.focused, 'b1');
  p.key('b1', 'ArrowLeft'); assert.equal(p.io.focused, 'b');
  p.key('b', 'End'); assert.equal(p.io.focused, 'lost1');
  p.key('lost1', 'Home'); assert.equal(p.io.focused, 'root');
  assert.deepEqual(p.io.selections, [], 'moving does not select');
  p.key('root', 'ArrowDown'); p.key('b', 'ArrowDown'); p.key('b1', 'ArrowDown'); p.key('a', 'Enter');
  assert.deepEqual(p.io.selections, ['a']); assert.equal(p.io.focused, 'a'); assert.match(p.io.html, /data-outline-node="a"[^>]*aria-selected="true"/);
  p.key('a', ' '); assert.deepEqual(p.io.selections, ['a', 'a']);
  assert.deepEqual(p.state.visibleMap, before);
});

test('a redraw skips unchanged markup and keeps focus on the same row; Find an idea and filters reach the rows', () => {
  const p = page({ stored: 'outline' });
  p.row('a').focus(); p.panel.focusRow('a');
  const writes = p.io.writes;
  p.panel.render(); p.panel.render();
  assert.equal(p.io.writes, writes, 'a poll with nothing new leaves the rows alone');
  p.io.focused = null;
  p.state.visibleMap = structuredClone(p.state.visibleMap); p.state.visibleMap.nodes[2].title = 'Which phones first?';
  p.panel.render();
  assert.equal(p.io.writes, writes + 1); assert.match(p.io.html, /Which phones first\?/); assert.equal(p.io.focused, 'a', 'focus stays on the row');
  p.panel.focusRow('b1'); assert.equal(p.io.focused, 'b1'); assert.match(p.io.html, /data-outline-node="b1"[^>]*tabindex="0"/);
  p.panel.dim(new Set(['b1']));
  assert.equal((p.io.html.match(/filter-muted/g) || []).length, 5);
  p.panel.dim(null); assert.doesNotMatch(p.io.html, /filter-muted/);
});
