// Challenge decisions (F2): the agent argues in good faith against saved answers the user chose, returning hypotheses
// to consider: hidden assumptions, counter-arguments, overlooked alternatives and evidence gaps. The user keeps or
// dismisses each; answers never change. Shared by the Store and the app.
import { answerChoices, answerChooserHtml, reviewItemHtml, proposalsOf, plural } from './workspace-view.js';

export const CHALLENGE = 'challenge';
export const maxChallenged = 40;
export const challengeWords = { assumption: 'Hidden assumption', counterargument: 'Counter-argument', alternative: 'Overlooked alternative', 'evidence-gap': 'Evidence gap' };
export const challengeCategories = Object.keys(challengeWords);
const isOpenJob = job => job.status === 'queued' || job.status === 'running';
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

// A map's challenges: `pending` (waiting or running), `failed` (the newest attempt, failed or interrupted), `latest` the
// newest proposal, and `earlier` the ones before it that still have a point waiting or kept, newest first.
export function challengesOf(map) {
  const jobs = (map.jobs ?? []).filter(job => job.type === CHALLENGE), last = jobs.at(-1), proposals = proposalsOf(map, CHALLENGE);
  return { pending: jobs.find(isOpenJob) ?? null, failed: last && (last.status === 'failed' || last.status === 'interrupted') ? last : null,
    latest: proposals.at(-1) ?? null, earlier: proposals.slice(0, -1).filter(proposal => proposal.items.some(item => item.review !== 'dismissed')).reverse() };
}
// What a kept hypothesis prefills in Add a direction, on the first idea it cites that still exists: a short title and
// the hypothesis with what would settle it. Null when every idea it cites is gone. Submitting is the user's choice.
export function directionFrom(map, item) {
  const ref = item.refs.find(entry => map.nodes.some(node => node.id === entry.nodeId));
  return ref ? { nodeId: ref.nodeId, title: clip(`${challengeWords[item.category]}: ${item.explanation}`, 100), body: `${item.explanation}\n\nWhat would settle it: ${item.resolution}` } : null;
}
// The answers a challenge was asked about, offered now: a choice is pruned to these when the map changes.
export const offeredAnswers = map => answerChoices(map).flatMap(group => group.answers.map(answer => ({ nodeId: group.nodeId, questionId: answer.questionId })));

// The dialog: progress, the newest hypotheses to keep or dismiss, earlier challenges with points still open or kept,
// and a new challenge's choice of answers. `live` is false in history, which is read-only.
export function challengeDialogHtml({ map, esc, listening, live, chosen = [], preview = null }) {
  const { pending, failed, latest, earlier } = challengesOf(map);
  const status = !live ? '<p class="form-note">An earlier view of the map: return to the live map to challenge answers or review hypotheses.</p>'
    : pending ? `<p class="question-help-status" id="challenge-status" tabindex="-1" role="status">${pending.status === 'running' ? 'Your agent is challenging these answers.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'} <button type="button" class="text-button" data-challenge-stop="${esc(pending.id)}">Stop</button></p>`
    : failed ? `<p class="state-note warning" id="challenge-status" tabindex="-1">Your agent could not challenge these answers. ${esc(failed.error ?? 'It stopped before it finished.')}</p>` : '';
  // Only http(s) sources become links: a map pulled from Git is not checked on the way in.
  const link = source => (/^https?:\/\//i.test(source.url) ? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>` : esc(source.title));
  const item = proposal => entry => reviewItemHtml(map, entry, { esc, proposalId: proposal.id, words: challengeWords, live,
    extra: entry.sources?.length ? `<ul class="research-sources">${entry.sources.map(source => `<li>${link(source)} · ${esc(source.note)}</li>`).join('')}</ul>` : '<p class="form-note">Reasoning, not research.</p>',
    kept: directionFrom(map, entry) ? `<button type="button" class="text-button" data-challenge-direction="${esc(entry.id)}" data-proposal="${esc(proposal.id)}">Explore this as a direction</button>` : '' });
  const stale = proposal => (proposal.stale ? '<p class="state-note warning">Answers you challenged changed since. Read these against your answers as they are now.</p>' : '');
  const hypotheses = latest ? `<h3 class="section-label">Hypotheses to consider</h3><p class="form-note">Your agent's challenge, not findings: your answers stay as they are.</p>${stale(latest)}`
    + (latest.items.length ? latest.items.map(item(latest)).join('') : '<p class="form-note">Your agent found nothing that matters against these answers.</p>') : '';
  const before = earlier.length ? `<details class="challenge-earlier"><summary>Earlier challenges (${earlier.length})</summary>${earlier.map(proposal => `${stale(proposal)}${proposal.items.filter(entry => entry.review !== 'dismissed').map(item(proposal)).join('')}`).join('<hr>')}</details>` : '';
  const reads = preview ? `<div id="challenge-preview"><p class="form-note">Your agent will read the original idea and ${plural(preview.records.filter(record => record.kind === 'answer').length, 'answer')}, with the map's title, and its goal and agreed terms when it has them, and argue against these answers. They never change.</p>`
    + `<ul class="challenge-reads">${preview.records.filter(record => record.kind === 'answer').map(record => `<li>${esc(record.question)} <span class="form-note">${esc(record.answer)}</span></li>`).join('')}</ul></div>` : '';
  const list = answerChooserHtml(map, { esc, prefix: 'challenge', chosen });
  const ask = !live || pending ? '' : `<h3 class="section-label">Challenge answers</h3>${list ? `<p class="form-note">Choose up to ${maxChallenged} of your answers to argue against.</p><div class="answer-choices">${list}</div>${reads}`
    + `<div class="brief-actions">${preview ? '<button type="button" class="primary" data-challenge-send="">Send to your agent</button><button type="button" class="text-button" data-challenge-cancel="">Change the choice</button>' : `<button type="button" class="secondary" data-challenge-preview=""${chosen.length ? '' : ' disabled'}>Preview what it reads</button>`}</div>`
    : '<p class="form-note">Save some answers first: a challenge argues against answers you gave.</p>'}`;
  return status + hypotheses + before + ask;
}
