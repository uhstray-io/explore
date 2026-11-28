// Claims linked to evidence (C2): a result's key statements, each pointing to the passage of a source it consulted,
// or saying its support is unknown. A linked passage is the agent's reading of a source, never a verification.
export const reasoningLabel = 'Reasoning — no sources consulted';
// A finding with no sources rests on reasoning. Derived, never supplied by the agent; true of older ideas too.
export const reasoningOnly = node => !!node.hasFindings && !node.sources?.length;
export const basisHtml = node => (reasoningOnly(node) ? `<p class="basis-label">${reasoningLabel}</p>` : '');

// The inspector's Key claims section, above Sources & evidence.
export function claimsHtml(node, { esc }) {
  if (!node.claims?.length) return '';
  const titleOf = url => node.sources?.find(source => source.url === url)?.title ?? url;
  const support = claim => (claim.support?.length
    ? claim.support.map(item => `<details class="claim-support"><summary>Supported by ${esc(titleOf(item.source))}</summary><blockquote>${esc(item.passage)}</blockquote>${item.locator ? `<p class="claim-locator">${esc(item.locator)}</p>` : ''}<a href="${esc(item.source)}" target="_blank" rel="noreferrer">Open the source</a></details>`).join('')
    : '<p class="claim-unknown">Support unknown</p>');
  return `<h3 class="section-label">Key claims</h3><p class="form-note">Your agent's reading of its sources, not a verification.</p>${node.claims.map(claim => `<div class="claim"><p>${esc(claim.text)}</p>${support(claim)}</div>`).join('')}`;
}
