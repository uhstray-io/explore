import { treeOrder, branchComplete, branchIds } from './graph.js';
import { isBlocking, importanceLabel, highestImportance, canResearch, questionJobs, EXPLAIN, RESEARCH, TIDY, answerStateLabels, effectiveAnswerState, certaintyText,
  hasCurrentAnswer, isOpen, isSavedForLater, importanceLevels, importanceName } from './questions.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

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

// Every filter: { id, kind, label, empty, matches(node), lines(node) as [{ text, detail? }] }, and optionally note(node)
// and context(matched): ideas the filter leaves out but keeps visible as quieter context, as IDs (impact, D4). The
// progress filters fill the bar; the others are More filters (Z9).
const summaryLine = node => (node.summary ? [{ text: node.summary }] : []);
export const overviewFilters = [
  { id: 'answer', label: 'Needs your answer', empty: 'No questions are waiting for you.', matches: node => node.status === 'awaiting-answer',
    note: node => { const label = importanceLabel(highestImportance(node.questions)); return label ? ` · ${label}` : ''; } },
  { id: 'queued', label: 'Queued', empty: 'No branches are waiting in the queue.', matches: node => node.status === 'queued' },
  { id: 'unexplored', label: 'Unexplored', empty: 'Every suggested direction has been explored or started.', matches: node => node.status === 'suggested' },
  { id: 'stale', label: 'Needs review', empty: 'No findings are flagged by a changed premise.', matches: node => Boolean(node.stale) },
].map(filter => ({ ...filter, kind: 'progress', lines: summaryLine }));

// More filters (Z9): how settled answers are and how much open questions matter. `lines(node)` lists that idea's
// matching questions, each { text, detail } (detail: the start of the answer).
const oneLine = (text, length) => { const flat = String(text).replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length).trimEnd()}…` : flat; };
const definition = ({ questions, line, ...rest }) => ({ ...rest, matches: node => questions(node).length > 0, lines: node => questions(node).map(line) });
const asked = q => ({ text: oneLine(q.text, 200) });

const stateFilters = [
  ...['decided', 'tentative', 'assumption'].map(state => definition({ id: `state:${state}`, kind: 'state', short: answerStateLabels[state], name: answerStateLabels[state],
    label: `Ideas with answers marked ${answerStateLabels[state]}`, empty: `No current answers are marked ${answerStateLabels[state]}.`,
    questions: node => node.questions.filter(q => hasCurrentAnswer(q) && effectiveAnswerState(q).state === state),
    // Older answers have no recorded state; they count as Tentative and say so.
    line: q => ({ ...asked(q), detail: `${oneLine(q.answer, 200)}${effectiveAnswerState(q).recorded ? '' : ` · ${certaintyText(q)}`}` }) })),
  definition({ id: 'state:later', kind: 'state', short: 'Saved for later', name: 'Saved for later', label: 'Ideas with questions saved for later',
    empty: 'No open questions are saved for later.', questions: node => node.questions.filter(isSavedForLater), line: asked }),
];
// Importance helps choose what to answer next, so only open questions on unfinished branches count.
const importanceFilters = [...importanceLevels, 'unranked'].map(level => {
  const word = importanceName(level), unranked = level === 'unranked';
  return definition({ id: `importance:${level}`, kind: 'importance', short: word, name: unranked ? 'Unranked' : `${word} importance`,
    label: unranked ? 'Ideas with unranked open questions' : `Ideas with open questions of ${word} importance`,
    empty: unranked ? 'No open questions are unranked.' : `No open questions have ${word} importance.`,
    questions: node => (branchComplete(node) ? [] : node.questions.filter(q => isOpen(q) && (unranked ? !importanceLevels.includes(q.importance) : q.importance === level))),
    line: asked });
});
export const questionFilters = [...stateFilters, ...importanceFilters];

// A branch investigation (not a question or map-wide job), and one of an idea's results that is no longer its current
// finding: stale, or replaced since (the idea's summary or body differ). Node Markdown and the source library (K10)
// both list these as earlier results.
export const isInvestigationJob = job => !job.type || job.type === 'investigate';
export const isEarlierResult = (job, node) => job.nodeId === node.id && isInvestigationJob(job) && !!job.result && (!!job.stale || job.result.summary !== node.summary || job.result.body !== node.body);

// `filters` adds filters a feature computes for this map, such as High impact, still open (D4) on the live map.
export function mapOverview(map, { filters = [] } = {}) {
  const nodes = map?.nodes || [];
  return {
    total: nodes.length,
    explored: nodes.filter(node => node.status === 'explored').length,
    accepted: nodes.filter(node => node.reviewState === 'accepted' && !node.stale && node.status === 'explored').length,
    running: nodes.filter(node => node.status === 'running').length,
    groups: [...overviewFilters, ...questionFilters, ...filters].map(filter => {
      const matched = nodes.filter(filter.matches);
      return { ...filter, nodes: matched, ...(filter.context ? { context: filter.context(matched) } : {}) };
    }),
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

// The research guidance a result says it followed (C6), by its `topicProfile`.
export const topicProfiles = { general: 'General', 'software-versions': 'Software and versions', 'products-services': 'Products and services', 'concepts-tradeoffs': 'Concepts and design trade-offs' };
export const topicProfileLabel = value => (typeof value === 'string' && Object.hasOwn(topicProfiles, value) ? topicProfiles[value] : null);
// Under an idea's findings: how much map context its last investigation used, and which guidance it followed.
export function runNoteHtml(job) {
  if (!job) return '';
  // Numbers, fixed labels and the agent's escaped report: nothing from the file reaches the page as markup.
  const characters = Number.isFinite(job.contextCharacters) ? job.contextCharacters : 0, guidance = topicProfileLabel(job.result?.topicProfile);
  const parts = [characters ? `Last investigation used ${characters.toLocaleString()} characters of map context. Only relevant context is sent.` : '', guidance ? `Guidance: ${guidance}.` : '',
    // The agent's own report of how it ran, shown only when it has the expected shape.
    typeof job.execution?.model === 'string' && typeof job.execution.delegated === 'boolean' ? `Your agent reported: ${escapeHtml(job.execution.model)}, ${job.execution.delegated ? 'delegated' : 'not delegated'}.` : ''].filter(Boolean);
  return parts.length ? `<p class="run-note">${parts.join(' ')}</p>` : '';
}

// Plain words for a map Explore cannot open. They never quote the file.
const unreadableReasons = {
  'invalid-utf8': 'the file is damaged', 'conflict-markers': 'unresolved Git conflict', 'invalid-json': 'the file is damaged',
  'unsupported-version': 'saved by a newer Explore', 'invalid-map': 'the file is incomplete', 'too-large': 'the file is too large',
  'invalid-version': 'the file is not a saved version', unreadable: 'the file cannot be read',
};
export const unreadableReason = problem => (Object.hasOwn(unreadableReasons, problem) ? unreadableReasons[problem] : 'it cannot be read');
export function unreadableLabel(problem) { return Object.hasOwn(unreadableReasons, problem) ? `Can't open: ${unreadableReasons[problem]}` : "Can't open this map"; }

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
  'job-cancelled': 'Help stopped', 'version-restored': 'Restored an earlier version', 'branch-restored': 'Restored one branch', 'change-undone': 'Undid a change', linked: 'Connection added', unlinked: 'Connection removed', 'answer-state-set': 'Certainty changed', 'answer-deferred': 'Question saved for later', 'before-outside-change': 'Before a pull or branch switch',
  preserved: 'Kept before a pull', 'repeat-stopped': 'Repeat stopped', 'example-created': 'Example created',
  'answer-changed': 'Answer changed', 'outcome-recorded': 'Outcome recorded', 'disprove-if-set': 'Assumption note changed', 'answer-reworded': 'Answer reworded', reaffirmed: 'Finding still holds', cleared: 'Finding no longer relevant',
  'branch-restarted': 'Branch restarted', 'before-restart': 'Before a restart', 'map-imported': 'Map imported', 'glossary-added': 'Glossary term added', 'guidance-changed': 'Goal and mode changed', 'glossary-edited': 'Glossary term edited', 'glossary-removed': 'Glossary term removed', 'glossary-accepted': 'Glossary term accepted', 'glossary-dismissed': 'Proposed term dismissed', 'done-when-set': 'Stopping point set', 'map-recovered': 'Recovered from a version',
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
// The versions Undo depends on for `me`: those findUndo walks (my own, down to the change it undoes) and its target.
// Removing any other version cannot change what my Undo does. With no `me`, everything down to the target.
export function undoDependencies(versions, me) {
  const undo = findUndo(versions, me);
  // No target: the walk still looked at every version it could use, so all of those stay.
  if (!undo) return me ? versions.filter(version => version.author === me) : versions;
  const end = versions.indexOf(undo.target);
  return versions.slice(0, end + 1).filter(version => !me || version.author === me || version === undo.target);
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
    counts.termsChanged && `changes the glossary`,
    counts.guidanceChanged && 'changes the goal and mode',
  ].filter(Boolean);
  const changes = parts.length ? `${verb} ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.` : `${verb} changes no ideas or connections.`;
  const reopens = reopened.length ? ` It reopens ${count(reopened.length, 'finished branch', 'finished branches')}.` : '';
  const cancels = queuedCancelled ? ` It cancels ${count(queuedCancelled, 'queued exploration')}.` : '';
  return `${changes}${reopens}${cancels} Nothing is explored until you choose Retry, and you can undo ${undo ? 'this too' : 'the restore'}.`;
}

// Options the agent compared (C1), as compact cards. Only the recommended one is labelled, and the
// whole section says it is the agent's view: the user still decides. `extra(option)` adds to a card (C3's notes).
// `lead` is shown first, above the cards: a reconsideration the user adopted (C9), after which the comparison's own
// recommendation reads as the original.
export function optionsHtml(node, esc, extra = () => '', lead = '') {
  if (!node.options?.length) return '';
  return `<h3 class="section-label">Options</h3><p class="form-note">Your agent's comparison, not a decision. You choose.</p>${lead}${optionCardsHtml(node, esc, extra, { original: !!lead })}`;
}
// The cards and the recommendation for any comparison; `extra(option)` adds controls to a card.
function optionCardsHtml(comparison, esc, extra = () => '', { original = false } = {}) {
  const r = comparison.recommendation, list = (label, items) => items?.length ? `<p class="option-list"><strong>${label}</strong> ${items.map(esc).join(' · ')}</p>` : '';
  const cards = comparison.options.map(option => `<article class="option-card${r?.optionId === option.id ? ' recommended' : ''}"><h4>${esc(option.title)}${r?.optionId === option.id ? ` <span class="option-badge">${original ? 'Originally recommended' : 'Recommended'}</span>` : ''}</h4><p>${esc(option.description)}</p><p class="option-fit"><strong>Fits when</strong> ${esc(option.fit)}</p>${list('Pros', option.pros)}${list('Cons', option.cons)}${extra(option)}</article>`).join('');
  return `${comparison.optionsLimit ? `<p class="state-note">Only one real option: ${esc(comparison.optionsLimit)}</p>` : ''}${cards}<div class="option-advice">${original ? '<p class="option-original">Original recommendation</p>' : ''}${adviceHtml(comparison.options, r, esc)}</div>`;
}
// A recommendation's advice: why, the main trade-off and what would change it, or what is missing. Shared with the
// reconsideration (C9), whose `options` are the `{ id, title }` it was asked about.
export function adviceHtml(options, r, esc) {
  const chosen = options.find(option => option.id === r?.optionId);
  return chosen
    ? `<p><strong>Why ${esc(chosen.title)}:</strong> ${esc(r.rationale)}</p><p><strong>Main trade-off:</strong> ${esc(r.mainTradeoff)}</p>${r.reconsiderIf ? `<p><strong>Reconsider if:</strong> ${esc(r.reconsiderIf)}</p>` : ''}`
    : `<p><strong>No recommendation yet.</strong> ${esc(r?.missing ?? '')}</p>`;
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
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
// Help me answer, Explain this question, Tidy my wording (a later issue), Answer later, Regenerate,
// Dismiss, Change answer, extra `items` (Pin answer), Good question / Bad question. `kind` is 'open', 'waiting' (saved
// for later), 'answered' or 'superseded' (an answer from an earlier premise: only the extra items);
// `completed` says the branch is finished, where nothing but the rating, Change answer and the extra items apply. A question
// saved for later offers only what leaves a queued or running branch alone: research, an explanation, a rating.
// Tidy my wording is marked data-needs-draft: opening the menu shows it only while the answer box has text.
export function questionMenuHtml(question, { nodeId, kind, completed = false, lastBlocking = false, esc, items: extra = [] }) {
  const id = esc(question.id), node = esc(nodeId);
  if (kind === 'superseded') return extra.length ? menuHtml(id, 'More for this answer', extra) : ''; // Only Pin answer applies.
  const item = (label, attributes) => `<button type="button" role="menuitem" tabindex="-1" ${attributes} data-question-id="${id}" data-node-id="${node}">${label}</button>`;
  const items = [
    ...(canResearch(question, { completed }) ? [item('Help me answer', 'data-q-research')] : []),
    ...(kind === 'answered' ? [] : [item('Explain this question', 'data-q-help'), item('Tidy my wording', 'data-q-tidy data-needs-draft hidden')]),
    ...(kind === 'open' ? [item('Answer later', `data-answer-later="${id}"`), item('Regenerate', 'data-q-reason="regenerate"'), item(lastBlocking ? 'Dismiss and continue' : 'Dismiss', 'data-q-dismiss')] : []),
    ...(kind === 'answered' ? [item('Change answer', 'data-q-change')] : []),
    ...extra,
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
  const { pending, latest: help } = questionJobs(jobs, EXPLAIN, question.id);
  if (pending) return `<p class="question-help-status">${waitingWords(pending, listening, 'explaining this question')}</p>`;
  return help && !help.stale ? `<details class="question-help" data-help="${esc(help.id)}" data-editor="help-${esc(help.id)}"${seen.has(help.id) ? '' : ' open'}><summary>Help from your agent, not an answer</summary><p class="question-help-text">${esc(help.result.help)}</p></details>` : '';
}
// What a queued or running question job is doing, promising nothing while no agent is listening.
const waitingWords = (job, listening, doing) => job.status === 'running' ? `Your agent is ${doing}.` : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.';
// Help me answer (B9): what the agent is doing about it, or its latest research, under the question. Research
// is never an answer: an option's suggested answer is only copied into the user's draft when they ask, and
// research from before the question or its context changed stays visible as earlier research, without copy.
export function questionResearchHtml({ question, jobs, listening, seen, esc }) {
  const { pending, latest: job } = questionJobs(jobs, RESEARCH, question.id);
  if (pending) return `<p class="question-help-status">${waitingWords(pending, listening, 'researching this question')} <button type="button" class="text-button" data-stop-job="${esc(pending.id)}">Stop</button></p>`;
  if (!job) return '';
  const { summary, sources = [] } = job.result;
  const copy = option => option.suggestedAnswer ? `<button type="button" class="text-button" data-copy-answer="${esc(option.id)}" data-research-job="${esc(job.id)}" data-question-id="${esc(question.id)}"${job.stale ? ' disabled title="The question or its context changed since this research."' : ''}>Copy to my answer</button>` : '';
  const cited = sources.length ? `<ul class="research-sources">${sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> · ${esc(s.note)}</li>`).join('')}</ul>` : '';
  return `<details class="question-help question-research" data-help="${esc(job.id)}" data-editor="help-${esc(job.id)}"${seen.has(job.id) ? '' : ' open'}><summary>${job.stale ? 'Earlier research' : 'Research from your agent, not your answer'}</summary>${job.stale ? '<p class="form-note">The question or its context changed since. Ask again for current research.</p>' : ''}${summary ? `<p class="question-help-text">${esc(summary)}</p>` : ''}${optionCardsHtml(job.result, esc, copy)}${cited}</details>`;
}
// Tidy my wording (Z3), under the answer box: what the agent is doing, or the tidied wording beside the user's
// own, with Use this wording and Keep mine. Using it only changes the draft; Restore my wording undoes that.
export function questionTidyHtml({ question, jobs, listening, draft, restorable = false, esc }) {
  const { pending, latest } = questionJobs(jobs, TIDY, question.id), id = esc(question.id);
  if (pending) return `<p class="question-help-status">${waitingWords(pending, listening, 'tidying your wording')} <button type="button" class="text-button" data-stop-job="${esc(pending.id)}">Stop</button></p><p class="form-note">Until you use or keep the result, your draft is stored in the map file.</p>`;
  const restore = restorable ? `<button type="button" class="text-button" data-tidy-restore="${id}">Restore my wording</button>` : '';
  const last = jobs.filter(job => job.type === TIDY && job.subjectId === question.id).at(-1);
  if (last?.status === 'failed' || last?.status === 'interrupted') return `<p class="form-note">Your agent could not tidy this wording. Try again from the ⋯ menu.</p>${restore}`;
  if (!latest || latest.stale || latest.outcome || !latest.result) return restore;
  const changed = (draft ?? '').trim() !== latest.input?.text ? '<p class="form-note">You changed your answer since asking. Using this replaces what you have now.</p>' : '';
  return `<div class="tidy-proposal" role="status"><p><strong>Your wording</strong> ${esc(latest.input?.text ?? '')}</p><p><strong>Tidied</strong> ${esc(latest.result.text)}</p>${latest.result.changes ? `<p class="form-note">${esc(latest.result.changes)}</p>` : ''}${changed}<div class="question-actions"><button type="button" class="secondary" data-tidy-use="${esc(latest.id)}" data-question-id="${id}">Use this wording</button><button type="button" class="text-button" data-tidy-keep="${esc(latest.id)}" data-question-id="${id}">Keep mine</button></div></div>${restore}`;
}
// Whether a tidied wording for `nodeId` arrived between two snapshots, so it can be announced while the user types.
export function tidyArrived(before, after, nodeId) {
  const done = jobs => new Set((jobs || []).filter(job => job.type === TIDY && job.nodeId === nodeId && job.status === 'completed' && job.result).map(job => job.id));
  const earlier = done(before);
  return [...done(after)].some(id => !earlier.has(id));
}
// The suggested answer to copy from one option of current research, or null.
export function researchSuggestion(jobs, jobId, optionId) {
  const job = (jobs || []).find(item => item.id === jobId && item.type === RESEARCH && item.status === 'completed' && !item.stale);
  return job?.result?.options?.find(option => option.id === optionId)?.suggestedAnswer ?? null;
}
// Git status for the open map (H9), in plain words. Unknown states fall back to the plain saved label.
export function gitStatusLabel(status) {
  switch (status?.state) {
    case 'committed': return status.branch ? `Saved · committed on ${status.branch}` : 'Saved · committed';
    case 'not-committed': return 'Saved locally · not committed';
    // A map.json with conflict markers cannot be opened, so an open map in conflict is resolved but not yet staged.
    case 'conflict': return 'Git conflict · merge not finished';
    case 'no-repository': return 'Saved locally · no Git repository';
    case 'ignored': return 'Saved locally · ignored by Git';
    default: return 'Saved in this repo';
  }
}
// What hovering or focusing the label shows: the branch, how it compares with its upstream, and when this was checked.
export function gitStatusDetail(status) {
  if (status?.state === 'no-repository') return 'This map is not inside a Git repository.';
  if (!status || status.state === 'unknown') return 'Git status could not be checked. Click to try again.';
  const change = status.state === 'conflict' ? 'Git still lists map.json as unmerged. Once its content is right, stage it (git add) and finish the merge'
    : status.state !== 'not-committed' ? null
    : status.untracked ? 'New, never committed' : status.staged && status.unstaged ? 'Staged, with further changes' : status.staged ? 'Staged, not committed' : 'Changed, not staged';
  const branch = status.branch ? `Branch ${status.branch}` : 'Detached HEAD';
  const upstream = !status.upstream ? 'no upstream' : status.upstream.gone ? 'its upstream branch is gone' : `${status.upstream.ahead} ahead, ${status.upstream.behind} behind its upstream`;
  const when = status.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
  return [[change, branch, upstream].filter(Boolean).join(' · '), when, 'Explore does not fetch, so the remote may be newer. Click to check again.'].filter(Boolean).join('. ');
}
// How long to wait before asking Git again: at once when forced or for another map, otherwise at most once
// every 10 seconds per map, so saves close together share one check at the end of the window.
export function gitCheckDelay({ last, mapId, now, force = false, every = 10000 }) {
  return force || last?.mapId !== mapId ? 0 : Math.max(0, every - (now - last.at));
}

// How a connection reads from one idea's side (D1): "Depends on X" from the dependent, "Needed by X" from the other.
export const outgoing = { depends_on: 'Depends on', supports: 'Supports', contradicts: 'Contradicts', related_to: 'Related to' };
const incoming = { depends_on: 'Needed by', supports: 'Supported by', contradicts: 'Contradicted by', related_to: 'Related to' };
export const connectionLabel = (edge, nodeId) => (edge.from === nodeId ? outgoing : incoming)[edge.type];
// Connected thinking: each link with its direction; one the user added shows its note and, while live, Remove.
// Nothing at all when the idea has no links.
export function connectionsHtml(node, map, { esc, live }) {
  const html = map.edges.filter(edge => edge.type !== 'contains' && (edge.from === node.id || edge.to === node.id)).map(edge => {
    const other = map.nodes.find(item => item.id === (edge.from === node.id ? edge.to : edge.from)); if (!other) return '';
    const remove = live && edge.addedBy === 'user' ? `<button type="button" class="text-button" data-unlink data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" data-relation="${esc(edge.type)}">Remove</button>` : '';
    return `<div class="connection"><button class="relationship" data-select="${esc(other.id)}">${connectionLabel(edge, node.id)}<strong>${esc(other.title)}</strong></button>${edge.addedBy === 'user' && edge.note ? `<p class="form-note">${esc(edge.note)}</p>` : ''}${remove}</div>`;
  }).join('');
  return html ? `<h3 class="section-label">Connected thinking</h3>${html}` : '';
}
// Add a connection: what kind, to which idea (any other in the map), and an optional note. It is opened from the
// idea's ⋯ menu (`shown`), keeps what the user typed across re-renders (`drafts`), and warns while any branch
// investigation is running, since work that reads either idea would then come back for review.
export function linkEditorHtml(node, map, { esc, drafts = {}, shown = false }) {
  const working = map.jobs.some(job => job.status === 'running' && isInvestigationJob(job));
  const others = map.nodes.filter(item => item.id !== node.id).sort((a, b) => a.title.localeCompare(b.title));
  const id = esc(node.id), draft = key => drafts[`${key}-${node.id}`];
  const option = (value, label, chosen) => `<option value="${esc(value)}"${chosen === value ? ' selected' : ''}>${label}</option>`;
  return `<details data-editor="link"${shown ? ' open' : ' hidden'}><summary>Add a connection</summary><form id="link-form" data-node-id="${id}"><label for="link-relation-${id}">This idea</label><select id="link-relation-${id}" name="relation" data-draft="link-relation-${id}">${Object.entries(outgoing).map(([value, label]) => option(value, label.toLowerCase(), draft('link-relation') ?? 'depends_on')).join('')}</select><label for="link-to-${id}">Which idea</label><select id="link-to-${id}" name="to" data-draft="link-to-${id}" required><option value="">Choose an idea…</option>${others.map(other => option(other.id, esc(other.title), draft('link-to'))).join('')}</select><label for="link-note-${id}">Why (optional)</label><textarea id="link-note-${id}" name="note" rows="2" maxlength="1000" data-draft="link-note-${id}">${esc(draft('link-note') ?? '')}</textarea>${working ? '<p class="form-note">Your agent is exploring a branch now. If that work reads either idea, its result will come back for review instead of being applied.</p>' : ''}<button class="secondary" type="submit">Add connection</button></form></details>`;
}
// The idea ⋯ menu (H2): Copy link.
// `items`: more menu items from features that own them, such as "Set when it’s done" (K4).
export function nodeMenuHtml(node, { esc, live = false, items = [] }) {
  const id = esc(node.id);
  return menuHtml(id, 'More for this idea', [`<button type="button" role="menuitem" tabindex="-1" data-copy-link="${id}">Copy link</button>`, ...(live ? [`<button type="button" role="menuitem" tabindex="-1" data-link-open>Add a connection</button>`] : []), ...items.filter(Boolean)]);
}

// Which ideas a view shows (Z6). Every idea except those below an effective fold. With branch `focus`, only the
// starting idea, the path down to the focused idea and its subtree; folds on that path (`locked`) are ignored, so
// folds apply only inside the subtree. The starting idea is never hidden; ideas outside the tree (a missing parent or a
// loop of parents) stay shown unless a branch is focused. Unknown or malformed IDs are ignored.
// Returns { shown: Set, hiddenBelow: Map of a folded idea's ID → { total, needsAnswer, needsReview, working },
// folded: Set of the folds in effect, locked: Set of path ideas that cannot fold here, focus: ID or null }.
export function shownNodes(map, { folded = [], focus = null } = {}) {
  const byId = new Map(map.nodes.map(node => [node.id, node]));
  const folds = new Set((Array.isArray(folded) ? folded : []).filter(id => typeof id === 'string' && byId.has(id)));
  let allowed = null;
  const locked = new Set(), centre = focus && byId.has(focus) ? focus : null;
  if (centre) {
    allowed = new Set([map.rootId, ...branchIds(map, centre)]);
    locked.add(map.rootId);
    for (let at = byId.get(byId.get(centre).parentId); at && !locked.has(at.id) && at.id !== centre; at = byId.get(at.parentId)) { allowed.add(at.id); locked.add(at.id); }
  }
  const ok = id => !allowed || allowed.has(id);
  const active = new Set([...folds].filter(id => ok(id) && !locked.has(id))), below = id => [...branchIds(map, id)].filter(other => other !== id && ok(other));
  const hidden = new Set();
  for (const id of active) for (const other of below(id)) hidden.add(other);
  const shown = new Set(map.nodes.map(node => node.id).filter(id => ok(id) && !hidden.has(id))), hiddenBelow = new Map();
  for (const id of active) {
    const under = shown.has(id) ? below(id).map(other => byId.get(other)) : [];
    if (under.length) hiddenBelow.set(id, { total: under.length, needsAnswer: under.filter(node => node.status === 'awaiting-answer').length,
      needsReview: under.filter(node => node.stale).length, working: under.filter(node => node.status === 'queued' || node.status === 'running').length });
  }
  return { shown, hiddenBelow, folded: active, locked, focus: centre };
}

// Find an idea's rule, which the command palette shares: the title or summary contains the text, ignoring case.
export function ideaMatches(nodes, query) {
  const text = String(query ?? '').trim().toLowerCase();
  return nodes.filter(node => `${node.title} ${node.summary || ''}`.toLowerCase().includes(text));
}
// The command palette's results: available actions whose label contains the text, then, once there is text, up to
// 12 matching ideas.
export function commandResults(commands, nodes, query) {
  const text = String(query ?? '').trim().toLowerCase(), ideas = text ? ideaMatches(nodes, text) : [];
  return { actions: commands.filter(command => command.label.toLowerCase().includes(text)), ideas: ideas.slice(0, 12), ideaTotal: ideas.length };
}
// Text compared the way people read it: case, repeated whitespace and trailing punctuation ignored.
export const comparableText = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?.!,;:…]+$/, '');
// The title of one of an idea's sources by its URL, or the URL itself when the idea no longer lists it.
export const sourceTitle = (node, url) => node.sources?.find(source => source.url === url)?.title ?? url;
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
  return treeOrder(map).filter(({ node }) => node.stale).map(({ node }) => node.id);
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
    if (c.kind === 'branch-restored') return `${source(c.sourceId)} was restored from an earlier version${c.at ? ` on ${esc(shortDate(c.at))}` : ''}.`;
    if (c.kind === 'restored-context-changed') return `This idea was restored from an earlier version, and ${source(c.sourceId)}, which it relied on, has changed since${c.at ? ` (${esc(shortDate(c.at))})` : ''}.`;
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
