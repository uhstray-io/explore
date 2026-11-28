import { answerStateLabels, effectiveAnswerState, isOpen, importanceLevels, importanceName } from './questions.js';

// More map filters (Z9): how settled answers are and how much open questions matter, beside the progress filters.
// Read-only. Each group is shaped like mapOverview().groups, so the overview list and the dimming work unchanged,
// and `lines(node)` names that idea's matching questions for the list.
const oneLine = (text, length) => { const flat = String(text).replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat; };
const completed = node => !!node.completed || node.status === 'explored';
const current = question => !!question.answer && !question.supersededAt && !question.dismissedAt;

const stateGroups = [
  ...['decided', 'tentative', 'assumption'].map(state => ({ id: `state:${state}`, short: answerStateLabels[state], name: answerStateLabels[state],
    label: `Answers marked ${answerStateLabels[state]}`, empty: `No current answers are marked ${answerStateLabels[state]}.`,
    questions: node => node.questions.filter(q => current(q) && effectiveAnswerState(q).state === state),
    // Older answers have no recorded state; they count as Tentative and say so.
    line: q => `${oneLine(q.text, 160)} — ${oneLine(q.answer, 120)}${effectiveAnswerState(q).recorded ? '' : ' · Tentative (not recorded)'}` })),
  { id: 'state:later', short: 'Saved for later', name: 'Saved for later', label: 'Questions saved for later', empty: 'No open questions are saved for later.',
    questions: node => node.questions.filter(q => isOpen(q) && q.deferredAt), line: q => oneLine(q.text, 160) },
];
// Importance helps choose what to answer next, so only open questions on unfinished branches count.
const importanceGroups = [...importanceLevels, 'unranked'].map(level => {
  const word = importanceName(level), unranked = level === 'unranked';
  return { id: `importance:${level}`, short: word, name: unranked ? 'Unranked' : `${word} importance`,
    label: unranked ? 'Unranked open questions' : `Open questions of ${word} importance`,
    empty: unranked ? 'No open questions are unranked.' : `No open questions have ${word} importance.`,
    questions: node => (completed(node) ? [] : node.questions.filter(q => isOpen(q) && (unranked ? !importanceLevels.includes(q.importance) : q.importance === level))),
    line: q => oneLine(q.text, 160) };
});

export const isQuestionFilter = id => typeof id === 'string' && /^(state|importance):/.test(id);
export function questionFilters(map) {
  const nodes = map?.nodes || [];
  const groups = [...stateGroups.map(group => ({ ...group, kind: 'state' })), ...importanceGroups.map(group => ({ ...group, kind: 'importance' }))];
  return { groups: groups.map(({ questions, line, ...group }) => ({ ...group, nodes: nodes.filter(node => questions(node).length), lines: node => questions(node).map(line) })) };
}

export function moreFiltersHtml(groups, { esc, active }) {
  const section = (kind, heading) => `<div class="more-filters-group" role="group" aria-label="${heading}"><h3>${heading}</h3>${groups.filter(group => group.kind === kind)
    .map(group => `<button type="button" data-more-filter="${group.id}" aria-pressed="${group.id === active}"><span>${esc(group.short)}</span><strong>${group.nodes.length}</strong></button>`).join('')}</div>`;
  return section('state', 'How settled answers are') + section('importance', 'Importance of open questions');
}

// The More filters button, its panel and Clear filter. `openFilter(id)` sets the one shared filter (null clears it);
// `focusList()` moves into the overview list. render(groups, filter) runs with every overview render.
export function moreFiltersPanel({ esc, openFilter, focusList }) {
  const button = document.querySelector('#more-filters'), panel = document.querySelector('#more-filters-panel'), clear = document.querySelector('#clear-filter');
  let groups = [], active = null, written = '';
  const draw = () => { const html = moreFiltersHtml(groups, { esc, active }); if (html !== written) { panel.innerHTML = html; written = html; } };
  const close = (focus = false) => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  button.addEventListener('click', () => {
    if (!panel.hidden) return close();
    draw(); panel.hidden = false; button.setAttribute('aria-expanded', 'true');
    (panel.querySelector('[aria-pressed="true"]') ?? panel.querySelector('button'))?.focus();
  });
  // Arrow Down from the active choice enters the list, as from a progress filter.
  button.addEventListener('keydown', event => { if (event.key === 'ArrowDown' && panel.hidden && isQuestionFilter(active)) { event.preventDefault(); focusList(); } });
  panel.addEventListener('click', event => {
    const choice = event.target.closest('[data-more-filter]'); if (!choice) return;
    close(); openFilter(choice.dataset.moreFilter === active ? null : choice.dataset.moreFilter); button.focus();
  });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } });
  document.addEventListener('click', event => { if (!panel.hidden && !panel.contains(event.target) && !button.contains(event.target)) close(); });
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
