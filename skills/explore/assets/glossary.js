import { comparableText } from './workspace-view.js';

// Map glossary (K9): the one reading of map.glossary, shared by the Store and the dialog. Entries that are not
// well formed are skipped, as map validation reports them.
const isEntry = entry => !!entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.term === 'string'
  && typeof entry.definition === 'string' && (entry.status === 'agreed' || entry.status === 'proposed');
export const glossaryOf = map => (Array.isArray(map?.glossary) ? map.glossary.filter(isEntry) : []);
export const agreedTerms = map => glossaryOf(map).filter(entry => entry.status === 'agreed');
export const proposedTerms = map => glossaryOf(map).filter(entry => entry.status === 'proposed');
export const sameTerm = (a, b) => comparableText(a) === comparableText(b);
// The agreed term a proposal would change if accepted: the one with the same term, ignoring case. `replaces` on a
// proposal only records which term it was made against.
export const replacedTerm = (map, proposal) => agreedTerms(map).find(entry => sameTerm(entry.term, proposal.term)) ?? null;
