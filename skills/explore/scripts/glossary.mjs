import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { glossaryOf, agreedTerms, proposedTerms, sameTerm, replacedTerm } from '../assets/glossary.js';

// Map glossary (K9): terms and definitions agreed during the exploration. The user adds and edits them; the agent
// may propose terms, which count only once the user accepts them. Agreed terms go to research packets so the agent
// keeps the user's vocabulary. Stored in map.glossary; editing it changes no idea, so nothing goes stale.
const limits = { term: 80, definition: 600, agreed: 100, perResult: 5, packetCharacters: 3000 };
class GlossaryProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = message => { throw new GlossaryProblem(message); };
const need = (condition, message, status) => { if (!condition) throw new GlossaryProblem(message, status); };
const now = () => new Date().toISOString();
const newTermId = () => `term-${randomUUID().slice(0, 8)}`;
const term = value => textField(value, 'Term', limits.term, fail);
const definition = value => textField(value, 'Definition', limits.definition, fail);
const find = (map, termId, status) => {
  const entry = glossaryOf(map).find(item => item.id === termId && item.status === status);
  need(entry, status === 'agreed' ? 'That glossary term no longer exists.' : 'That proposed term no longer exists.', 404);
  return entry;
};
const unique = (map, value, except = null) => need(!agreedTerms(map).some(entry => entry !== except && sameTerm(entry.term, value)), 'This term is already in the glossary.', 409);
const room = map => need(agreedTerms(map).length < limits.agreed, `The glossary holds at most ${limits.agreed} terms. Remove one to add another.`, 409);

export const glossaryActions = {
  // User-only. `term`, `definition`.
  'glossary-add': { target: 'map', apply: ({ map, input, store }) => {
    const entry = { term: term(input.term), definition: definition(input.definition) };
    unique(map, entry.term); room(map);
    const at = now();
    map.glossary = [...glossaryOf(map), { id: newTermId(), ...entry, status: 'agreed', origin: 'user', createdAt: at, updatedAt: at }];
    store.event(map, 'glossary-added', null, entry.term);
  } },
  // User-only. `termId`, and `term` and/or `definition`.
  'glossary-edit': { target: 'map', apply: ({ map, input, store }) => {
    const entry = find(map, input.termId, 'agreed');
    need(input.term !== undefined || input.definition !== undefined, 'Change the term or its definition.');
    const next = { term: input.term === undefined ? entry.term : term(input.term), definition: input.definition === undefined ? entry.definition : definition(input.definition) };
    unique(map, next.term, entry);
    Object.assign(entry, next, { updatedAt: now() });
    store.event(map, 'glossary-edited', null, entry.term);
  } },
  // A proposal for the same term stays: the user decides about it separately.
  'glossary-remove': { target: 'map', apply: ({ map, input, store }) => {
    const entry = find(map, input.termId, 'agreed');
    map.glossary = glossaryOf(map).filter(item => item !== entry);
    store.event(map, 'glossary-removed', null, entry.term);
  } },
  // `termId`, and optionally the user's own `definition`. A proposal for an agreed term changes that term's
  // definition; any other becomes a new agreed term.
  'glossary-accept': { target: 'map', apply: ({ map, input, store }) => {
    const proposal = find(map, input.termId, 'proposed');
    const chosen = input.definition === undefined ? proposal.definition : definition(input.definition);
    const target = replacedTerm(map, proposal);
    const rest = glossaryOf(map).filter(item => item !== proposal);
    if (target) Object.assign(target, { definition: chosen, updatedAt: now() });
    else {
      room(map);
      const { replaces, ...accepted } = proposal;
      rest.push({ ...accepted, definition: chosen, status: 'agreed', updatedAt: now() });
    }
    map.glossary = rest;
    store.event(map, 'glossary-accepted', null, (target ?? proposal).term);
  } },
  'glossary-dismiss': { target: 'map', apply: ({ map, input, store }) => {
    const proposal = find(map, input.termId, 'proposed');
    map.glossary = glossaryOf(map).filter(item => item !== proposal);
    store.event(map, 'glossary-dismissed', null, proposal.term);
  } },
};

// A result's optional `glossary`: at most 5 { term, definition }. Returns {} or { glossary }.
export function normalizeGlossaryProposals(result, fail) {
  if (result.glossary === undefined) return {};
  if (!Array.isArray(result.glossary) || result.glossary.length > limits.perResult) fail(`glossary must be a list of at most ${limits.perResult} terms.`);
  return { glossary: result.glossary.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('Each glossary entry must be an object.');
    return { term: textField(entry.term, 'Glossary term', limits.term, fail), definition: textField(entry.definition, 'Glossary definition', limits.definition, fail) };
  }) };
}
// Stores a current result's proposals. One identical to the agreed entry, or to a waiting proposal, is dropped; one
// for an agreed term records that term in `replaces`.
export function addProposals(map, proposals, { jobId, store }) {
  for (const { term: proposed, definition: meaning } of proposals ?? []) {
    const agreed = replacedTerm(map, { term: proposed });
    if (agreed?.definition === meaning) continue;
    if (proposedTerms(map).some(entry => sameTerm(entry.term, proposed) && entry.definition === meaning)) continue;
    const at = now();
    map.glossary = [...glossaryOf(map), { id: newTermId(), term: proposed, definition: meaning, status: 'proposed', origin: 'agent', ...(agreed ? { replaces: agreed.id } : {}), jobId, createdAt: at, updatedAt: at }];
    store.event(map, 'glossary-proposed', null, proposed);
  }
}

// Whether `text` uses `name` as a whole word ("ant" is not in "important"), ignoring case.
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, name) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
// Agreed terms for a packet, within `room` characters and never more than 3,000: the ones the idea's title, premise or
// findings use first, then alphabetical. Proposed terms never go. An investigation drops the rest first when over
// budget; typed work offers only the room its own content left.
export function glossaryForPacket(map, node = null, room = limits.packetCharacters) {
  const text = node ? `${node.title} ${node.prompt ?? ''} ${node.body ?? ''} ${node.summary ?? ''}` : '';
  const ranked = agreedTerms(map).map(({ term: name, definition: meaning }) => ({ entry: { term: name, definition: meaning }, unused: text && mentions(text, name) ? 0 : 1 }))
    .sort((a, b) => a.unused - b.unused || a.entry.term.localeCompare(b.entry.term));
  const glossary = [], cap = Math.min(room, limits.packetCharacters);
  let size = 2;
  for (const { entry } of ranked) {
    const next = JSON.stringify(entry).length + (glossary.length ? 1 : 0);
    if (size + next > cap) break;
    glossary.push(entry); size += next;
  }
  return { glossary, omittedGlossaryTerms: ranked.length - glossary.length };
}
export const glossaryUse = "Use the glossary's terms as defined.";
// What the glossary adds to a packet besides its terms: the field names, the omitted count and the sentence.
export const glossaryRoom = 100;
export const glossaryInstruction = `${glossaryUse} If you need a new term or a different meaning, propose it in \`glossary\`.`;

// The README's Glossary section: agreed terms only.
export function glossaryLines(map) {
  const agreed = agreedTerms(map);
  return agreed.length ? ['', '## Glossary', '', ...agreed.map(entry => `- **${markdownText(entry.term)}**: ${markdownText(entry.definition)}`)] : [];
}
