import { presentation } from './graph.js';
import { isBlocking, importanceLabel, highestImportance } from './questions.js';

// One question at a time (B10). The batch is the questions from the agent's newest result (by jobId;
// a regenerated question takes its original's place). Older maps without jobId treat all open
// questions as one batch. Handled means answered, saved for later, or dismissed; a regeneration still
// on its way counts toward the total and waits at the end.
export function questionSequence(node) {
  const live = node.questions.filter(q => !q.supersededAt);
  const byId = new Map(live.map(q => [q.id, q]));
  const batchOf = q => { let current = q; for (let step = 0; current.replaces && byId.has(current.replaces) && step < 20; step++) current = byId.get(current.replaces); return current.jobId ?? null; };
  const anchor = [...live].reverse().find(isBlocking) ?? live.at(-1);
  if (!anchor) return { batch: [], current: null, index: 0, total: 0, answered: [], remaining: 0 };
  const key = batchOf(anchor);
  let batch = live.filter(q => batchOf(q) === key && !(q.replacedBy && q.replacedBy !== 'pending'));
  if (key === null) batch = batch.filter(isBlocking);
  batch = [...batch.filter(q => q.replacedBy !== 'pending'), ...batch.filter(q => q.replacedBy === 'pending')];
  const handled = q => !!q.answer || !!q.deferredAt || (!!q.dismissedAt && q.replacedBy !== 'pending');
  const current = batch.find(q => isBlocking(q) && q.replacedBy !== 'pending') ?? null;
  return { batch, current, index: current ? batch.filter(handled).length + 1 : batch.length, total: batch.length,
    answered: batch.filter(q => q.answer), remaining: batch.filter(isBlocking).length };
}

export const overviewFilters = [
  { id: 'answer', label: 'Needs your answer', empty: 'No questions are waiting for you.', matches: node => node.status === 'awaiting-answer',
    note: node => { const label = importanceLabel(highestImportance(node.questions)); return label ? ` · ${label}` : ''; } },
  { id: 'queued', label: 'Queued', empty: 'No branches are waiting in the queue.', matches: node => node.status === 'queued' },
  { id: 'unexplored', label: 'Unexplored', empty: 'Every suggested direction has been explored or started.', matches: node => node.status === 'suggested' },
  { id: 'stale', label: 'Needs review', empty: 'No findings are flagged by a changed premise.', matches: node => Boolean(node.stale) },
];

export function mapOverview(map) {
  const nodes = map?.nodes || [];
  return {
    total: nodes.length,
    explored: nodes.filter(node => node.status === 'explored').length,
    accepted: nodes.filter(node => node.reviewState === 'accepted' && !node.stale && node.status === 'explored').length,
    running: nodes.filter(node => node.status === 'running').length,
    groups: overviewFilters.map(filter => ({ ...filter, nodes: nodes.filter(filter.matches) })),
  };
}

// A historical selection must refer to a visible idea, never a hidden future one.
export function visibleSelection(map, selected) {
  return map.nodes.some(node => node.id === selected) ? selected : null;
}

// How the open map differs from the copy the browser shows. Content counts, not the revision
// number alone: a pull can bring the same revision with different content, or an older one.
export function openMapChange(listed, shown) {
  if (!shown) return null;
  if (!listed) return 'removed';
  if (listed.unreadable) return 'unreadable';
  return listed.fingerprint !== shown.fingerprint || listed.revision !== shown.revision ? 'changed' : null;
}

// Plain words for a map Explore cannot open. They never quote the file.
const unreadableLabels = {
  'invalid-utf8': "Can't open: the file is damaged",
  'conflict-markers': "Can't open: unresolved Git conflict",
  'invalid-json': "Can't open: the file is damaged",
  'unsupported-version': "Can't open: saved by a newer Explore",
  'invalid-map': "Can't open: the file is incomplete",
  'too-large': "Can't open: the file is too large",
};
export function unreadableLabel(problem) { return Object.hasOwn(unreadableLabels, problem) ? unreadableLabels[problem] : "Can't open this map"; }

// A quiet, one-time note after a pull or branch switch replaced the open map.
export function outsideChangeNote(change, seenAt) {
  if (!change || change.at === seenAt) return null;
  return `Updated from a change outside Explore, for example a pull.${change.preserved ? ' The earlier version was kept.' : ''}`;
}

// Version history in plain words. The first label of a change describes it best.
const versionWords = {
  activated: 'Exploration started', answered: 'Answer saved', result: 'Agent result', suggested: 'Direction added',
  accepted: 'Finding accepted', revised: 'Premise revised', 'revision-suggested': 'Changed premise added', cancelled: 'Exploration stopped',
  failed: 'Exploration could not finish', 'stale-result': 'Result kept for review', 'job-queued': 'Help requested', 'job-result': 'Help received',
  'job-cancelled': 'Help stopped', 'version-restored': 'Restored an earlier version', 'change-undone': 'Undid a change', 'answer-state-set': 'Certainty changed', 'answer-deferred': 'Question saved for later', 'before-outside-change': 'Before a pull or branch switch',
  preserved: 'Kept before a pull', 'repeat-stopped': 'Repeat stopped', 'example-created': 'Example created',
  'answer-changed': 'Answer changed', 'answer-reworded': 'Answer reworded', reaffirmed: 'Finding still holds', cleared: 'Finding no longer relevant',
  'branch-restarted': 'Branch restarted', 'before-restart': 'Before a restart', 'map-imported': 'Map imported',
};
export function versionLabel(version) {
  if (version.name) return version.name;
  const label = (version.labels || []).find(item => Object.hasOwn(versionWords, item));
  return label ? versionWords[label] : 'Saved change';
}

// Undo goes back to the version before my latest change. Anything saved after it, such as work
// merged from someone else, is undone too, so it is named for the user to confirm. Pressing Undo
// again steps further back: each earlier undo cancels the change it undid. Copies kept around a
// pull are bookkeeping, never a change to undo. Without any change of mine, the latest change counts.
const keptCopies = new Set(['before-outside-change', 'preserved']);
function findUndo(versions, me) {
  const cancelled = new Set();
  let pending = 0;
  for (let index = 0; index < versions.length; index++) {
    const version = versions[index], labels = version.labels || [];
    if (labels.some(label => keptCopies.has(label)) || (me && version.author !== me)) continue;
    if (labels.includes('change-undone')) { pending += 1; continue; }
    if (pending) { pending -= 1; cancelled.add(version.id); continue; }
    const target = versions[index + 1];
    if (!target) return null;
    const alsoUndone = versions.slice(0, index).filter(other => !cancelled.has(other.id) && other.author !== me
      && !(other.labels || []).some(label => keptCopies.has(label) || label === 'change-undone'));
    return { target, undoing: version, alsoUndone };
  }
  return undefined;
}
export function undoTarget(versions, me) {
  const mine = me ? findUndo(versions, me) : undefined;
  if (mine !== undefined) return mine;
  return findUndo(versions, null) ?? null;
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Importance on an open question (B2): a text label, and a Why? disclosure with the agent's reason.
export function importanceHtml(question, { esc }) {
  const label = importanceLabel(question.importance) ? `<span>${importanceLabel(question.importance)}</span>` : '';
  if (!question.why) return label ? `<p class="question-importance">${label}</p>` : '';
  return `<details class="question-importance question-why"><summary>${label ? `${label} · ` : ''}<span class="why-link">Why?</span></summary><p>${esc(question.why)}</p></details>`;
}

export function restoreSummary({ counts, reopened, queuedCancelled = 0 }, { undo = false } = {}) {
  const verb = undo ? 'Undoing' : 'Restoring';
  const parts = [
    counts.nodesRemoved && `removes ${count(counts.nodesRemoved, 'idea')}`,
    counts.nodesAdded && `brings back ${count(counts.nodesAdded, 'idea')}`,
    counts.nodesChanged && `changes ${count(counts.nodesChanged, 'idea')}`,
    counts.linksRemoved && `removes ${count(counts.linksRemoved, 'connection')}`,
    counts.linksAdded && `brings back ${count(counts.linksAdded, 'connection')}`,
  ].filter(Boolean);
  const changes = parts.length ? `${verb} ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.` : `${verb} changes no ideas or connections.`;
  const reopens = reopened.length ? ` It reopens ${count(reopened.length, 'finished branch', 'finished branches')}.` : '';
  const cancels = queuedCancelled ? ` It cancels ${count(queuedCancelled, 'queued exploration')}.` : '';
  return `${changes}${reopens}${cancels} Nothing is explored until you choose Retry, and you can undo ${undo ? 'this too' : 'the restore'}.`;
}

// Options the agent compared (C1), as compact cards. Only the recommended one is labelled, and the
// whole section says it is the agent's view: the user still decides.
export function optionsHtml(node, esc) {
  if (!node.options?.length) return '';
  const r = node.recommendation, list = (label, items) => items?.length ? `<p class="option-list"><strong>${label}</strong> ${items.map(esc).join(' · ')}</p>` : '';
  const cards = node.options.map(option => `<article class="option-card${r?.optionId === option.id ? ' recommended' : ''}"><h4>${esc(option.title)}${r?.optionId === option.id ? ' <span class="option-badge">Recommended</span>' : ''}</h4><p>${esc(option.description)}</p><p class="option-fit"><strong>Fits when</strong> ${esc(option.fit)}</p>${list('Pros', option.pros)}${list('Cons', option.cons)}</article>`).join('');
  const chosen = node.options.find(option => option.id === r?.optionId);
  const advice = chosen
    ? `<p><strong>Why ${esc(chosen.title)}:</strong> ${esc(r.rationale)}</p><p><strong>Main trade-off:</strong> ${esc(r.mainTradeoff)}</p>${r.reconsiderIf ? `<p><strong>Reconsider if:</strong> ${esc(r.reconsiderIf)}</p>` : ''}`
    : `<p><strong>No recommendation yet.</strong> ${esc(r?.missing ?? '')}</p>`;
  return `<h3 class="section-label">Options</h3><p class="form-note">Your agent's comparison, not a decision. You choose.</p>${node.optionsLimit ? `<p class="state-note">Only one real option: ${esc(node.optionsLimit)}</p>` : ''}${cards}<div class="option-advice">${advice}</div>`;
}
// A suggested answer is added after the user's own draft, never replacing it.
export function appendSuggestion(draft, suggestion) {
  const own = String(draft ?? '').trimEnd();
  return own ? `${own}\n\n${suggestion}` : suggestion;
}

// Saved, current answers grouped by idea, root first, for choosing what a map review reads.
export function answerChoices(map) {
  const children = new Map(map.nodes.map(node => [node.id, []]));
  for (const node of map.nodes) children.get(node.parentId)?.push(node);
  const ordered = [], seen = new Set(), queue = map.nodes.filter(node => node.id === map.rootId);
  while (queue.length) { const node = queue.shift(); if (seen.has(node.id)) continue; seen.add(node.id); ordered.push(node); queue.push(...children.get(node.id)); }
  return [...ordered, ...map.nodes.filter(node => !seen.has(node.id))]
    .map(node => ({ nodeId: node.id, title: node.title, answers: node.questions.filter(q => q.answer && !q.supersededAt).map(q => ({ questionId: q.id, question: q.text })) }))
    .filter(group => group.answers.length);
}

const reviewWords = { 'possible-tension': 'Possible tension', 'unresolved-choice': 'Unresolved choice', 'untested-assumption': 'Untested assumption' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The Check answers panel: what will be read, progress, and the latest points to keep or dismiss.
export function checkAnswersHtml({ map, preview, listening, esc }) {
  const records = preview?.records || [], omitted = preview?.omittedRecords || [];
  const answers = records.filter(r => r.kind === 'answer').length, open = records.filter(r => r.kind === 'open-question').length;
  const earlier = omitted.filter(r => r.reason === 'earlier premise').length, over = omitted.length - earlier;
  const reads = preview ? `<p class="form-note">Reads ${plural(answers, 'answer')} and ${plural(open, 'open question')}.${earlier ? ` ${plural(earlier, 'answer')} from an earlier premise ${earlier === 1 ? 'is' : 'are'} left out.` : ''}${over ? ` ${over} didn't fit and ${over === 1 ? 'is' : 'are'} left out.` : ''}</p>` : '';
  const job = (map.jobs || []).filter(j => j.type === 'check-answers' && ['queued', 'running'].includes(j.status)).at(-1);
  const progress = job
    ? `<p class="state-note">${job.status === 'running' ? 'Your agent is checking your answers…' : listening ? 'Your agent will pick this up next.' : 'Saved in the queue. Connect your agent to run the check.'}</p><button class="secondary" data-cancel-job="${esc(job.id)}">Stop</button>`
    : '<button class="primary" data-check-answers>Check answers</button>';
  const latest = (map.proposals || []).filter(p => p.type === 'check-answers').at(-1);
  const label = ref => { const node = map.nodes.find(n => n.id === ref.nodeId), q = node?.questions.find(x => x.id === ref.questionId); return `${node?.title ?? 'A removed idea'}${q ? ` · ${q.text}` : ''}`; };
  const items = latest ? (latest.items.length ? latest.items.map(item => `<article class="review-item"><strong>${esc(reviewWords[item.category] || item.category)}</strong><p>${esc(item.explanation)}</p><p><strong>What would settle it:</strong> ${esc(item.resolution)}</p><div class="review-refs">${item.refs.map(ref => `<button class="text-button" data-select="${esc(ref.nodeId)}">${esc(label(ref))}</button>`).join('')}</div>${item.review === 'unreviewed'
      ? `<div class="review-actions"><button class="secondary" data-review-item="${esc(item.id)}" data-proposal="${esc(latest.id)}" data-decision="accepted">Keep</button><button class="text-button" data-review-item="${esc(item.id)}" data-proposal="${esc(latest.id)}" data-decision="dismissed">Dismiss</button></div>`
      : `<p class="review-decision">${item.review === 'accepted' ? 'Kept' : 'Dismissed'}</p>`}</article>`).join('') : '<p class="form-note">No tensions found in these answers.</p>') : '';
  const results = latest ? `<h3 class="section-label">Latest check · ${esc(new Date(latest.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</h3>${latest.stale ? '<p class="state-note warning">Some answers changed since this check. Run it again for a fresh read.</p>' : ''}${latest.summary ? `<p>${esc(latest.summary)}</p>` : ''}${items}` : '';
  return `<p>Your agent reads your saved answers and points out possible tensions, unresolved choices and untested assumptions. It never changes an answer, and every point waits for you to keep or dismiss it.</p>${reads}${progress}${results}`;
}

// The one ⋯ menu shape shared by questions and ideas; app.js opens, closes and steers every `.item-menu`.
function menuHtml(id, label, items) {
  return `<div class="item-more-wrap"><button type="button" class="item-more" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-${id}" data-menu="${id}" aria-label="${label}">⋯</button><div class="item-menu" role="menu" id="menu-${id}" aria-label="${label}" hidden>${items.join('')}</div></div>`;
}
// The question ⋯ menu (B7). Items keep one fixed order so later features slot in predictably:
// Help me answer, Explain this question, Tidy my wording (later issues), Answer later, Regenerate,
// Dismiss, Good question / Bad question. Answered questions offer only the rating.
export function questionMenuHtml(question, { nodeId, kind, lastBlocking = false, esc }) {
  const id = esc(question.id), node = esc(nodeId);
  const item = (label, attributes) => `<button type="button" role="menuitem" tabindex="-1" ${attributes} data-question-id="${id}" data-node-id="${node}">${label}</button>`;
  const items = [
    ...(kind === 'open' ? [item('Explain this question', 'data-q-help'), item('Answer later', `data-answer-later="${id}"`), item('Regenerate', 'data-q-reason="regenerate"'), item(lastBlocking ? 'Dismiss and continue' : 'Dismiss', 'data-q-dismiss')] : []),
    ...(kind === 'answered' ? [item('Change answer', 'data-q-change')] : []),
    item('Good question', 'data-q-rate="good"'), item('Bad question', 'data-q-reason="bad"'),
  ];
  const rated = question.rating ? `<p class="question-rated">You rated this ${question.rating === 'good' ? 'a good question' : 'a bad question'}${question.ratingReason ? `: ${esc(question.ratingReason)}` : ''} · <button type="button" class="text-button" data-q-rate="" data-question-id="${id}" data-node-id="${node}">Undo</button></p>` : '';
  return menuHtml(id, 'More for this question', items)
    + `<div class="question-reason" data-reason-for="${id}" hidden><label class="visually-hidden" for="reason-${id}">What was wrong? (optional)</label><input id="reason-${id}" maxlength="600" placeholder="What was wrong? (optional)"><button type="button" class="secondary" data-send-reason="${id}" data-node-id="${node}">Send</button></div>${rated}`;
}
// Explain this question (B4): what the agent is doing about it, or its latest current help, under the
// question. Help is never an answer: it is labelled so and never touches the answer field. It opens the
// first time it appears and stays collapsed once seen.
export function questionHelpHtml({ question, jobs, listening, seen, esc }) {
  const mine = jobs.filter(job => job.type === 'question-help' && job.subjectId === question.id);
  if (mine.some(job => job.status === 'queued' || job.status === 'running')) return `<p class="question-help-status">${listening ? 'Your agent is working on it.' : 'Queued for your agent.'}</p>`;
  const help = mine.filter(job => job.status === 'completed' && !job.stale && job.result?.help).at(-1);
  return help ? `<details class="question-help" data-help="${esc(help.id)}" data-editor="help-${esc(help.id)}"${seen.has(help.id) ? '' : ' open'}><summary>Help from your agent, not an answer</summary><p class="question-help-text">${esc(help.result.help)}</p></details>` : '';
}
// The idea ⋯ menu (H2): Copy link.
export function nodeMenuHtml(node, { esc }) {
  const id = esc(node.id);
  return menuHtml(id, 'More for this idea', [`<button type="button" role="menuitem" tabindex="-1" data-copy-link="${id}">Copy link</button>`]);
}

// Text that reads as itself in Markdown, on one line.
export const markdownText = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
// A portable reference to one idea (H2): its map and node IDs first, so a title can never redirect it, then
// the title and the repo path of its view for people reading it elsewhere. It never carries answers,
// findings, absolute paths, ports or tokens.
export const nodeReference = (mapId, node) => `Explore idea ${mapId}/${node.id}: "${markdownText(node.title)}" (ideas/${mapId}/nodes/${node.id}.md)`;
const mapIdPattern = 'map-[a-f0-9]{8}', nodeIdPattern = 'node-[a-f0-9]{8}';
// The first `map-…/node-…` pair or `ideas/map-…/nodes/node-….md` path in some text. Each must stand on its
// own: not inside a longer path (`../`, `/extra`) and with IDs of exactly the generated length.
const referencePattern = new RegExp(String.raw`(?:^|[^\w./-])(?:(${mapIdPattern})\/(${nodeIdPattern})|ideas\/(${mapIdPattern})\/nodes\/(${nodeIdPattern})\.md)(?![\w/-])`);
export function parseNodeReference(text) {
  const match = String(text ?? '').match(referencePattern);
  return match ? { mapId: match[1] ?? match[3], nodeId: match[2] ?? match[4] } : null;
}
// The app's own address names a map, or one idea in it, exactly: map-… or map-…/node-….
const addressPattern = new RegExp(String.raw`^(${mapIdPattern})(?:\/(${nodeIdPattern}))?$`);
export const nodeAddress = (mapId, nodeId) => nodeId ? `${mapId}/${nodeId}` : mapId;
export function parseAddress(text) {
  const match = String(text ?? '').match(addressPattern);
  return match ? { mapId: match[1], nodeId: match[2] ?? null } : null;
}
export const missingMapMessage = "This map isn't in this workspace. It may be on another branch or not pulled yet.";
export const missingIdeaMessage = "That idea wasn't found in this map, so its starting idea is shown.";

// Arrow keys move through a menu and wrap around; Home and End jump to its ends.
export function menuFocusIndex(index, key, count) {
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return index;
}

// Review flagged findings (D3): flagged ideas in tree order from the root, then any outside the tree.
export function reviewQueue(map) {
  const children = new Map(map.nodes.map(node => [node.id, []]));
  for (const node of map.nodes) children.get(node.parentId)?.push(node);
  const ordered = [], seen = new Set();
  const visit = node => { if (seen.has(node.id)) return; seen.add(node.id); ordered.push(node); for (const child of children.get(node.id)) visit(child); };
  for (const node of map.nodes.filter(node => node.id === map.rootId)) visit(node);
  for (const node of map.nodes) visit(node);
  return ordered.filter(node => node.stale).map(node => node.id);
}
const shortDate = at => at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
// One step of the review: what changed upstream, then Still holds, Re-explore or No longer relevant.
export function reviewStepHtml({ map, nodeId, index, total, esc }) {
  const node = map.nodes.find(n => n.id === nodeId);
  if (!node) return '';
  const title = id => map.nodes.find(n => n.id === id)?.title ?? 'A removed idea';
  const source = id => `<button type="button" class="text-button" data-select="${esc(id)}">${esc(title(id))}</button>`;
  const more = (before, after) => before || after ? `<details class="review-more"><summary>Show what changed</summary>${before ? `<p><strong>Before:</strong> ${esc(before)}</p>` : ''}${after ? `<p><strong>Now:</strong> ${esc(after)}</p>` : ''}</details>` : '';
  const cause = c => {
    const from = map.nodes.find(n => n.id === c.sourceId);
    if (c.kind === 'premise-revised') return `${source(c.sourceId)}: its premise was revised${c.at ? ` on ${esc(shortDate(c.at))}` : ''}.${more(map.history?.filter(e => e.type === 'previous-premise' && e.nodeId === c.sourceId).at(-1)?.detail, from?.prompt)}`;
    if (c.kind === 'premise-forked') return `${source(c.sourceId)} was explored with a changed premise${c.at ? ` on ${esc(shortDate(c.at))}` : ''}.${more(from?.prompt, map.nodes.filter(n => n.revises === c.sourceId).at(-1)?.prompt)}`;
    if (c.kind === 'answer-changed') { const q = from?.questions.filter(x => x.previousAnswers?.length).at(-1); return `An answer on ${source(c.sourceId)} changed${c.at ? ` on ${esc(shortDate(c.at))}` : ''}.${more(q?.previousAnswers.at(-1)?.answer, q?.answer)}`; }
    if (c.kind === 'branch-restarted') { const q = from?.questions.filter(x => x.previousAnswers?.some(p => p.restart)).at(-1); return `${source(c.sourceId)} was restarted from a changed answer${c.at ? ` on ${esc(shortDate(c.at))}` : ''}; the ideas below it were removed and are kept in a checkpoint version.${more(q?.previousAnswers.filter(p => p.restart).at(-1)?.answer, q?.answer)}`; }
    if (c.kind === 'result-during-change') return `A result arrived while this idea's premise was changing${c.at ? ` (${esc(shortDate(c.at))})` : ''}. It is kept in history, not applied.`;
    return `${source(c.sourceId)} changed.`;
  };
  const causes = node.reviewCauses?.length ? `<ul class="review-causes">${node.reviewCauses.map(c => `<li>${cause(c)}</li>`).join('')}</ul>${node.earlierCauses ? '<p class="form-note">Earlier causes are not shown.</p>' : ''}` : '<p class="form-note">Flagged before causes were recorded.</p>';
  const id = esc(node.id);
  return `<section class="review-step" aria-label="Review flagged findings"><div class="review-step-head"><strong aria-live="polite">Item ${index + 1} of ${total}</strong><span class="review-nav"><button type="button" class="text-button" data-review-prev${index === 0 ? ' disabled' : ''}>Previous</button><button type="button" class="text-button" data-review-next${index >= total - 1 ? ' disabled' : ''}>Next</button><button type="button" class="text-button" data-review-exit>Done</button></span></div>`
    + `<p class="form-note">Something this finding relied on changed. Check whether it still holds.</p>${causes}`
    + `<div class="review-resolve"><button type="button" class="primary" data-resolve="reaffirm" data-node-id="${id}">Still holds</button><button type="button" class="secondary" data-resolve="reexplore" data-node-id="${id}">Re-explore</button><button type="button" class="text-button" data-resolve="clear" data-node-id="${id}">No longer relevant</button></div>`
    + `<div class="review-reexplore" data-reexplore-for="${id}" hidden><label for="reexplore-${id}">The premise to explore (edit it if you like)</label><textarea id="reexplore-${id}" rows="3" maxlength="16000">${esc(node.prompt || node.body)}</textarea><button type="button" class="primary" data-reexplore-confirm="${id}">Re-explore</button></div></section>`;
}

// Restart preview (Z2): what restarting a finished branch deletes, sets aside and flags, the checkpoint
// saved first, and the confirm button. Shown inside the Change answer editor; nothing is saved until confirmed.
export function restartPreviewHtml(preview, { esc, expanded = false }) {
  const ideas = preview.deleteCount;
  const lead = ideas
    ? `<p><strong>Restarting deletes ${count(ideas, 'idea')} below this branch${preview.linksRemoved ? `, with ${count(preview.linksRemoved, 'link')}` : ''}.</strong> This branch keeps its premise and answers and explores again from your new answer.</p>`
    : '<p><strong>Nothing below this branch is deleted.</strong> Its findings are cleared and it explores again from your new answer.</p>';
  const list = ideas ? `<details class="restart-list"${expanded ? ' open' : ''}><summary>Ideas to delete (${ideas})</summary><ul>${preview.deleted.map(node => `<li>${esc(node.title)}</li>`).join('')}</ul>${preview.nextOffset != null ? `<button type="button" class="text-button" data-restart-more="${preview.nextOffset}">Show more</button>` : ''}</details>` : '';
  const setAside = preview.superseded.length ? `<p>${preview.superseded.length === 1 ? '1 later question on this branch is' : `${preview.superseded.length} later questions on this branch are`} set aside; their answers are kept.</p>` : '';
  const flagged = preview.flagged.length ? `<p>Flagged for review: ${preview.flagged.map(node => esc(node.title)).join(', ')}.</p>` : '';
  return `<div class="state-note warning restart-preview" role="group" aria-label="Restart preview" tabindex="-1">${lead}${list}${setAside}${flagged}`
    + `<p class="form-note">A checkpoint named “${esc(preview.checkpointName)}” is saved first. Restore it from Versions to bring everything back.</p>`
    + `<div class="question-actions"><button type="button" class="primary" data-restart-confirm>${ideas ? `Delete ${count(ideas, 'idea')} and restart` : 'Restart this branch'}</button><button type="button" class="text-button" data-restart-cancel>Cancel</button></div></div>`;
}

// A file name made from a map's title that every system accepts, plus an ending such as `-brief.md`.
export function downloadName(title, ending) {
  const name = String(title || 'exploration').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'exploration';
  return `${name}${ending}`;
}
export const briefFilename = title => downloadName(title, '-brief.md');

// Import (I2): a map with this ID is already here and the file differs. Nothing has been changed yet.
export function importConflictHtml({ existing, incoming }, { esc }) {
  const when = at => Number.isNaN(Date.parse(at)) ? '' : ` · updated ${esc(new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }))}`;
  const side = (label, map) => `<div class="import-side"><h3 class="section-label">${label}</h3>${map.unreadable ? '<p class="form-note">A map folder with this ID is here but cannot be opened.</p>' : `<p><strong>${esc(map.title)}</strong></p><p class="form-note">${count(map.ideas, 'idea')} · revision ${esc(map.revision)}${when(map.updatedAt)}</p>`}</div>`;
  return `<p>A map with the same ID is already in this workspace, and the file is different. Nothing has been changed.</p><div class="import-sides">${side('Already here', existing)}${side('In the file', incoming)}</div>`;
}

export function briefPreview(brief) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const counts = brief.counts;
  // Show questions and answers separately so long prompts cannot hide the answer.
  const itemsWithAnswers = brief.sections.map(section => ({ ...section, items: section.items.map(item => item.question ? { ...item, text: `Question: ${item.question}\nAnswer: ${item.text}` } : item) }));
  brief = { ...brief, sections: itemsWithAnswers };
  return `${brief.originalIdea ? `<h3>Original idea</h3><blockquote>${esc(brief.originalIdea)}</blockquote>` : ''}<h3>Progress</h3><p>${counts.nodes} ideas; ${counts.explored} explored; ${counts.accepted} accepted and current; ${counts.stale} need review; ${counts.awaitingAnswer} awaiting answers.</p><p class="brief-scope-note">A bounded summary of saved material. Sections may overlap; explored findings have not necessarily been verified.</p>${brief.sections.map(section => `<section class="brief-section"><h3>${esc(section.label)}</h3>${section.items.length ? section.items.map(item => `<article class="brief-item"><strong>${esc(item.title)}</strong><small class="brief-item-state">${esc(presentation(item).label)}</small><p>${esc(item.text)}</p><small class="brief-reference">${esc(item.nodeId)}${item.questionId ? ` · ${esc(item.questionId)}` : ''}</small></article>`).join('') : '<p class="brief-empty">None recorded in this scope.</p>'}${section.omitted ? `<p class="brief-omitted">${section.omitted} more ${section.omitted === 1 ? 'record' : 'records'} in this section. Open the map to inspect the rest.</p>` : ''}</section>`).join('')}`;
}

export function historyStepLabel(step, total) {
  if (!step) return 'No growth has been recorded yet';
  const additions = step.kind === 'unknown' ? 'Additions with unknown dates' : step.kind === 'dated' ? 'From recorded node dates' : 'Recorded addition';
  return `Step ${step.index + 1} of ${total} · ${step.nodeCount} ${step.nodeCount === 1 ? 'idea' : 'ideas'} · ${step.edgeCount} ${step.edgeCount === 1 ? 'connection' : 'connections'} · ${additions}`;
}

export const starterIdeas = {
  architecture: { title: 'Choose an architecture', idea: 'Help me choose an architecture for a new application. Compare a modular monolith with separate services. Ask about my team, workload, deployment constraints and expected growth before recommending a direction. Make tradeoffs, failure modes and a first practical experiment clear.' },
  product: { title: 'Pressure-test a product idea', idea: 'I have a product idea and want to find out whether it solves an important problem. Help me define the customer, challenge my assumptions, compare alternatives and choose a small experiment to test demand. Start by asking who it serves and what problem they face.' },
  decision: { title: 'Think through a personal decision', idea: 'Help me think through an important personal decision. Ask about my options, priorities, constraints and what feels uncertain. Separate facts from assumptions, look for overlooked alternatives and identify a reversible next step. Start by asking what decision I am facing.' },
};
