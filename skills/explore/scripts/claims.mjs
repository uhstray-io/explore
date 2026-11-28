// Claims linked to evidence (C2). A result may list its key claims, each with up to three passages of its own
// sources that support it, or none ("support unknown"). The app records the agent's link; it never verifies it.
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { reasoningLabel } from '../assets/claims.js';

const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// Returns { claims } to keep on the result, or {} when it has none. `checked` is the rest of the normalized result:
// a claim may cite only its sources, whose URLs must then be distinct. `fail(message)` throws the caller's error.
export function normalizeClaims(result, checked, fail) {
  const need = (condition, message) => { if (!condition) fail(message); };
  const { claims } = result;
  if (claims === undefined) return {};
  need(Array.isArray(claims) && claims.length >= 1 && claims.length <= 12, 'Give 1–12 claims, or leave claims out.');
  const urls = checked.sources.map(source => source.url);
  need(new Set(urls).size === urls.length, 'With claims, each source URL must be distinct, so every claim points to one source.');
  const ids = new Set();
  return { claims: claims.map((claim, index) => {
    const label = `Claim ${index + 1}`;
    need(claim && typeof claim === 'object' && !Array.isArray(claim), `${label} must be an object.`);
    need(typeof claim.id === 'string' && idPattern.test(claim.id), `${label} needs an identifier that starts with a letter (letters, digits, _ or -, at most 32).`);
    need(!ids.has(claim.id), 'Claim identifiers must be unique.'); ids.add(claim.id);
    const support = claim.support ?? [];
    need(Array.isArray(support) && support.length <= 3, `${label}: support must be a list of at most 3 passages.`);
    return { id: claim.id, text: textField(claim.text, `${label} text`, 500, fail), support: support.map(item => {
      need(item && typeof item === 'object' && !Array.isArray(item), `${label}: each support entry must be an object.`);
      need(typeof item.source === 'string' && urls.includes(item.source), `${label} cites a source that is not in this result's sources.`);
      const locator = textField(item.locator, `${label} locator`, 120, fail, { optional: true });
      return { source: item.source, passage: textField(item.passage, `${label} passage`, 400, fail), ...(locator ? { locator } : {}) };
    }) };
  }) };
}

// One claim as lines. Section reads keep the text as saved; node Markdown passes `format: markdownText`.
export function claimRecord(node, claim, format = text => text) {
  const titleOf = url => node.sources?.find(source => source.url === url)?.title ?? url;
  if (!claim.support?.length) return [`- ${format(claim.text)} [support unknown]`];
  return claim.support.map((item, index) => `${index ? '  - also' : '-'} ${index ? '' : `${format(claim.text)} — `}[${format(titleOf(item.source))}](${item.source}): “${format(item.passage)}”${item.locator ? ` (${format(item.locator)})` : ''}`);
}
// Node Markdown: the Key claims section, and the label for findings that rest on reasoning alone.
export function claimLines(node, { findings }) {
  return [...(findings && !node.sources?.length ? ['', `_${reasoningLabel}._`] : []),
    ...(node.claims?.length ? ['', '## Key claims', '', '_The agent\'s reading of its sources, not a verification._', '', ...node.claims.flatMap(claim => claimRecord(node, claim, markdownText))] : [])];
}
