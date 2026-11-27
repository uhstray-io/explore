// The map rail (I1): pinned maps first, each with one ⋯ menu holding Pin and Archive; archived maps appear only
// in the Archived view, except one with work waiting, which is never hidden.
const unreadableNote = 'Cannot be opened';
export function railHtml(maps, { esc, currentId, showArchived, unreadableLabel = () => unreadableNote }) {
  const shown = maps.filter(map => map.unreadable || (showArchived ? map.archived : !map.archived || map.busy));
  if (!shown.length) return `<p class="empty-list">${showArchived ? 'No archived maps.' : 'Your ideas will find a home here.'}</p>`;
  const sorted = [...shown].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  return sorted.map(map => {
    if (map.unreadable) return `<div class="rail-item"><button class="map-link unreadable" data-map="${esc(map.id)}"><span class="map-icon" aria-hidden="true">⌘</span><span><strong>${esc(map.id)}</strong><small>${esc(unreadableLabel(map.problem))}</small></span></button></div>`;
    const current = currentId === map.id, id = esc(map.id);
    const details = [map.demo ? 'Example map' : `${map.count} ${map.count === 1 ? 'idea' : 'ideas'}`, map.pending ? `${map.pending} queued` : '', map.pinned ? 'Pinned' : '', map.archived ? 'Archived' : ''].filter(Boolean).join(' · ');
    const item = (label, attributes) => `<button type="button" role="menuitem" tabindex="-1" ${attributes}>${label}</button>`;
    const menu = `<div class="item-more-wrap"><button type="button" class="item-more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-rail-${id}" data-menu="rail-${id}" aria-label="More for ${esc(map.title)}">⋯</button><div class="item-menu" role="menu" id="menu-rail-${id}" aria-label="More for ${esc(map.title)}" hidden>${item(map.pinned ? 'Unpin' : 'Pin', `data-map-pin="${id}" data-pinned="${!map.pinned}"`)}${item(map.archived ? 'Unarchive' : 'Archive', `data-map-archive="${id}" data-archived="${!map.archived}"`)}</div></div>`;
    return `<div class="rail-item"><button class="map-link ${current ? 'current' : ''}" data-map="${id}" ${current ? 'aria-current="page"' : ''}><span class="map-icon" aria-hidden="true">${map.pinned ? '★' : '⌘'}</span><span><strong>${esc(map.title)}</strong><small>${details}</small></span></button>${menu}</div>`;
  }).join('');
}
// Search results across maps: each match opens its map at the idea.
export function searchResultsHtml(result, { esc }) {
  if (!result.hits.length) return '<p class="empty-list">Nothing found.</p>';
  return result.hits.map(hit => `<div class="search-hit"><strong>${esc(hit.mapTitle)}${hit.archived ? ' · Archived' : ''}</strong>${hit.matches.map(match => `<button type="button" class="text-button" data-open-reference="${esc(hit.mapId)}/${esc(match.nodeId)}"><small>${esc(match.field)}</small> ${esc(match.excerpt)}</button>`).join('')}${hit.more ? `<small>and ${hit.more} more in this map</small>` : ''}</div>`).join('')
    + (result.nextOffset !== null ? '<p class="empty-list">More maps match. Search with more words to narrow it down.</p>' : '');
}
