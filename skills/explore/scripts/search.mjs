import { createHash } from 'node:crypto';

// Search every saved map's content (I1): map titles and original ideas, and each idea's title, premise, summary,
// findings, questions, answers and sources. A case-insensitive substring match, like `read --query`. Each map
// returns at most three distinct matches with short excerpts; pages carry a revision so a resumed read never mixes
// states. A map that cannot be read is reported and never stops the search.
class SearchProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new SearchProblem(message, status); };
const excerptLength = 160, perMap = 3;
// One revision for a list of maps, shared by `maps` and the content search.
export const catalogRevision = maps => createHash('sha256').update(JSON.stringify(maps.map(m => [m.id, m.revision ?? null, m.updatedAt ?? null]))).digest('hex').slice(0, 16);

const excerpt = (text, at) => { const start = Math.max(0, Math.min(at - 40, text.length - excerptLength)); return text.slice(start, start + excerptLength).replace(/\s+/g, ' ').trim(); };
// Every searchable text of a map, as { nodeId, field, text }.
function texts(map) {
  const out = [{ nodeId: map.rootId, field: 'map title', text: map.title }, { nodeId: map.rootId, field: 'original idea', text: map.originalIdea || '' }];
  for (const node of map.nodes) {
    const premise = node.prompt || node.body;
    out.push({ nodeId: node.id, field: 'title', text: node.title }, { nodeId: node.id, field: 'premise', text: premise }, { nodeId: node.id, field: 'summary', text: node.summary });
    if (node.body && node.body !== premise) out.push({ nodeId: node.id, field: 'findings', text: node.body });
    for (const question of node.questions) out.push({ nodeId: node.id, field: 'question', text: question.text }, ...(question.answer ? [{ nodeId: node.id, field: 'answer', text: question.answer }] : []));
    for (const source of node.sources) out.push({ nodeId: node.id, field: 'source', text: `${source.title}. ${source.note}` });
  }
  return out;
}

export async function searchMaps(store, { query, offset = 0, limit = 20, revision } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  need(needle.length >= 2 && needle.length <= 200, 'Search for 2 to 200 characters.');
  offset = Number(offset); limit = Number(limit);
  need(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 40, 'Use a non-negative offset and a limit from 1 to 40.');
  const all = await store.eachMap();
  const current = catalogRevision(all.map(({ id, map }) => ({ id, revision: map?.revision, updatedAt: map?.updatedAt })));
  if (offset > 0) need(revision !== undefined && revision !== null, 'Pass the returned revision when continuing a search.', 409);
  if (revision !== undefined && revision !== null) need(String(revision) === current, 'The maps changed. Search again from the start.', 409);
  const hits = [], errors = [];
  for (const { id, map, error } of all) {
    if (!map) { errors.push({ mapId: id, problem: error.code || 'unreadable' }); continue; }
    // The same sentence can be a new idea's premise, summary and original idea: what each idea shows counts once.
    const seen = new Set(), matches = [];
    for (const { nodeId, field, text } of texts(map)) {
      const value = String(text ?? ''), at = value.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const shown = excerpt(value, at), key = `${nodeId} ${shown.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key); matches.push({ nodeId, field, excerpt: shown });
    }
    if (matches.length) hits.push({ mapId: map.id, mapTitle: map.title, ...(map.library?.archived ? { archived: true } : {}), matches: matches.slice(0, perMap), more: Math.max(0, matches.length - perMap) });
  }
  const page = hits.slice(offset, offset + limit);
  return { revision: current, total: hits.length, offset, nextOffset: offset + page.length < hits.length ? offset + page.length : null, hits: page, ...(errors.length ? { errors } : {}) };
}
