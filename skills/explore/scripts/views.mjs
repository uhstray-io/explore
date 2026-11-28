// The readable views of a map, as text: README.md, and one Markdown file per idea, committed with the map so anyone can
// read it without Explore. Generated from map.json, never edited by hand. Pure, so a map whose views cannot be generated
// is refused before anything is written (an import), not after.
import { normalizeDoneWhen } from '../assets/done-when.js';
import { topicProfileLabel, isEarlierResult, markdownText } from '../assets/workspace-view.js';
import { stanceOf } from '../assets/stance.js';
import { certaintyText, importanceName, questionJobs, RESEARCH, isAssumption } from '../assets/questions.js';
import { comparisonLines } from './options.mjs';
import { noteLines } from './inbox.mjs';
import { reconsiderationLines } from './reconsider.mjs';
import { limitationLines } from './limitations.mjs';
import { claimLines } from './claims.mjs';
import { hasFindings, currentRun } from './completion.mjs';
import { hypothesisLines } from './hypotheses.mjs';
import { assumptionLines } from './assumptions.mjs';
import { goalLines } from './guidance.mjs';
import { findingsBasis, reasoningLabel } from '../assets/claims.js';
import { glossaryLines } from './glossary.mjs';
import { linkSuffix } from './links.mjs';
import { peopleLines } from './people.mjs';
import { generatedFrom } from './map-validation.mjs';

// Contributor names come from Git; in generated Markdown they stay literal text, never markup.
const literal = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Help me answer (B9) in a node's Markdown: the question's latest research, never presented as its answer.
function researchLines(job, stale) {
  if (!job) return [];
  const { summary, sources } = job.result;
  return ['', stale ? '_Earlier agent research, from before the question or its context changed. Not your answer._' : '_Agent research to help you answer, not your answer._',
    ...(summary ? ['', summary] : []), '', ...comparisonLines(job.result, { level: 4 }), ...(sources.length ? ['', 'Sources:', ...sources.flatMap(evidenceLine)] : [])];
}
// One source as the Markdown views list evidence.
const evidenceLine = s => ['', `- [${s.title.replace(/[\[\]]/g, '')}](${s.url}) (${stanceOf(s) ? `${stanceOf(s)}; ` : ''}retrieved ${s.retrievedAt}): ${s.note}`];

export function renderViews(map, { resultIsStale }) {
  const nodes = new Map();
  const overview = [`# ${map.title}`, '', `${generatedFrom(map.revision)} Canonical source: [map.json](map.json).`,
    '', '> Read this overview, then only relevant node documents. Node files are generated; use the application or CLI to make changes.',
    '', '## Original idea', '', map.originalIdea || map.nodes[0].prompt || map.nodes[0].body, ...(goalLines(map).length ? ['', ...goalLines(map)] : []), '', '## Exploration', ''];
  for (const n of map.nodes) {
    const findings = hasFindings(map, n);
    overview.push(`- [${n.title.replace(/[\[\]]/g, '')}](nodes/${n.id}.md): ${n.status}; ${n.reviewState}${n.stale ? '; needs review after a premise changed' : ''}. ${n.summary.replace(/\n/g, ' ')}`);
    const lines = [`# ${n.title}`, '', `Node: ${n.id} | Kind: ${n.kind} | Work: ${n.status} | Review: ${n.reviewState}`,
      `${generatedFrom(map.revision)} Edit through Explore.`, ...(n.acceptedBy?.name ? [`Accepted by ${literal(n.acceptedBy.name)}.`] : []), '', '## Premise', '', n.prompt || n.body, ...(n.doneWhen ? ['', `Done when: ${literal(normalizeDoneWhen(n.doneWhen))}`] : []), '', findings ? '## Findings' : '## Current premise (not researched findings)', '', n.summary, '', n.body];
    const guidance = topicProfileLabel(map.jobs.filter(j => currentRun(n, j)).at(-1)?.result?.topicProfile);
    if (findingsBasis(n, findings) === 'reasoning') lines.push('', `_${reasoningLabel}._`);
    if (guidance && findings) lines.push('', `_Guidance: ${guidance}_`);
    if (n.options?.length) lines.push('', ...comparisonLines(n), ...reconsiderationLines(map, n));
    lines.push(...noteLines(n), ...peopleLines(map, n)); // K8: the user's own notes; H7 and H6: who is asked to look at it, and discussions.
    if (n.limitations?.length) lines.push('', ...limitationLines(n));
    if (n.claims?.length) lines.push('', ...claimLines(n));
    if (n.kind === 'hypothesis') lines.push('', ...hypothesisLines(n));
    const readings = assumptionLines(n); if (readings.length) lines.push('', ...readings);
    if (n.stale) lines.push('', '> A premise changed. Review this finding before using it.', ...(n.reviewCauses || []).map(c => `> Flagged ${(c.at || '').slice(0, 10)}: ${c.kind.replace(/-/g, ' ')} (${c.sourceId}).`));
    if (n.reviewState === 'cleared') lines.push('', `_No longer relevant${n.replacedBy ? `; replaced by ${n.replacedBy}` : ''}${n.clearedAt ? ` (${n.clearedAt.slice(0, 10)})` : ''}. Not relied on._`);
    else if (n.reaffirmedAt) lines.push('', `_Reaffirmed ${n.reaffirmedAt.slice(0, 10)}: the user re-checked it against the change; it was not re-researched._`);
    const dismissedQuestions = n.questions.filter(q => q.dismissedAt);
    const researchFor = q => { const job = questionJobs(map.jobs, RESEARCH, q.id).latest; return researchLines(job, !!job && resultIsStale(map, job)); };
    if (n.questions.length > dismissedQuestions.length) lines.push('', '## Questions and answers', ...n.questions.filter(q => !q.dismissedAt).flatMap(q => ['', `### ${q.text}`, '', ...(q.importance || q.why ? [`_Importance: ${importanceName(q.importance)}${q.why ? ` — ${q.why}` : ''}_`, ''] : []), ...(q.supersededAt ? [`_Question from an earlier premise (${q.supersededAt}); recheck whether its answer still applies._`, ''] : []), q.answer || (q.supersededAt ? '_No answer was recorded; this question no longer blocks work._' : q.deferredAt ? '_Saved for later; it does not block this branch._' : '_Awaiting the user._'),
      ...(q.answer ? ['', `_Certainty: ${certaintyText(q)}_`] : []), ...(isAssumption(q) && q.disproveIf ? ['', `_Would be disproved if: ${markdownText(q.disproveIf)}_`] : []),
      ...(q.previousAnswers || []).map(p => `_Earlier answer (${(p.replacedAt || '').slice(0, 10)}${p.wordingFix ? ', wording fix' : ''}): ${p.answer}_`),
      ...(q.answer && q.answeredBy?.name ? ['', `_Answered by ${literal(q.answeredBy.name)}${q.answeredAt ? ` · ${q.answeredAt.slice(0, 10)}` : ''}_`] : []),
      ...researchFor(q)]));
    if (dismissedQuestions.length) lines.push('', '## Dismissed questions', '', '_Set aside by the user; do not ask them again._', '',
      ...dismissedQuestions.map(q => `- ${q.text}${q.ratingReason ? ` — ${q.ratingReason}` : ''}${q.replacedBy === 'pending' ? ' (a replacement is on its way)' : q.replacedBy ? ' (replaced)' : ''}`));
    if (n.sources.length) lines.push('', '## Evidence', ...n.sources.flatMap(evidenceLine));
    const edges = map.edges.filter(e => e.from === n.id || e.to === n.id);
    if (edges.length) lines.push('', '## Relationships', ...edges.map(e => `- ${e.from} ${e.type} ${e.to}${linkSuffix(e)}`));
    const earlierRuns = map.jobs.filter(j => isEarlierResult(j, n));
    for (const j of earlierRuns) {
      lines.push('', j.restartedAt ? '## Earlier result before this branch was restarted' : '## Earlier investigation result', '', `Job: ${j.id}${j.restartedAt ? ` | Kept from before the restart on ${j.restartedAt.slice(0, 10)}; the full branch is in its checkpoint version.` : j.stale ? ' | A premise changed while this investigation was running.' : ' | Retained history; use the current premise and findings above.'}`, '', j.result.summary, '', j.result.body);
      if (j.result.sources?.length) lines.push('', '### Evidence recorded for this result', ...j.result.sources.flatMap(evidenceLine));
    }
    nodes.set(n.id, lines.join('\n') + '\n');
  }
  overview.push(...glossaryLines(map));
  return { readme: overview.join('\n') + '\n', nodes };
}
