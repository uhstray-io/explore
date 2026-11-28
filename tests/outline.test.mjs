import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
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
const shape = rows => rows.map(({ id, level, parentId, position, setSize, connected }) => [id, level, parentId, position, setSize, connected]);

test('rows follow the tree depth-first with children in map order, then ideas not under the starting idea', () => {
  const map = fixture(), before = structuredClone(map);
  assert.deepEqual(shape(outlineRows(map)), [
    ['root', 1, null, 1, 1, true], ['b', 2, 'root', 1, 2, true], ['b1', 3, 'b', 1, 1, true], ['a', 2, 'root', 2, 2, true],
    ['lost', 1, null, 1, 1, false], ['lost1', 2, 'lost', 1, 1, false],
  ]);
  assert.deepEqual(map, before, 'reading the outline never changes the map');
});

test('an idea listed before its unconnected parent still sits under it', () => {
  const map = { rootId: 'root', edges: [], nodes: [idea('root', null), idea('x', 'y'), idea('y', 'gone'), idea('z', 'y')] };
  assert.deepEqual(shape(outlineRows(map)), [['root', 1, null, 1, 1, true], ['y', 1, null, 1, 1, false], ['x', 2, 'y', 1, 2, false], ['z', 2, 'y', 2, 2, false]]);
});

test('a growth step lists only the ideas present then, each once', () => {
  assert.deepEqual(shape(outlineRows(mapAtGrowthStep(fixture(), 2))), [['root', 1, null, 1, 1, true], ['b', 2, 'root', 1, 2, true], ['a', 2, 'root', 2, 2, true]]);
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

test('each row is a treeitem named "title, state", with its level and position; selection is not in the markup', () => {
  const map = fixture();
  map.nodes[1].title = 'Offline <sync>';
  const html = outlineHtml(outlineRows(map), { esc, glyphs });
  const rows = html.match(/<div role="treeitem"[^>]*>/g);
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.includes('tabindex="-1"') && row.includes('aria-selected="false"')), 'the tab stop and selection are set on the page, not in the markup');
  assert.match(html, /data-outline-node="a" aria-label="Idea a, Needs your answer" aria-level="2" aria-setsize="2" aria-posinset="2"/);
  assert.match(html, /<span class="outline-glyph" aria-hidden="true">\?<\/span><span class="outline-title">Idea a<\/span><span class="outline-state">Needs your answer<\/span>/);
  assert.match(html, /aria-label="Offline &lt;sync&gt;, Unexplored"/); assert.doesNotMatch(html, /<sync>/);
  assert.match(html, /data-outline-node="b1"[^>]*><span[^>]*>✳<\/span><span class="outline-title">Idea b1<\/span><span class="outline-state">Unexplored · needs review<\/span>/);
  assert.match(html, /<div role="group" aria-label="Not connected to the starting idea">[\s\S]*data-outline-node="lost"[\s\S]*data-outline-node="lost1"[\s\S]*<\/div><\/div>$/);
});

test('indentation stops at eight levels, and deeper rows say their level', () => {
  const nodes = [idea('n0', null)];
  for (let level = 1; level < 12; level++) nodes.push(idea(`n${level}`, `n${level - 1}`));
  const html = outlineHtml(outlineRows({ rootId: 'n0', nodes, edges: [] }), { esc, glyphs });
  const rowOf = id => html.match(new RegExp(`<div role="treeitem"[^>]*data-outline-node="${id}"[^>]*>[\\s\\S]*?</div>`))[0];
  assert.match(rowOf('n8'), /aria-level="9"[^>]*--indent:8/); assert.doesNotMatch(rowOf('n8'), /level 9/, 'the deepest indented level needs no number');
  assert.match(rowOf('n9'), /aria-level="10"[^>]*--indent:8[\s\S]*<span class="outline-depth" aria-hidden="true">level 10<\/span>/);
  assert.match(rowOf('n11'), /aria-level="12"[^>]*--indent:8[\s\S]*level 12/);
});

// A fake page: the outline box (its rows parsed from what was written), the view buttons and #workspace.
function page({ stored = null, map = fixture(), selected = 'root' } = {}) {
  const storage = new Map(stored ? [['explore-view', stored]] : []), state = { visibleMap: map, selected };
  const io = { writes: 0, patches: 0, focused: null, focusOptions: null, scrolled: [], selections: [], shown: 0, html: '' };
  let elements = new Map();
  const parse = html => new Map([...html.matchAll(/<div role="treeitem"([^>]*)>/g)].map(([, text]) => {
    const attributes = Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const id = attributes['data-outline-node'], classes = new Set(attributes.class.split(' '));
    return [id, { dataset: { outlineNode: id }, attributes, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) },
      getAttribute: name => attributes[name] ?? null, setAttribute(name, value) { attributes[name] = String(value); io.patches++; }, closest() { return this; },
      scrollIntoView() { io.scrolled.push(id); }, focus(options) { io.focused = id; io.focusOptions = options; globalThis.document.activeElement = this; } }];
  }));
  const box = { hidden: true, listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, contains: element => [...elements.values()].includes(element),
    querySelectorAll: () => [...elements.values()], set innerHTML(value) { io.html = value; io.writes++; elements = parse(value); }, get innerHTML() { return io.html; } };
  const classes = new Set(), workspace = { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) } };
  const buttons = ['map', 'outline'].map(view => ({ dataset: { view, command: 'view' }, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(type, handler) { this.click = handler; } }));
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
  globalThis.CSS = { escape: value => value };
  globalThis.document = { activeElement: null };
  const $ = selector => (selector === '#outline' ? box : selector === '#workspace' ? workspace : selector.startsWith('[data-outline-node="') ? elements.get(selector.slice(20, -2)) ?? null : null);
  const $$ = selector => (selector === '[data-view]' ? buttons : []);
  const panel = outlinePanel({ $, $$, esc, glyphs, state, select: id => { state.selected = id; io.selections.push(id); panel.showSelection(); }, showMap: ({ refocus }) => { io.shown++; io.refocus = refocus; } });
  const row = id => elements.get(id);
  const key = (id, name, extra = {}) => box.listeners.keydown({ key: name, target: row(id), preventDefault() {}, ...extra });
  return { panel, io, state, box, classes, buttons, storage, row, key, view: name => buttons.find(button => button.dataset.view === name) };
}
test.afterEach(() => { delete globalThis.localStorage; delete globalThis.CSS; delete globalThis.document; });
const tabStops = p => [...p.box.querySelectorAll()].filter(element => element.getAttribute('tabindex') === '0').map(element => element.dataset.outlineNode);
const selectedRows = p => [...p.box.querySelectorAll()].filter(element => element.getAttribute('aria-selected') === 'true').map(element => element.dataset.outlineNode);

test('the view is remembered, and the outline replaces the map until the user switches back', () => {
  let p = page();
  assert.equal(p.panel.active(), false); assert.equal(p.box.hidden, true); assert.equal(p.io.writes, 0, 'no outline is drawn behind the map');
  assert.equal(p.view('map').attributes['aria-pressed'], 'true');
  const commands = () => p.buttons.filter(button => button.dataset.command).map(button => button.dataset.view);
  assert.deepEqual(commands(), ['outline'], 'the command palette offers only the other view');
  p.view('outline').click();
  assert.deepEqual(commands(), ['map']); assert.equal(p.view('map').dataset.command, 'view');
  assert.equal(p.panel.active(), true); assert.equal(p.storage.get('explore-view'), 'outline'); assert.equal(p.classes.has('outline-mode'), true);
  assert.equal(p.box.hidden, false); assert.equal(p.io.writes, 1); assert.equal(p.view('outline').attributes['aria-pressed'], 'true');
  assert.deepEqual(tabStops(p), ['root']); assert.deepEqual(selectedRows(p), ['root']);
  p.row('root').focus(); p.key('root', 'ArrowDown'); assert.deepEqual(tabStops(p), ['b']);
  p.view('map').click(); p.view('outline').click();
  assert.deepEqual(tabStops(p), ['root'], 'coming back, the tab stop is on the selected idea');
  p.row('b').focus();
  p.view('map').click();
  assert.equal(p.io.refocus, true, 'focus in a row that hides moves to the map');
  assert.equal(p.storage.get('explore-view'), 'map'); assert.equal(p.classes.has('outline-mode'), false); assert.equal(p.io.shown, 2, 'the map centres the selected idea again, each time');
  p = page({ stored: 'outline' });
  assert.equal(p.panel.active(), true); assert.equal(p.box.hidden, false);
});

test('arrow keys move the one tab stop in place; Enter, Space or a click selects and keeps focus; the map is never written', () => {
  const p = page({ stored: 'outline' }), before = structuredClone(p.state.visibleMap);
  p.row('root').focus();
  const writes = p.io.writes;
  p.key('root', 'ArrowDown');
  assert.equal(p.io.focused, 'b'); assert.deepEqual(tabStops(p), ['b']); assert.deepEqual(p.io.scrolled.at(-1), 'b', 'a move brings the row into view');
  p.key('b', 'ArrowRight'); assert.equal(p.io.focused, 'b1');
  p.key('b1', 'ArrowLeft'); assert.equal(p.io.focused, 'b');
  p.key('b', 'End'); assert.equal(p.io.focused, 'lost1');
  p.key('lost1', 'Home'); assert.equal(p.io.focused, 'root');
  p.key('root', 'ArrowDown', { ctrlKey: true }); assert.equal(p.io.focused, 'root', 'a modified key is left to the browser');
  assert.deepEqual(p.io.selections, [], 'moving does not select');
  assert.equal(p.io.writes, writes, 'moving patches the rows instead of redrawing them');
  p.key('root', 'ArrowDown'); p.key('b', 'ArrowDown'); p.key('b1', 'ArrowDown'); p.key('a', 'Enter');
  assert.deepEqual(p.io.selections, ['a']); assert.equal(p.io.focused, 'a'); assert.deepEqual(selectedRows(p), ['a']);
  p.key('a', ' '); assert.deepEqual(p.io.selections, ['a', 'a']);
  p.key('a', 'Enter', { altKey: true }); assert.equal(p.io.selections.length, 2);
  p.box.listeners.click({ target: p.row('lost') });
  assert.deepEqual(p.io.selections.at(-1), 'lost'); assert.equal(p.io.focused, 'lost'); assert.deepEqual(tabStops(p), ['lost']); assert.deepEqual(selectedRows(p), ['lost']);
  assert.equal(p.io.writes, writes, 'selecting patches the rows too');
  assert.deepEqual(p.state.visibleMap, before);
});

test('a redraw skips unchanged rows, and keeps focus without scrolling; selection, filters and Find an idea patch in place', () => {
  const p = page({ stored: 'outline' });
  p.panel.focusRow('a');
  assert.equal(p.io.focused, 'a'); assert.equal(p.io.scrolled.at(-1), 'a'); assert.deepEqual(tabStops(p), ['a']);
  const writes = p.io.writes;
  p.panel.render(); p.panel.render();
  assert.equal(p.io.writes, writes, 'a poll with nothing new leaves the rows alone');
  p.state.visibleMap = structuredClone(p.state.visibleMap); p.state.visibleMap.nodes[2].title = 'Which phones first?';
  const scrolled = p.io.scrolled.length;
  p.panel.render();
  assert.equal(p.io.writes, writes + 1); assert.match(p.io.html, /Which phones first\?/);
  assert.equal(p.io.focused, 'a', 'focus stays on the row'); assert.deepEqual(p.io.focusOptions, { preventScroll: true }); assert.equal(p.io.scrolled.length, scrolled, 'a redraw never scrolls the list');
  assert.deepEqual(tabStops(p), ['a']);
  p.state.selected = 'b'; p.panel.showSelection();
  assert.deepEqual(selectedRows(p), ['b']); assert.equal(p.io.writes, writes + 1);
  p.panel.dim(new Set(['b1']));
  assert.deepEqual([...p.box.querySelectorAll()].filter(element => element.classList.contains('filter-muted')).length, 5); assert.equal(p.io.writes, writes + 1);
  p.state.visibleMap = structuredClone(p.state.visibleMap); p.state.visibleMap.nodes[0].title = 'Renamed';
  p.panel.render();
  assert.equal([...p.box.querySelectorAll()].filter(element => element.classList.contains('filter-muted')).length, 5, 'a redraw keeps the filter');
  p.panel.dim(null); assert.equal([...p.box.querySelectorAll()].filter(element => element.classList.contains('filter-muted')).length, 0);
});

// The app's side: the real selectNode and focusNode from app.js, against stubs for the page and the outline.
const app = await readFile(new URL('../skills/explore/assets/app.js', import.meta.url), 'utf8');
const between = (start, end) => { const from = app.indexOf(start), to = app.indexOf(end, from); assert.ok(from >= 0 && to > from, `${start} is still in app.js`); return app.slice(from, to); };
function appFunctions({ outlineMode }) {
  const calls = [], state = { visibleMap: { nodes: [{ id: 'node-1' }, { id: 'node-2' }] }, positions: { 'node-1': {}, 'node-2': {} }, selected: 'node-1' };
  const element = { hidden: false, disabled: false, focus: () => calls.push('canvas focus') };
  const context = vm.createContext({ state, document: { querySelectorAll: () => [] }, $: () => element, visibleSelection: (map, id) => id, showAddress() {}, renderDetail() {},
    centerSelected: () => calls.push('centre'), closeOverview() {},
    outline: { active: () => outlineMode, focusRow: id => calls.push(['row', id]), showSelection: () => calls.push('outline selection') } });
  vm.runInContext(between('function selectNode(', '\n// Git status of the open map') + between('function focusNode(', '\nfunction centerSelected('), context);
  return { context, calls, state };
}

test('in outline mode Find an idea, filter lists and links focus the row instead of centring the canvas', () => {
  let a = appFunctions({ outlineMode: true });
  a.context.focusNode('node-2');
  assert.equal(a.state.selected, 'node-2'); assert.deepEqual(a.calls, ['outline selection', ['row', 'node-2']]);
  a = appFunctions({ outlineMode: false });
  a.context.focusNode('node-2');
  assert.deepEqual(a.calls, ['outline selection', 'centre', 'canvas focus']);
});

test('the page has the outline tree and the switch, and outline mode hides the canvas and its tools', async () => {
  const html = await readFile(new URL('../skills/explore/assets/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../skills/explore/assets/constellation.css', import.meta.url), 'utf8');
  assert.match(html, /<div id="outline" class="outline" role="tree" aria-label="Outline of ideas" hidden><\/div>/);
  assert.match(html, /<div class="view-switch" role="group" aria-label="View"><button type="button" data-view="map"[^>]*>Map<\/button><button type="button" data-view="outline"[^>]*>Outline<\/button><\/div>/);
  assert.match(css, /\.outline-mode #canvas,\.outline-mode \.canvas-toolbar,\.outline-mode #canvas-instruction,\.outline-mode #focus-selected\{display:none\}/);
});
