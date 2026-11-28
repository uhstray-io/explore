import { isEarlierResult } from './workspace-view.js';
import { questionJobs, RESEARCH } from './questions.js';

// The map-wide source library (K10): every source cited on the map, grouped by page, with the ideas that cite it and
// how (supports, challenges or gives context), and a flag when it backs ideas that contradict each other. Pure and
// read-only: it never fetches a source and never changes the map. The dialog is sources-dialog.js.
export const stanceWords = { supports: 'Supports', challenges: 'Challenges', context: 'Context' };
// A source's recorded stance, or null: none recorded, or a value that is not one (a hand edit the validator reports).
export const stanceOf = source => (typeof source?.stance === 'string' && Object.hasOwn(stanceWords, source.stance) ? source.stance : null);
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One key per page: the fragment, an empty query and a trailing slash (except on the root path) are dropped.
export function normalizeSourceUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    if (!url.search) url.search = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch { return String(value ?? ''); }
}
const hostOf = url => { try { return new URL(url).host; } catch { return ''; } };

// Where a citation comes from: the idea's current result, an earlier investigation result (the one Node Markdown lists
// as earlier), or Help me answer research on one of its questions. Only the first counts, by stance, or flags.
const order = { idea: 0, help: 1, earlier: 2 };
const fromWords = { earlier: 'earlier result', help: 'Help me answer' };

// The library: [{ url, href, host, titles, citations, ideas, earlier, help, counts: { supports, challenges, context,
// unrecorded }, flags: [{ nodeIds, text }], forAndAgainst }], flagged first, then by the number of citing ideas, then
// by title. Each citation is { nodeId, title, from, stance, note, claims, question? }.
export function sourceLibrary(map) {
  const entries = new Map();
  const add = (raw, citation) => {
    const key = normalizeSourceUrl(raw.url);
    if (!entries.has(key)) entries.set(key, { url: key, href: raw.url, host: hostOf(key), titles: [], citations: [] });
    const entry = entries.get(key);
    if (raw.title && !entry.titles.includes(raw.title)) entry.titles.push(raw.title);
    entry.citations.push({ claims: [], ...citation, stance: citation.from === 'help' ? null : stanceOf(raw), note: raw.note ?? '' });
  };
  // The claims (C2) on an idea that rest on this source.
  const claimsCiting = (node, url) => (node.claims ?? []).filter(claim => claim.support?.some(item => normalizeSourceUrl(item.source) === url)).map(claim => claim.text);
  const jobsOf = new Map();
  for (const job of map.jobs ?? []) { if (!jobsOf.has(job.nodeId)) jobsOf.set(job.nodeId, []); jobsOf.get(job.nodeId).push(job); }
  for (const node of map.nodes) {
    const cites = { nodeId: node.id, title: node.title };
    for (const raw of node.sources ?? []) add(raw, { ...cites, from: 'idea', claims: claimsCiting(node, normalizeSourceUrl(raw.url)) });
    for (const job of jobsOf.get(node.id) ?? []) if (isEarlierResult(job, node)) for (const raw of job.result.sources ?? []) add(raw, { ...cites, from: 'earlier' });
    for (const question of node.questions ?? []) for (const raw of questionJobs(map.jobs, RESEARCH, question.id).latest?.result.sources ?? []) add(raw, { ...cites, from: 'help', question: question.text });
  }
  const pairs = new Map();
  for (const edge of map.edges ?? []) if (edge.type === 'contradicts' && edge.from !== edge.to) { const ids = [edge.from, edge.to].sort(); pairs.set(ids.join(' '), ids); }
  return [...entries.values()].map(entry => {
    const citations = entry.citations.sort((a, b) => order[a.from] - order[b.from]), current = citations.filter(citation => citation.from === 'idea');
    const counts = { supports: 0, challenges: 0, context: 0, unrecorded: 0 };
    for (const citation of current) counts[citation.stance ?? 'unrecorded']++;
    const citing = stance => new Set(current.filter(citation => !stance || citation.stance === stance).map(citation => citation.nodeId));
    const challengers = citing('challenges'), supporters = citing('supports');
    // Ideas that cite it and never as a challenge back it. Two of them linked as contradicting each other: a flag.
    const backers = new Set([...citing()].filter(id => !challengers.has(id)));
    const flags = [...pairs.values()].filter(ids => ids.every(id => backers.has(id))).map(nodeIds => ({ nodeIds, text: 'Cited in support of findings that contradict each other' }));
    return { ...entry, citations, ideas: citing().size, earlier: citations.filter(c => c.from === 'earlier').length, help: citations.filter(c => c.from === 'help').length, counts, flags,
      forAndAgainst: [...supporters].some(a => [...challengers].some(b => b !== a)) }; // In one place and against in another.
  }).sort((a, b) => Number(b.flags.length > 0) - Number(a.flags.length > 0) || b.ideas - a.ideas || (a.titles[0] ?? a.url).localeCompare(b.titles[0] ?? b.url));
}

// The sources a filter keeps: `query` matches a title, the site or address, a citing idea, a note or a question;
// `flaggedOnly` keeps flagged sources.
export function matchingSources(entries, { query = '', flaggedOnly = false }) {
  const words = query.trim().toLowerCase();
  const matches = entry => !words || [entry.url, entry.host, ...entry.titles, ...entry.citations.flatMap(citation => [citation.title, citation.note, citation.question ?? ''])].some(text => String(text).toLowerCase().includes(words));
  return entries.filter(entry => (!flaggedOnly || entry.flags.length) && matches(entry));
}

// The dialog's list. `note` is the read-only note for growth history or a saved version, '' on the live map.
export function sourcesHtml(entries, { esc, query = '', flaggedOnly = false, note = '' }) {
  const head = note ? `<p class="form-note">${esc(note)}</p>` : '';
  if (!entries.length) return `${head}<p class="form-note">${note ? 'No sources are cited on these ideas.' : 'No sources are cited on this map yet.'}</p>`;
  const shown = matchingSources(entries, { query, flaggedOnly });
  if (!shown.length) return `${head}<p class="form-note">No sources match.</p>`;
  const titleOf = (entry, id) => entry.citations.find(citation => citation.nodeId === id)?.title ?? id;
  const item = entry => {
    const counts = [['supports', 'supports'], ['challenges', 'challenges'], ['context', 'context'], ['unrecorded', 'stance not recorded']].filter(([key]) => entry.counts[key]).map(([key, word]) => `${entry.counts[key]} ${word}`);
    const meta = [entry.host, entry.ideas ? count(entry.ideas, 'idea', 'ideas') : '', entry.earlier ? count(entry.earlier, 'earlier result', 'earlier results') : '', entry.help ? `${entry.help} in Help me answer` : '', ...counts];
    const flags = entry.flags.map(flag => `<p class="source-flag">${esc(flag.text)}: ${esc(titleOf(entry, flag.nodeIds[0]))} and ${esc(titleOf(entry, flag.nodeIds[1]))}</p>`).join('');
    const citations = entry.citations.map(citation => {
      const label = [citation.stance ? stanceWords[citation.stance] : citation.from === 'help' ? '' : 'Stance not recorded', fromWords[citation.from] ?? ''].filter(Boolean).join(' · ');
      return `<li><button type="button" class="relationship" data-focus-node="${esc(citation.nodeId)}">${esc(label)}<strong>${esc(citation.title)}</strong></button>`
        + `${citation.question ? `<p class="source-claim">Question: ${esc(citation.question)}</p>` : ''}${citation.note ? `<p>${esc(citation.note)}</p>` : ''}${citation.claims.map(claim => `<p class="source-claim">Claim: ${esc(claim)}</p>`).join('')}</li>`;
    }).join('');
    return `<article class="source-entry"><h3><a href="${esc(entry.href)}" target="_blank" rel="noopener noreferrer">${esc(entry.titles[0] ?? entry.url)} <span aria-hidden="true">↗</span></a></h3>`
      + `<p class="source-meta">${esc(meta.filter(Boolean).join(' · '))}</p>${flags}${entry.forAndAgainst ? '<p class="source-note">Cited both for and against</p>' : ''}<ul class="source-citations">${citations}</ul></article>`;
  };
  return head + shown.map(item).join('');
}
