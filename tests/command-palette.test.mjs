import test from 'node:test';
import assert from 'node:assert/strict';
import { availableCommands, commandPalette } from '../skills/explore/assets/command-palette.js';
import { commandResults, ideaMatches, draftNeeded } from '../skills/explore/assets/workspace-view.js';

// Command palette (Z8, #66). A fake page whose controls behave like the real ones: marked with data-command or in a
// ⋯ menu, visible or not (checkVisibility), and replaced by new elements when the inspector is redrawn.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const map = { nodes: [
  { id: 'node-a', title: 'Offline sync', summary: 'Conflicts', questions: [{ id: 'q-1', text: 'Which phones?' }, { id: 'q-2', text: 'Who edits?' }] },
  { id: 'node-b', title: 'Photos', summary: '', questions: [] },
] };
function page() {
  const clicks = [], focused = [];
  let generation = 0;
  const control = ({ tag = 'button', text = '', data = {}, attributes = {}, visible = true, parent = null, hidden = false }) => ({
    tag, textContent: text, dataset: { ...data }, attributes: { ...attributes }, hidden, disabled: false, parent, generation,
    getAttribute(name) { return this.attributes[name] ?? null; }, hasAttribute(name) { return name in this.attributes || name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()) in this.dataset; },
    checkVisibility() { return visible; }, matches(selector) { return selector === 'textarea, input' && (this.tag === 'textarea' || this.tag === 'input'); },
    closest(selector) { for (let at = this; at; at = at.parent) { if (selector === '#detail' && at.id === 'detail') return at; if (selector === '.item-menu' && at.attributes.class === 'item-menu') return at; if (selector === 'form' && at.tag === 'form') return at; } return null; },
    querySelector(selector) { return selector === '[data-draft]' ? this.draft ?? null : null; },
    click() { clicks.push([this.generation, this.dataset.command ?? this.textContent]); }, focus() { focused.push([this.generation, this.dataset.command]); },
  });
  let controls = [], toggles = {};
  const draw = ({ selected = 'node-a', yourAnswersOpen = false, draft = '' } = {}) => {
    generation++;
    const detail = { id: 'detail' };
    const form = { tag: 'form', parent: detail, querySelector: selector => (selector === '[data-draft]' ? { value: draft } : null) };
    const questionMenu = { attributes: { class: 'item-menu' }, id: 'menu-q-1', parent: form };
    const answeredMenu = { attributes: { class: 'item-menu' }, id: 'menu-q-2', parent: detail };
    toggles = { 'menu-q-1': control({ visible: true }), 'menu-q-2': control({ visible: yourAnswersOpen }) };
    controls = [
      control({ text: 'Map brief', data: { command: 'brief' } }),
      control({ text: 'Zoom in', data: { command: 'zoom-in' }, attributes: { 'aria-label': 'Zoom in' }, visible: false }),
      control({ text: '+ New exploration', data: { command: 'new-map', commandLabel: 'New exploration' }, attributes: { 'data-command-anywhere': '' }, visible: false }),
      control({ text: 'Explore this branch', data: { command: 'explore', nodeId: selected }, parent: detail }),
      control({ text: 'Add a direction', data: { command: 'add-direction', commandEditor: 'suggest', nodeId: selected }, parent: detail }),
      control({ tag: 'textarea', data: { command: 'answer', commandLabel: 'Answer', nodeId: selected, questionId: 'q-1' }, parent: form }),
      control({ text: 'Help me answer', data: { nodeId: selected, questionId: 'q-1' }, attributes: { role: 'menuitem' }, parent: questionMenu }),
      control({ text: 'Tidy my wording', data: { nodeId: selected, questionId: 'q-1' }, attributes: { role: 'menuitem', 'data-needs-draft': '' }, parent: questionMenu, hidden: true }),
      control({ text: 'Change answer', data: { nodeId: selected, questionId: 'q-2' }, attributes: { role: 'menuitem' }, parent: answeredMenu }),
    ];
  };
  draw();
  const $ = selector => { const menu = selector.match(/^\[aria-controls="([^"]+)"\]$/); return menu ? toggles[menu[1]] ?? null : null; };
  const $$ = selector => (selector === '[data-command]' ? controls.filter(item => item.dataset.command) : selector === '#detail .item-menu [role="menuitem"]' ? controls.filter(item => item.attributes.role === 'menuitem') : []);
  return { $, $$, draw, clicks, focused, controls: () => controls };
}
const labels = (io, selected = 'node-a', toast = () => {}) => availableCommands({ $: io.$, $$: io.$$, map, selected, openEditor: name => io.focused.push(['editor', name]), toast }).map(command => command.label);

test('ideas match by Find an idea’s rule; an empty query lists only actions; the count knows about the cap', () => {
  const nodes = [{ id: 'a', title: 'Offline sync', summary: 'Conflicts' }, { id: 'b', title: 'Photos', summary: '' }];
  assert.deepEqual(ideaMatches(nodes, ' CONFLICT ').map(node => node.id), ['a']);
  const commands = [{ label: 'Map brief' }, { label: 'Zoom in' }];
  assert.deepEqual(commandResults(commands, nodes, ''), { actions: commands, ideas: [], ideaTotal: 0 });
  assert.deepEqual(commandResults(commands, nodes, 'zoom').actions, [{ label: 'Zoom in' }]);
  const many = commandResults([], Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, title: `Idea ${i}` })), 'idea');
  assert.equal(many.ideas.length, 12); assert.equal(many.ideaTotal, 20);
});

test('only controls the user could reach are offered, named from the map', () => {
  const io = page();
  assert.deepEqual(labels(io), ['Map brief', 'New exploration', 'Explore this branch: Offline sync', 'Add a direction: Offline sync', 'Answer (question: Which phones?)', 'Help me answer (question: Which phones?)']);
  // "Zoom in" is not visible; Tidy needs a draft; "Change answer" sits in a collapsed section. Menu items are not hidden
  // themselves, their menu is; only Tidy is rendered hidden until there is a draft.
  io.draw({ draft: 'android', yourAnswersOpen: true });
  assert.deepEqual(labels(io).slice(-3), ['Help me answer (question: Which phones?)', 'Tidy my wording (question: Which phones?)', 'Change answer (question: Who edits?)']);
});

test('a command finds its control again after a redraw, and never acts on another idea', () => {
  const io = page(), toasts = [];
  const commands = availableCommands({ $: io.$, $$: io.$$, map, selected: 'node-a', openEditor: name => io.focused.push(['editor', name]), toast: message => toasts.push(message) });
  const explore = commands.find(command => command.label.startsWith('Explore this branch'));
  io.draw(); // A poll redrew the inspector: every element is new.
  explore.run();
  assert.deepEqual(io.clicks, [[2, 'explore']], 'the new button was clicked, not the detached one');
  commands.find(command => command.label.startsWith('Add a direction')).run();
  assert.deepEqual(io.focused.at(-1), ['editor', 'suggest']);
  commands.find(command => command.label.startsWith('Answer')).run();
  assert.deepEqual(io.focused.at(-1), [2, 'answer'], 'a field is focused, not clicked');
  io.draw({ selected: 'node-b' }); // The selection moved to another idea.
  explore.run();
  assert.equal(io.clicks.length, 1, 'nothing on the other idea is clicked'); assert.match(toasts.at(-1), /no longer available/);
});

test('the draft rule is the one the ⋯ menu uses', () => {
  const item = draft => ({ hasAttribute: name => name === 'data-needs-draft', closest: () => ({ querySelector: () => ({ value: draft }) }) });
  assert.equal(draftNeeded(item('')), true); assert.equal(draftNeeded(item('  text ')), false);
  assert.equal(draftNeeded({ hasAttribute: () => false }), false);
});

test('the palette opens from the button or Ctrl+K, runs the chosen option, and Escape returns focus', () => {
  const handlers = {}, listeners = { keydown: [] }, focused = { current: null };
  const control = name => ({ value: '', attributes: {}, open: false, innerHTML: '', textContent: '', dataset: {},
    addEventListener(type, fn) { (handlers[`${name}:${type}`] ??= []).push(fn); }, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
    showModal() { this.open = true; }, close() { this.open = false; for (const fn of handlers[`${name}:close`] || []) fn(); }, focus() { focused.current = this; } });
  const dom = { '#command-dialog': control('dialog'), '#command-input': control('input'), '#command-list': control('list'), '#command-count': control('count'), '#commands-open': control('button') };
  globalThis.document = { activeElement: null, addEventListener: (type, fn) => listeners[type].push(fn), querySelector: () => (dom['#command-dialog'].open ? dom['#command-dialog'] : null) };
  try {
    const opened = [], previous = { focus() { focused.current = this; } };
    const state = { selected: null, historyStep: null, visibleMap: { nodes: Array.from({ length: 14 }, (_, i) => ({ id: `n${i}`, title: `Sync idea ${i}`, summary: '', questions: [] })) } };
    commandPalette({ $: selector => dom[selector] ?? null, $$: () => [], esc, state, focusNode: id => opened.push(id), openEditor() {}, toast() {} });
    const key = (target = { tagName: 'BODY' }) => { let prevented = false; for (const fn of listeners.keydown) fn({ key: 'k', ctrlKey: true, target, preventDefault() { prevented = true; } }); return prevented; };
    assert.equal(key({ tagName: 'INPUT' }), false, 'ignored in a text field');
    globalThis.document.activeElement = previous;
    assert.equal(key(), true); assert.equal(dom['#command-dialog'].open, true);
    dom['#command-input'].value = 'sync'; for (const fn of handlers['input:input']) fn();
    assert.match(dom['#command-list'].innerHTML, /role="option" id="command-option-0" data-index="0" aria-selected="true" class="command-option">Sync idea 0</);
    assert.equal(dom['#command-count'].textContent, '12 results · showing 12 of 14 ideas, type more to narrow');
    for (const fn of handlers['input:keydown']) fn({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(opened, ['n0']); assert.equal(dom['#command-dialog'].open, false);
    focused.current = null; globalThis.document.activeElement = previous;
    for (const fn of handlers['button:click']) fn();
    assert.equal(key(), false, 'ignored while a dialog is open');
    dom['#command-dialog'].close();
    assert.equal(focused.current, previous, 'closing without a choice returns focus');
  } finally { delete globalThis.document; }
});
