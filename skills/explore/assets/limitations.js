// Conflicts and evidence gaps (C3): records a result keeps when sources disagree or evidence could not be found.
// Each says what it affects and a next step. They are the agent's account of what is unresolved, never a
// conclusion, and an idea without them may simply predate them, so nothing ever says "none found".
export const limitationKinds = { conflict: 'Sources disagree', 'missing-evidence': 'Evidence not found' };
export const maxLimitations = 8;

const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);
// What a record affects: the titles of the options it names, or the whole branch.
export function limitationScope(node, record) {
  return record.optionIds?.length ? record.optionIds.map(id => node.options?.find(option => option.id === id)?.title ?? id).join(', ') : 'Whole branch';
}
// "Add as a direction": the existing suggest action, with the summary as title and the next step as body.
export const directionFrom = record => ({ title: clip(record.summary.replace(/\s+/g, ' ').trim(), 100), body: record.nextStep });
const added = (map, node, record) => { const { title } = directionFrom(record); return map.nodes.some(child => child.parentId === node.id && child.title === title); };
const recordId = (node, record, esc) => `limitation-${esc(node.id)}-${esc(record.id)}`;

// The inspector section. `map` is the map on screen; `live` is false while history is shown.
export function limitationsHtml(node, { esc, live, map }) {
  if (!node.limitations?.length) return '';
  const titleOf = url => node.sources?.find(source => source.url === url)?.title ?? url;
  const records = node.limitations.map(record => {
    const sources = record.sources?.length ? `<p class="limitation-sources">${record.sources.map(url => `<a class="evidence-link" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(titleOf(url))}</a>`).join('')}</p>` : '';
    const action = !live ? '' : added(map, node, record) ? '<p class="form-note">Added as a direction.</p>'
      : `<button type="button" class="secondary" data-limitation-direction="${esc(record.id)}" data-node-id="${esc(node.id)}">Add as a direction</button>`;
    return `<article class="limitation" id="${recordId(node, record, esc)}" tabindex="-1"><p class="limitation-kind">${limitationKinds[record.kind] ?? esc(record.kind)}${record.blocksRecommendation ? ' · <strong>Blocks a recommendation</strong>' : ''}</p>`
      + `<p>${esc(record.summary)}</p><p class="limitation-scope"><span>Affects:</span> ${esc(limitationScope(node, record))}</p>${sources}<p><strong>Next step:</strong> ${esc(record.nextStep)}</p>${action}</article>`;
  });
  return `<h3 class="section-label">Conflicts and evidence gaps</h3><p class="form-note">Your agent's account of what is still unresolved, not a conclusion.</p>${records.join('')}`;
}
// Under an option card: the records that affect it, each taking the user to the record.
export function optionLimitationNotes(node, option, esc) {
  return (node.limitations || []).filter(record => record.optionIds?.includes(option.id))
    .map(record => `<button type="button" class="text-button option-limitation" data-limitation-show="${esc(record.id)}" data-node-id="${esc(node.id)}">${limitationKinds[record.kind] ?? esc(record.kind)}</button>`).join('');
}

// Add as a direction, and the option notes. Returns true when it handled the click.
export async function limitationClick(event, { state, act, toast }) {
  const show = event.target.closest('[data-limitation-show]');
  if (show) {
    const record = document.getElementById(`limitation-${show.dataset.nodeId}-${show.dataset.limitationShow}`);
    record?.scrollIntoView({ block: 'nearest' }); record?.focus({ preventScroll: true });
    return true;
  }
  const button = event.target.closest('[data-limitation-direction]');
  if (!button) return false;
  const node = state.map?.nodes.find(entry => entry.id === button.dataset.nodeId), record = node?.limitations?.find(entry => entry.id === button.dataset.limitationDirection);
  if (!record) return true;
  button.disabled = true;
  if (await act(node.id, 'suggest', directionFrom(record))) toast('Direction added. It stays inactive until you choose to explore it.');
  button.disabled = false;
  return true;
}
