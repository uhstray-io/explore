// The map rail (I1): maps in the Store's order (pinned first), each with one ⋯ menu holding Pin and Archive.
const unreadableNote = 'Cannot be opened';
// Which maps a list shows: `exclude` hides archived maps except one with work waiting, `only` shows just archived
// ones, `include` shows all. A map that cannot be read always shows outside `only`, so it gets attention.
export function listedMaps(maps, archived = 'exclude') {
  if (archived === 'include') return maps;
  if (archived === 'only') return maps.filter(map => map.archived);
  return maps.filter(map => map.unreadable || !map.archived || map.busy);
}
export function railHtml(maps, { esc, currentId, showArchived, unreadableLabel = () => unreadableNote }) {
  const shown = listedMaps(maps, showArchived ? 'only' : 'exclude');
  if (!shown.length) return `<p class="empty-list">${showArchived ? 'No archived maps.' : 'Your ideas will find a home here.'}</p>`;
  return shown.map(map => {
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

// The rail in the page: list, Archived toggle, Pin and Archive, and search. `act(mapId, input)` runs an action on any
// map through the app's own queue and resolves true when it saved.
export function railPanel({ esc, maps, currentId, unreadableLabel, act, api, openReference }) {
  const $ = selector => document.querySelector(selector), list = $('#map-list'), box = $('#map-search-results'), search = $('#map-search');
  let showArchived = false, timer = null;
  function render() {
    if (list.querySelector('.item-menu:not([hidden])')) return; // A poll never closes a menu the user has open.
    const html = railHtml(maps(), { esc, currentId: currentId(), showArchived, unreadableLabel });
    if (list.innerHTML !== html) list.innerHTML = html;
  }
  $('#archived-toggle').addEventListener('click', event => { showArchived = !showArchived; event.currentTarget.setAttribute('aria-pressed', String(showArchived)); render(); });
  list.addEventListener('click', async event => {
    const button = event.target.closest('[data-map-pin], [data-map-archive]'); if (!button) return;
    event.stopPropagation(); button.closest('.item-menu').hidden = true;
    await act(button.dataset.mapPin || button.dataset.mapArchive, button.dataset.mapPin ? { type: 'pin', pinned: button.dataset.pinned === 'true' } : { type: 'archive', archived: button.dataset.archived === 'true' });
    render();
  });
  const close = () => { box.hidden = true; box.innerHTML = ''; };
  search.addEventListener('input', () => {
    clearTimeout(timer); const query = search.value.trim();
    if (query.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      let html;
      try { html = searchResultsHtml(await api(`/search?query=${encodeURIComponent(query)}`), { esc }); } catch (error) { html = `<p class="empty-list">${esc(error.message)}</p>`; }
      if (search.value.trim() !== query) return; // A reply for an older query is dropped.
      box.innerHTML = html; box.hidden = false;
    }, 300);
  });
  box.addEventListener('click', event => {
    const hit = event.target.closest('[data-open-reference]'); if (!hit) return;
    event.stopPropagation(); const [mapId, nodeId] = hit.dataset.openReference.split('/');
    search.value = ''; close(); openReference({ mapId, nodeId });
  });
  return { render };
}
