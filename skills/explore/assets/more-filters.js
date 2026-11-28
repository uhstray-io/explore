// The More filters panel (Z9): its markup and controller. The filters themselves are in workspace-view.js.

const headings = { state: 'How settled answers are', importance: 'Importance of open questions', impact: 'Impact' };
export function moreFiltersHtml(groups, { esc, active }) {
  const section = (kind, heading) => `<div class="more-filters-group" role="group" aria-label="${heading}"><h3>${heading}</h3>${groups.filter(group => group.kind === kind)
    .map(group => `<button type="button" data-more-filter="${group.id}" aria-pressed="${group.id === active}"><span>${esc(group.short)}</span><strong>${group.nodes.length}</strong></button>`).join('')}</div>`;
  return Object.entries(headings).filter(([kind]) => groups.some(group => group.kind === kind)).map(([kind, heading]) => section(kind, heading)).join('');
}

// The More filters button, its panel and Clear filter. `openFilter(id)` sets the one shared filter (null clears it);
// `focusList()` moves into the overview list. render(groups, filter) runs with every overview render, with these
// filters' groups only.
export function moreFiltersPanel({ esc, openFilter, focusList }) {
  const wrap = document.querySelector('.more-filters'), button = document.querySelector('#more-filters'), panel = document.querySelector('#more-filters-panel'), clear = document.querySelector('#clear-filter');
  let groups = [], active = null, written = '';
  const mine = filter => groups.some(group => group.id === filter);
  // Redrawn only when it changed, keeping focus on the same choice when counts change under it.
  const draw = () => {
    const html = moreFiltersHtml(groups, { esc, active }); if (html === written) return;
    const focused = panel.contains(document.activeElement) ? document.activeElement.dataset.moreFilter : null;
    panel.innerHTML = html; written = html;
    if (focused) panel.querySelector(`[data-more-filter="${focused}"]`)?.focus();
  };
  const close = (focus = false) => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  button.addEventListener('click', () => {
    if (!panel.hidden) return close();
    draw(); panel.hidden = false; button.setAttribute('aria-expanded', 'true');
    (panel.querySelector('[aria-pressed="true"]') ?? panel.querySelector('button'))?.focus();
  });
  wrap.addEventListener('keydown', event => {
    // Escape closes the open panel and goes no further, so it never also clears the filter.
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); event.stopPropagation(); close(true); }
    // Arrow Down from the active choice enters the list, as from a progress filter.
    else if (event.key === 'ArrowDown' && event.target === button && panel.hidden && mine(active)) { event.preventDefault(); focusList(); }
  });
  // Leaving by keyboard closes it. A click elsewhere closes it too; some browsers move no focus on a click.
  wrap.addEventListener('focusout', event => { if (!panel.hidden && event.relatedTarget && !wrap.contains(event.relatedTarget)) close(); });
  document.addEventListener('click', event => { if (!panel.hidden && !wrap.contains(event.target)) close(); });
  panel.addEventListener('click', event => {
    const choice = event.target.closest('[data-more-filter]'); if (!choice) return;
    close(); openFilter(choice.dataset.moreFilter === active ? null : choice.dataset.moreFilter); button.focus();
  });
  clear.addEventListener('click', () => { openFilter(null); button.focus(); });
  return {
    render(next, filter) {
      groups = next; active = filter;
      const group = groups.find(item => item.id === filter), text = group ? `Filter: ${group.name}` : 'More filters';
      if (button.textContent !== text) button.textContent = text;
      clear.hidden = !group;
      if (!panel.hidden) draw();
    },
  };
}
