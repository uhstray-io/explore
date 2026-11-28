// Claims linked to evidence (C2): a result's key statements, each pointing to the passage of a source it consulted,
// or saying its support is unknown. A linked passage is the agent's reading of a source, never a verification.
import { sourceTitle } from './workspace-view.js';

export const reasoningLabel = 'Reasoning — no sources consulted';
// What an idea's findings rest on: 'sources', or 'reasoning' when it consulted none; null for a premise, which has no
// findings. Derived, never supplied by the agent, so older ideas are labelled too.
export const findingsBasis = (node, hasFindings) => (!hasFindings ? null : node.sources?.length ? 'sources' : 'reasoning');
// How many of its claims have no linked passage.
export const unsupportedClaimCount = node => (node.claims || []).filter(claim => !claim.support?.length).length;
// The brief's note after a findings entry ({ basis, unsupportedClaims }).
export const basisNote = ({ basis, unsupportedClaims }) => `${basis === 'reasoning' ? ' — reasoning only' : ''}${unsupportedClaims ? ` — ${unsupportedClaims} ${unsupportedClaims === 1 ? 'claim' : 'claims'} with support unknown` : ''}`;
// The inspector's label under the summary. The view carries `hasFindings`.
export const basisHtml = node => (findingsBasis(node, node.hasFindings) === 'reasoning' ? `<p class="basis-label">${reasoningLabel}</p>` : '');

// The inspector's Key claims section, above Sources & evidence.
export function claimsHtml(node, { esc }) {
  if (!node.claims?.length) return '';
  const support = claim => (claim.support?.length
    ? claim.support.map(item => `<details class="claim-support"><summary>Supported by ${esc(sourceTitle(node, item.source))}</summary><blockquote>${esc(item.passage)}</blockquote>${item.locator ? `<p class="claim-locator">${esc(item.locator)}</p>` : ''}<a href="${esc(item.source)}" target="_blank" rel="noreferrer">Open the source</a></details>`).join('')
    : '<p class="claim-unknown">Support unknown</p>');
  return `<h3 class="section-label">Key claims</h3><p class="form-note">Your agent's reading of its sources, not a verification.</p><div class="claims">${node.claims.map(claim => `<div class="claim"><p>${esc(claim.text)}</p>${support(claim)}</div>`).join('')}</div>`;
}
