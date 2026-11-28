// Claims linked to evidence (C2). A result may list its key claims, each with up to three passages of its own
// sources that support it, or none ("support unknown"). The app records the agent's link; it never verifies it.
import { textField, recordId, citedSource } from './fields.mjs';
import { markdownText, sourceTitle } from '../assets/workspace-view.js';

const maxClaims = 12;

// Returns { claims } to keep on the result, or {} when it has none (left out, or an empty list). `checked` is the
// rest of the normalized result: a claim may cite only its sources, whose URLs must then be distinct. `fail(message)`
// throws the caller's error.
export function normalizeClaims(result, checked, fail) {
  const need = (condition, message) => { if (!condition) fail(message); };
  const { claims } = result;
  if (claims === undefined) return {};
  need(Array.isArray(claims) && claims.length <= maxClaims, `claims must be a list of at most ${maxClaims} claims.`);
  if (!claims.length) return {};
  const urls = new Set(checked.sources.map(source => source.url));
  need(urls.size === checked.sources.length, 'With claims, each source URL must be distinct, so every claim points to one source.');
  const ids = new Set();
  return { claims: claims.map((claim, index) => {
    const label = `Claim ${index + 1}`;
    need(claim && typeof claim === 'object' && !Array.isArray(claim), `${label} must be an object.`);
    recordId(claim.id, label, 'Claim', ids, fail);
    const support = claim.support ?? [];
    need(Array.isArray(support) && support.length <= 3, `${label}: support must be a list of at most 3 passages.`);
    return { id: claim.id, text: textField(claim.text, `${label} text`, 500, fail), support: support.map(item => {
      need(item && typeof item === 'object' && !Array.isArray(item), `${label}: each support entry must be an object.`);
      const source = citedSource(item.source, urls, label, fail);
      const locator = textField(item.locator, `${label} locator`, 120, fail, { optional: true });
      return { source, passage: textField(item.passage, `${label} passage`, 400, fail), ...(locator ? { locator } : {}) };
    }) };
  }) };
}

// One claim as lines, named by its id so an agent can resend it. Section reads keep the text as saved; node Markdown
// passes `format: markdownText`.
export function claimRecord(node, claim, format = text => text) {
  const named = `(${format(claim.id)}) ${format(claim.text)}`;
  if (!claim.support?.length) return [`- ${named} [support unknown]`];
  return claim.support.map((item, index) => `${index ? '  - also' : '-'} ${index ? '' : `${named} — `}[${format(sourceTitle(node, item.source))}](${item.source}): “${format(item.passage)}”${item.locator ? ` (${format(item.locator)})` : ''}`);
}
// Node Markdown: the Key claims section.
export function claimLines(node) {
  return ['## Key claims', '', '_The agent\'s reading of its sources, not a verification._', '', ...node.claims.flatMap(claim => claimRecord(node, claim, markdownText))];
}
