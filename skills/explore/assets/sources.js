// The map-wide source library (K10): every source cited anywhere on the map, grouped by URL, with the ideas that cite
// it and how (supports, challenges or gives context), and a flag when it backs ideas that contradict each other.
// Read-only and computed in the browser: it never fetches a source and never changes the map.
export const stanceWords = { supports: 'Supports', challenges: 'Challenges', context: 'Context' };
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isInvestigation = job => !job.type || job.type === 'investigate';

// One key per page: the fragment and a trailing slash (except on the root path) are dropped; the query is kept.
export function normalizeSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch { return String(value ?? ''); }
}
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

// The library: [{ url, href, host, titles, citations: [{ nodeId, title, stance, note, earlier, claims }], ideas,
// counts: { supports, challenges, context, unrecorded }, flags: [{ nodeIds, text }], forAndAgainst }], flagged first,
// then by the number of citing ideas, then by title. Earlier results are listed, labelled, and never flag.
export function sourceLibrary(map) {
  const entries = new Map(), byId = new Map(map.nodes.map(node => [node.id, node]));
  const add = (raw, citation) => {
    const key = normalizeSourceUrl(raw.url);
    if (!entries.has(key)) entries.set(key, { url: key, href: raw.url, host: hostOf(key), titles: [], citations: [] });
    const entry = entries.get(key);
    if (raw.title && !entry.titles.includes(raw.title)) entry.titles.push(raw.title);
    entry.citations.push({ ...citation, stance: Object.hasOwn(stanceWords, raw.stance ?? '') ? raw.stance : null, note: raw.note ?? '' });
  };
  // The claims (C2) on an idea that rest on this source.
  const claimsCiting = (node, url) => (node.claims ?? []).filter(claim => claim.support?.some(item => normalizeSourceUrl(item.source) === url)).map(claim => claim.text);
  for (const node of map.nodes) for (const raw of node.sources ?? []) add(raw, { nodeId: node.id, title: node.title, earlier: false, claims: claimsCiting(node, normalizeSourceUrl(raw.url)) });
  // Earlier investigation results keep their sources on the job; the current result's are the idea's own.
  for (const job of map.jobs ?? []) {
    const node = byId.get(job.nodeId);
    if (!node || !isInvestigation(job) || !job.result?.sources?.length) continue;
    if (!job.stale && job.result.summary === node.summary && job.result.body === node.body) continue;
    for (const raw of job.result.sources) add(raw, { nodeId: node.id, title: node.title, earlier: true, claims: [] });
  }
  const pairs = new Map();
  for (const edge of map.edges ?? []) if (edge.type === 'contradicts' && edge.from !== edge.to) { const ids = [edge.from, edge.to].sort(); pairs.set(ids.join(' '), ids); }
  return [...entries.values()].map(entry => {
    const current = entry.citations.filter(citation => !citation.earlier);
    const counts = { supports: 0, challenges: 0, context: 0, unrecorded: 0 };
    for (const citation of current) counts[citation.stance ?? 'unrecorded']++;
    const citing = id => current.filter(citation => citation.nodeId === id);
    // Both ideas cite it, and neither cites it as a challenge: it backs findings that contradict each other.
    const flags = [...pairs.values()].filter(ids => ids.every(id => citing(id).length && !citing(id).some(citation => citation.stance === 'challenges')))
      .map(nodeIds => ({ nodeIds, text: 'Cited in support of findings that contradict each other' }));
    return { ...entry, ideas: new Set(current.map(citation => citation.nodeId)).size, counts, flags, forAndAgainst: counts.supports > 0 && counts.challenges > 0 };
  }).sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0) || b.ideas - a.ideas || (a.titles[0] ?? a.url).localeCompare(b.titles[0] ?? b.url));
}

// The dialog's list. `query` filters by title, site, address, citing idea or note; `flaggedOnly` keeps flagged sources.
export function sourcesHtml(entries, { esc, query = '', flaggedOnly = false, historic = false }) {
  const head = historic ? '<p class="form-note">At this growth step: the ideas shown, with today\'s sources. This reflects today\'s content.</p>' : '';
  if (!entries.length) return `${head}<p class="form-note">No sources are cited on this map yet.</p>`;
  const words = query.trim().toLowerCase();
  const matches = entry => !words || [entry.url, entry.host, ...entry.titles, ...entry.citations.flatMap(citation => [citation.title, citation.note])].some(text => String(text).toLowerCase().includes(words));
  const shown = entries.filter(entry => (!flaggedOnly || entry.flags.length) && matches(entry));
  if (!shown.length) return `${head}<p class="form-note">No sources match.</p>`;
  const titleOf = (entry, id) => entry.citations.find(citation => citation.nodeId === id)?.title ?? id;
  const item = entry => {
    const counts = [['supports', 'supports'], ['challenges', 'challenges'], ['context', 'context'], ['unrecorded', 'stance not recorded']].filter(([key]) => entry.counts[key]).map(([key, word]) => `${entry.counts[key]} ${word}`);
    const flags = entry.flags.map(flag => `<p class="source-flag">${esc(flag.text)}: ${esc(titleOf(entry, flag.nodeIds[0]))} and ${esc(titleOf(entry, flag.nodeIds[1]))}</p>`).join('');
    const citations = entry.citations.map(citation => `<li><button type="button" class="relationship" data-focus-node="${esc(citation.nodeId)}">${esc(citation.title)}</button><small>${citation.stance ? stanceWords[citation.stance] : 'Stance not recorded'}${citation.earlier ? ' · earlier result' : ''}</small>`
      + `${citation.note ? `<p>${esc(citation.note)}</p>` : ''}${citation.claims.map(claim => `<p class="source-claim">Claim: ${esc(claim)}</p>`).join('')}</li>`).join('');
    return `<article class="source-entry"><h3><a href="${esc(entry.href)}" target="_blank" rel="noreferrer">${esc(entry.titles[0] ?? entry.url)}</a></h3>`
      + `<p class="source-meta">${esc([entry.host, count(entry.ideas, 'idea', 'ideas'), ...counts].filter(Boolean).join(' · '))}</p>${flags}`
      + `${entry.forAndAgainst ? '<p class="source-note">Cited both for and against</p>' : ''}<ul class="source-citations">${citations}</ul></article>`;
  };
  return head + shown.map(item).join('');
}

// The source library dialog, opened from Map tools. Choosing a citing idea closes it and focuses that idea.
// `map()` is the map shown (a growth step in history); `historic()` says whether it is history.
export function sourcesDialog({ esc, map, historic, focusNode }) {
  const $ = selector => document.querySelector(selector), dialog = $('#sources-dialog'), body = $('#sources-body'), filter = $('#sources-filter'), flagged = $('#sources-flagged');
  let entries = [];
  const draw = () => { body.innerHTML = sourcesHtml(entries, { esc, query: filter.value, flaggedOnly: flagged.checked, historic: historic() }); };
  $('#sources-open').addEventListener('click', () => {
    const open = map(); if (!open) return;
    entries = sourceLibrary(open);
    const flaggedCount = entries.filter(entry => entry.flags.length).length;
    $('#sources-summary').textContent = `${count(entries.length, 'source', 'sources')} cited across the map${flaggedCount ? ` · ${flaggedCount} flagged` : ''}. Your agent's reading of its sources, not a verification.`;
    filter.value = ''; flagged.checked = false; draw();
    $('#tools-dialog').close(); dialog.showModal(); filter.focus();
  });
  filter.addEventListener('input', draw);
  flagged.addEventListener('change', draw);
  body.addEventListener('click', event => {
    const idea = event.target.closest('[data-focus-node]'); if (!idea) return;
    dialog.close(); focusNode(idea.dataset.focusNode);
  });
}
