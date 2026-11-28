import { commandResults } from './workspace-view.js';

// The command palette (Z8): everything the user can do now, and the ideas on the map, in one searchable list. Each
// command runs the control it names, so it behaves exactly like that control and is offered only while that control
// is on the page. Idea commands act on the selected idea only, and say which.
//
// Other features add commands by adding controls; a control this list does not know is simply not offered.
const mapControls = [
  ['new', '#new-map', () => 'New exploration'], ['maps', '#maps-toggle', () => 'Maps'], ['brief', '#show-brief', () => 'Map brief'],
  ['history', '#show-history', ({ historic }) => (historic ? 'Return to live' : 'Growth history')], ['versions', '#show-versions', () => 'Versions'],
  ['tools', '#show-tools', () => 'Map tools'], ['fit', '#fit-map', () => 'Fit map'], ['focus', '#focus-selected', () => 'Focus selected idea'],
  ['zoom-in', '#zoom-in', () => 'Zoom in'], ['zoom-out', '#zoom-out', () => 'Zoom out'],
  ['theme', '#theme-toggle', (_, element) => (element.getAttribute('aria-pressed') === 'true' ? 'Light mode' : 'Dark mode')], ['agent', '#bridge-status', () => 'Connect your agent'],
];
// Buttons in the inspector for the selected idea, named by their own text.
const ideaButtons = ['[data-explore]', '[data-cancel]', '[data-accept]', '[data-branch-brief]'];
const clip = (text, length) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };
// A control the user could reach: on the page, enabled, and not inside something hidden. Menu items sit in closed
// menus, so only their own hidden flag counts.
// The question a form or answer is about: its label, or an answered question's heading.
const questionText = container => container?.querySelector('[id^="question-label-"]')?.textContent ?? container?.querySelector('strong')?.textContent;
const usable = element => !!element && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true'
  && (element.getAttribute?.('role') === 'menuitem' ? !element.hidden : !element.closest?.('[hidden], .hidden'));

// The commands available now: { id, label, group: 'map' | 'idea', run }.
export function availableCommands({ $, $$, title, historic, openEditor }) {
  const commands = [];
  for (const [id, selector, label] of mapControls) {
    const element = $(selector);
    if (usable(element)) commands.push({ id, group: 'map', label: label({ historic }, element), run: () => element.click() });
  }
  for (const filter of $$('#overview-filters [data-filter]')) if (usable(filter)) commands.push({ id: `filter:${filter.dataset.filter}`, group: 'map', label: `Show: ${clip(filter.querySelector('span')?.textContent, 60)}`, run: () => filter.click() });
  if (!title) return commands;
  const named = text => `${clip(text, 60)}: ${clip(title, 60)}`;
  for (const selector of ideaButtons) for (const button of $$(`#detail ${selector}`)) if (usable(button)) commands.push({ id: `idea:${selector}`, group: 'idea', label: named(button.textContent), run: () => button.click() });
  for (const name of ['suggest', 'revise']) {
    const summary = $(`#detail details[data-editor="${name}"] > summary`);
    if (usable(summary)) commands.push({ id: `editor:${name}`, group: 'idea', label: named(summary.textContent), run: () => { openEditor(name); $(`#detail details[data-editor="${name}"] :is(input, select, textarea)`)?.focus(); } });
  }
  const answer = $('#detail form[data-question] textarea');
  if (usable(answer)) commands.push({ id: 'answer', group: 'idea', label: `Answer the open question: ${clip(questionText(answer.closest('form')) ?? title, 60)}`, run: () => answer.focus() });
  // The ⋯ menus of the idea and its questions.
  for (const item of $$('#detail .item-menu [role="menuitem"]')) {
    if (!usable(item)) continue;
    const menu = item.closest('.item-menu'), forQuestion = menu?.getAttribute('aria-label') === 'More for this question';
    const question = forQuestion ? questionText(menu.closest('form, .answer')) : null;
    commands.push({ id: `menu:${item.textContent}`, group: 'idea', label: forQuestion ? `${clip(item.textContent, 40)} (question: ${clip(question, 50)})` : named(item.textContent), run: () => item.click() });
  }
  return commands;
}

// The palette dialog. `open()` shows it; Ctrl+K or ⌘K opens it too, outside text fields and other dialogs.
export function commandPalette({ $, $$, esc, state, focusNode, openEditor }) {
  const dialog = $('#command-dialog'), input = $('#command-input'), list = $('#command-list'), count = $('#command-count');
  let options = [], active = 0, returnTo = null, ran = false;
  const title = () => (state.visibleMap?.nodes.find(node => node.id === state.selected)?.title ?? null);
  function render() {
    const results = commandResults(availableCommands({ $, $$, title: title(), historic: state.historyStep !== null, openEditor }), state.visibleMap?.nodes ?? [], input.value);
    options = [...results.actions, ...results.ideas.map(node => ({ id: `node:${node.id}`, group: 'ideas', label: node.title, run: () => focusNode(node.id) }))];
    active = Math.min(active, Math.max(0, options.length - 1));
    const group = (name, label) => {
      const items = options.map((option, index) => ({ option, index })).filter(({ option }) => (name === 'ideas' ? option.group === 'ideas' : option.group !== 'ideas'));
      return items.length ? `<div role="group" aria-label="${label}"><p class="command-group">${label}</p>${items.map(({ option, index }) => `<div role="option" id="command-option-${index}" data-index="${index}" aria-selected="${index === active}" class="command-option">${esc(option.label)}</div>`).join('')}</div>` : '';
    };
    list.innerHTML = group('actions', 'Actions') + group('ideas', 'Ideas');
    if (options.length) input.setAttribute('aria-activedescendant', `command-option-${active}`); else input.removeAttribute('aria-activedescendant');
    count.textContent = options.length ? `${options.length} ${options.length === 1 ? 'result' : 'results'}` : 'No matching commands or ideas';
  }
  function choose(index) {
    const option = options[index]; if (!option) return;
    ran = true; dialog.close(); option.run();
  }
  function move(step) {
    if (!options.length) return;
    active = (active + step + options.length) % options.length;
    for (const element of $$('#command-list [role="option"]')) element.setAttribute('aria-selected', String(Number(element.dataset.index) === active));
    input.setAttribute('aria-activedescendant', `command-option-${active}`);
    $(`#command-option-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }
  function open() {
    if (dialog.open) return;
    returnTo = document.activeElement; ran = false; input.value = ''; active = 0; render();
    dialog.showModal(); input.focus();
  }
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); move(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); choose(active); }
  });
  list.addEventListener('mousedown', event => event.preventDefault()); // Focus stays in the search field.
  list.addEventListener('click', event => { const option = event.target.closest('[data-index]'); if (option) choose(Number(option.dataset.index)); });
  // Closed without running a command (Escape, or the close button): focus goes back where it was.
  dialog.addEventListener('close', () => { if (!ran) returnTo?.focus?.(); returnTo = null; });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return;
    event.preventDefault(); open();
  });
  $('#commands-open').addEventListener('click', open);
  return { open };
}
