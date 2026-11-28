import test from 'node:test';
import assert from 'node:assert/strict';
import { availableCommands, commandPalette } from '../skills/explore/assets/command-palette.js';
import { commandResults, ideaMatches } from '../skills/explore/assets/workspace-view.js';

// Command palette (Z8, #66). A small fake page; no server.
const esc = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
function element({ text = '', attributes = {}, dataset = {}, hidden = false, disabled = false, parent = null, children = {} } = {}) {
  const self = { textContent: text, dataset, hidden, disabled, parent, clicks: 0, attributes: { ...attributes },
    getAttribute(name) { return this.attributes[name] ?? null; }, setAttribute(name, value) { this.attributes[name] = String(value); }, removeAttribute(name) { delete this.attributes[name]; },
    click() { this.clicks++; }, focus() { focused.current = this; },
    closest(selector) {
      for (let at = this; at; at = at.parent) {
        if (selector === '[hidden], .hidden' && (at.hidden || at.attributes.class === 'hidden')) return at;
        if (selector === '.item-menu' && at.attributes.class === 'item-menu') return at;
        if (selector === 'form, .answer' && at.attributes.tag === 'form') return at;
      }
      return null;
    },
    querySelector(selector) { return children[selector] ?? null; } };
  return self;
}
const focused = { current: null };
function page({ historic = false, workspaceHidden = false } = {}) {
  const workspace = element({ attributes: workspaceHidden ? { class: 'hidden' } : {} });
  const one = { '#maps-toggle': element({ text: '☷ Maps' }), '#show-brief': element({ parent: workspace }), '#show-history': element({ parent: workspace }), '#fit-map': element({ parent: workspace }),
    '#theme-toggle': element({ attributes: { 'aria-pressed': 'true' } }), '#zoom-in': element({ parent: workspace, disabled: true }) };
  const filters = [element({ dataset: { filter: 'answer' }, parent: workspace, children: { span: { textContent: 'Needs your answer' } } })];
  const detail = historic ? [] : [element({ text: 'Explore this branch', attributes: { 'data-explore': 'node-a' } })];
  const form = element({ attributes: { tag: 'form' }, children: { '[id^="question-label-"]': { textContent: 'Which phones?' } } });
  const questionMenu = element({ attributes: { class: 'item-menu', 'aria-label': 'More for this question' }, parent: form, hidden: true });
  const ideaMenu = element({ attributes: { class: 'item-menu', 'aria-label': 'More for this idea' }, hidden: true });
  const items = historic ? [] : [element({ text: 'Help me answer', attributes: { role: 'menuitem' }, parent: questionMenu }), element({ text: 'Tidy my wording', attributes: { role: 'menuitem' }, parent: questionMenu, hidden: true }),
    element({ text: 'Copy link', attributes: { role: 'menuitem' }, parent: ideaMenu })];
  const summary = historic ? null : element({ text: 'Add a direction' });
  const textarea = historic ? null : element({ parent: form });
  textarea && (textarea.closest = selector => (selector === 'form' ? form : null));
  return {
    $: selector => one[selector] ?? (selector === '#detail details[data-editor="suggest"] > summary' ? summary : selector === '#detail form[data-question] textarea' ? textarea : null),
    $$: selector => (selector === '#overview-filters [data-filter]' ? filters : selector === '#detail [data-explore]' ? detail : selector === '#detail .item-menu [role="menuitem"]' ? items : []),
    one, items,
  };
}

test('ideas match by Find an idea’s rule; an empty query lists only actions', () => {
  const nodes = [{ id: 'a', title: 'Offline sync', summary: 'Conflicts' }, { id: 'b', title: 'Photos', summary: '' }];
  assert.deepEqual(ideaMatches(nodes, ' CONFLICT ').map(node => node.id), ['a']);
  const commands = [{ label: 'Map brief' }, { label: 'Zoom in' }];
  assert.deepEqual(commandResults(commands, nodes, ''), { actions: commands, ideas: [] });
  assert.deepEqual(commandResults(commands, nodes, 'zoom').actions, [{ label: 'Zoom in' }]);
  assert.deepEqual(commandResults(commands, nodes, 'photo').ideas.map(node => node.id), ['b']);
  assert.equal(commandResults([], Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, title: `Idea ${i}` })), 'idea').ideas.length, 12);
});

test('commands are the controls the user could reach now, and idea commands name the selected idea', () => {
  const live = page();
  const labels = availableCommands({ ...live, title: 'Offline sync', historic: false, openEditor() {} }).map(command => command.label);
  assert.deepEqual(labels, ['Maps', 'Map brief', 'Growth history', 'Fit map', 'Light mode', 'Show: Needs your answer', 'Explore this branch: Offline sync', 'Add a direction: Offline sync',
    'Answer the open question: Which phones?', 'Help me answer (question: Which phones?)', 'Copy link: Offline sync']);
  assert.ok(!labels.includes('Zoom in'), 'a disabled control is left out'); assert.ok(!labels.some(label => /Tidy/.test(label)), 'a hidden menu item too');
  // Growth history: no map-changing commands, and Return to live.
  const past = availableCommands({ ...page({ historic: true }), title: 'Offline sync', historic: true, openEditor() {} }).map(command => command.label);
  assert.ok(past.includes('Return to live')); assert.ok(!past.some(label => /Explore this branch|Add a direction|Answer the open question/.test(label)));
  // Before a map is open, workspace controls are out of reach.
  const welcome = availableCommands({ ...page({ workspaceHidden: true }), title: null, historic: false, openEditor() {} }).map(command => command.label);
  assert.deepEqual(welcome, ['Maps', 'Light mode']);
  // A command runs its control, so it does exactly what the control does.
  const explore = availableCommands({ ...live, title: 'Offline sync', historic: false, openEditor() {} }).find(command => command.label.startsWith('Explore this branch'));
  explore.run(); assert.equal(live.$$('#detail [data-explore]')[0].clicks, 1);
});

test('the palette opens from the button or Ctrl+K, runs the chosen option, and Escape returns focus', () => {
  const handlers = {}, listeners = { keydown: [] };
  const control = name => ({ value: '', attributes: {}, open: false, innerHTML: '', textContent: '', dataset: {},
    addEventListener(type, fn) { (handlers[`${name}:${type}`] ??= []).push(fn); }, setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; },
    showModal() { this.open = true; }, close() { this.open = false; for (const fn of handlers[`${name}:close`] || []) fn(); }, focus() { focused.current = this; } });
  const dom = { '#command-dialog': control('dialog'), '#command-input': control('input'), '#command-list': control('list'), '#command-count': control('count'), '#commands-open': control('button') };
  globalThis.document = { activeElement: null, addEventListener: (type, fn) => listeners[type].push(fn), querySelector: () => (dom['#command-dialog'].open ? dom['#command-dialog'] : null) };
  try {
    const opened = [], previous = { focus() { focused.current = this; } };
    const state = { selected: null, historyStep: null, visibleMap: { nodes: [{ id: 'a', title: 'Offline sync', summary: '' }] } };
    commandPalette({ $: selector => dom[selector] ?? null, $$: () => [], esc, state, focusNode: id => opened.push(id), openEditor() {} });
    const key = (extra, target = { tagName: 'BODY' }) => { let prevented = false; for (const fn of listeners.keydown) fn({ key: 'k', ctrlKey: true, target, preventDefault() { prevented = true; }, ...extra }); return prevented; };
    assert.equal(key({}, { tagName: 'INPUT' }), false, 'ignored in a text field');
    globalThis.document.activeElement = previous;
    assert.equal(key({}), true); assert.equal(dom['#command-dialog'].open, true);
    assert.match(dom['#command-count'].textContent, /^\d+ results?$|^No matching/);
    // Type an idea and press Enter: it opens the idea and closes the palette.
    dom['#command-input'].value = 'sync'; for (const fn of handlers['input:input']) fn();
    assert.match(dom['#command-list'].innerHTML, /role="option" id="command-option-0" data-index="0" aria-selected="true" class="command-option">Offline sync</);
    assert.equal(dom['#command-input'].attributes['aria-activedescendant'], 'command-option-0'); assert.equal(dom['#command-count'].textContent, '1 result');
    for (const fn of handlers['input:keydown']) fn({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(opened, ['a']); assert.equal(dom['#command-dialog'].open, false);
    // Opened again from the button and closed without choosing: focus goes back.
    focused.current = null; globalThis.document.activeElement = previous;
    for (const fn of handlers['button:click']) fn();
    assert.equal(key({}), false, 'ignored while a dialog is open');
    dom['#command-dialog'].close();
    assert.equal(focused.current, previous);
  } finally { delete globalThis.document; }
});
