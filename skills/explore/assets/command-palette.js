import { commandResults, draftNeeded } from './workspace-view.js';

// The command palette (Z8): everything the user can do now, and the ideas on the map, in one searchable list.
//
// A command is a control on the page: any element marked `data-command`, and every item of the inspector's ⋯ menus.
// It is offered only while the user could reach it, and running it clicks that control (or focuses a field), so it
// does exactly what the control does. Features add commands by marking their controls; the palette never changes.
//   data-command-label    the command's name, when the control's own text or aria-label is not it
//   data-command-anywhere the control works from a closed panel (the Maps rail), so only a hidden page rules it out
//   data-command-editor   opens that inspector editor and focuses its first field
//   data-node-id / data-question-id  what it acts on; the name then says which idea or question

// The controls that are commands now, in page order.
const candidates = $$ => [...$$('[data-command]'), ...$$('#detail .item-menu [role="menuitem"]')];
const visible = element => (typeof element.checkVisibility === 'function' ? element.checkVisibility() : !element.closest('[hidden], .hidden'));
// Whether the user could use it: enabled, and visible, or in a menu whose ⋯ button is visible and that would show it.
export function reachable(element, $) {
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
  if (element.getAttribute('role') === 'menuitem') {
    const menu = element.closest('.item-menu'), toggle = menu && $(`[aria-controls="${menu.id}"]`);
    return !!toggle && visible(toggle) && !draftNeeded(element) && (!element.hidden || element.hasAttribute('data-needs-draft'));
  }
  return element.hasAttribute('data-command-anywhere') ? !element.closest('.hidden') : visible(element);
}

const clip = (text, length) => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };
// What a control acts on: the question or idea it names, or the selected idea for the idea's own menu.
const scope = (element, selected) => ({ nodeId: element.dataset.nodeId ?? (element.closest('#detail') ? selected : null), questionId: element.dataset.questionId ?? null });
// A command's identity, so it can be found again after the page is redrawn.
const keyOf = (element, selected) => { const { nodeId, questionId } = scope(element, selected); return JSON.stringify([element.dataset.command ?? 'menu', element.textContent.trim(), nodeId, questionId]); };
// Its name, from the control and the map: the idea's title or the question's text, never scraped from the page.
function labelOf(element, map, selected) {
  const own = clip(element.dataset.commandLabel ?? element.getAttribute('aria-label') ?? element.textContent, 60);
  const { nodeId, questionId } = scope(element, selected), node = nodeId ? map?.nodes.find(item => item.id === nodeId) : null;
  const question = questionId ? node?.questions.find(item => item.id === questionId) : null;
  if (question) return `${own} (question: ${clip(question.text, 50)})`;
  return node ? `${own}: ${clip(node.title, 60)}` : own;
}

// The commands available now: { key, label, run }. `run` finds the control again by its key and uses it, or says
// it is gone, so a redraw never leaves a command acting on nothing, and it never acts on another idea.
export function availableCommands({ $, $$, map, selected, openEditor, toast }) {
  return candidates($$).filter(element => reachable(element, $)).map(element => {
    const key = keyOf(element, selected);
    return { key, label: labelOf(element, map, selected), run: () => {
      const target = candidates($$).find(item => keyOf(item, selected) === key && reachable(item, $));
      if (!target) { toast('That command is no longer available. Open the palette again to see what you can do now.'); return; }
      if (target.dataset.commandEditor) openEditor(target.dataset.commandEditor);
      else if (target.matches('textarea, input')) target.focus();
      else target.click();
    } };
  });
}

// The palette dialog. Ctrl+K or ⌘K opens it too, outside text fields and other dialogs.
export function commandPalette({ $, $$, esc, state, focusNode, openEditor, toast }) {
  const dialog = $('#command-dialog'), input = $('#command-input'), list = $('#command-list'), count = $('#command-count');
  let options = [], active = 0, returnTo = null, ran = false;
  function render() {
    const results = commandResults(availableCommands({ $, $$, map: state.visibleMap, selected: state.selected, openEditor, toast }), state.visibleMap?.nodes ?? [], input.value);
    const ideas = results.ideas.map(node => ({ label: node.title, run: () => focusNode(node.id) }));
    options = [...results.actions, ...ideas];
    const option = (item, index) => `<div role="option" id="command-option-${index}" data-index="${index}" aria-selected="${index === active}" class="command-option">${esc(item.label)}</div>`;
    const group = (label, items, offset) => (items.length ? `<div role="group" aria-label="${label}"><p class="command-group">${label}</p>${items.map((item, i) => option(item, offset + i)).join('')}</div>` : '');
    list.innerHTML = group('Actions', results.actions, 0) + group('Ideas', ideas, results.actions.length);
    if (options.length) input.setAttribute('aria-activedescendant', `command-option-${active}`); else input.removeAttribute('aria-activedescendant');
    const more = results.ideaTotal > ideas.length ? ` · showing ${ideas.length} of ${results.ideaTotal} ideas, type more to narrow` : '';
    count.textContent = options.length ? `${options.length} ${options.length === 1 ? 'result' : 'results'}${more}` : 'No matching commands or ideas';
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
  // Closed without running a command (Escape, or a click outside): focus goes back where it was.
  dialog.addEventListener('close', () => { if (!ran) returnTo?.focus?.(); returnTo = null; });
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable || document.querySelector('dialog[open]')) return;
    event.preventDefault(); open();
  });
  $('#commands-open').addEventListener('click', open);
  return { open };
}
