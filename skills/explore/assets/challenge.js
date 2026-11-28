// Challenge decisions (F2): the agent argues in good faith against saved answers the user chose, returning hypotheses
// to consider: hidden assumptions, counter-arguments, overlooked alternatives and evidence gaps. The user keeps or
// dismisses each; answers never change. Shared by the Store and the app.
import { answerChoices, plural } from './workspace-view.js';

export const CHALLENGE = 'challenge';
export const maxChallenged = 40, maxHypotheses = 12;
export const challengeWords = { assumption: 'Hidden assumption', counterargument: 'Counter-argument', alternative: 'Overlooked alternative', 'evidence-gap': 'Evidence gap' };
export const challengeCategories = Object.keys(challengeWords);
const isOpenJob = job => job.status === 'queued' || job.status === 'running';
const clip = (value, limit) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

// A map's challenges: `pending` (waiting or running), `failed` (the newest attempt, failed or interrupted), `latest` the
// newest proposal.
export function challengesOf(map) {
  const jobs = (map.jobs ?? []).filter(job => job.type === CHALLENGE), last = jobs.at(-1);
  return { pending: jobs.find(isOpenJob) ?? null, failed: last && (last.status === 'failed' || last.status === 'interrupted') ? last : null,
    latest: (map.proposals ?? []).filter(proposal => proposal.type === CHALLENGE).at(-1) ?? null };
}
// What a kept hypothesis prefills in Add a direction on the first idea it cites: a short title and the hypothesis with
// what would settle it. Submitting is the user's choice; nothing is queued.
export function directionFrom(item) {
  return { nodeId: item.refs[0].nodeId, title: clip(`${challengeWords[item.category]}: ${item.explanation}`, 100), body: `${item.explanation}\n\nWhat would settle it: ${item.resolution}` };
}

// The dialog: progress, the newest hypotheses to keep or dismiss, and a new challenge's choice of answers.
export function challengeDialogHtml({ map, esc, listening, live = true, chosen = [], preview = null }) {
  const { pending, failed, latest } = challengesOf(map);
  const label = ref => { const node = map.nodes.find(item => item.id === ref.nodeId), question = node?.questions.find(item => item.id === ref.questionId); return `${node?.title ?? 'A removed idea'}${question ? ` · ${question.text}` : ''}`; };
  const status = !live ? '<p class="form-note">An earlier view of the map: return to the live map to challenge answers or review hypotheses.</p>'
    : pending ? `<p class="question-help-status" id="challenge-status" tabindex="-1" role="status">${pending.status === 'running' ? 'Your agent is challenging these answers.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'} <button type="button" class="text-button" data-challenge-stop="${esc(pending.id)}">Stop</button></p>`
    : failed ? `<p class="state-note warning" id="challenge-status" tabindex="-1">Your agent could not challenge these answers. ${esc(failed.error ?? 'It stopped before it finished.')}</p>` : '';
  const item = entry => {
    const sources = entry.sources?.length ? `<ul class="research-sources">${entry.sources.map(source => `<li><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a> · ${esc(source.note)}</li>`).join('')}</ul>` : '<p class="form-note">Reasoning, not research.</p>';
    const refs = entry.refs.map(ref => `<button type="button" class="text-button" data-select="${esc(ref.nodeId)}">${esc(label(ref))}</button>`).join(' ');
    const actions = !live ? '' : entry.review === 'unreviewed'
      ? `<div class="review-actions"><button type="button" class="secondary" data-challenge-review="${esc(entry.id)}" data-proposal="${esc(latest.id)}" data-decision="accepted">Keep</button><button type="button" class="text-button" data-challenge-review="${esc(entry.id)}" data-proposal="${esc(latest.id)}" data-decision="dismissed">Dismiss</button></div>`
      : entry.review === 'accepted' ? `<p class="state-note">Kept. <button type="button" class="text-button" data-challenge-direction="${esc(entry.id)}">Explore this as a direction</button></p>` : '<p class="form-note">Dismissed.</p>';
    return `<article class="review-item"><strong>${esc(challengeWords[entry.category] ?? entry.category)}</strong><p>${esc(entry.explanation)}</p><p class="form-note">What would settle it: ${esc(entry.resolution)}</p><p class="review-refs">On ${refs}</p>${sources}${actions}</article>`;
  };
  const hypotheses = latest ? `<h3 class="section-label">Hypotheses to consider</h3><p class="form-note">Your agent's challenge, not findings: your answers stay as they are.</p>${latest.stale ? '<p class="state-note warning">Some of the challenged answers changed since. Read these against your answers as they are now.</p>' : ''}`
    + (latest.items.length ? latest.items.map(item).join('') : '<p class="form-note">Your agent found nothing that matters against these answers.</p>') : '';
  const choices = answerChoices(map), isChosen = (nodeId, questionId) => chosen.some(record => record.nodeId === nodeId && record.questionId === questionId);
  const list = choices.map(group => `<fieldset class="tools-group"><legend>${esc(group.title)}</legend>${group.answers.map(answer => `<label class="tools-choice"><input type="checkbox" data-challenge-node="${esc(group.nodeId)}" data-challenge-question="${esc(answer.questionId)}"${isChosen(group.nodeId, answer.questionId) ? ' checked' : ''}> ${esc(answer.question)}</label>`).join('')}</fieldset>`).join('');
  const reads = preview ? `<p class="form-note" id="challenge-preview">Your agent will read ${plural(preview.records.filter(record => record.kind === 'answer').length, 'answer')} and the original idea, nothing else, and argue against them. Your answers never change.</p>` : '';
  const ask = !live || pending ? '' : `<h3 class="section-label">Challenge answers</h3>${choices.length ? `<p class="form-note">Choose up to ${maxChallenged} of your answers to argue against.</p><div class="adr-choices">${list}</div>${reads}`
    + `<div class="brief-actions">${preview ? '<button type="button" class="primary" data-challenge-send="">Send to your agent</button><button type="button" class="text-button" data-challenge-cancel="">Change the choice</button>' : `<button type="button" class="secondary" data-challenge-preview=""${chosen.length ? '' : ' disabled'}>Preview what it reads</button>`}</div>`
    : '<p class="form-note">Save some answers first: a challenge argues against answers you gave.</p>'}`;
  return status + hypotheses + ask;
}
