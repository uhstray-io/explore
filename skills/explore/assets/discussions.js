// Comment threads (H6): people sharing a map through Git question a finding, ask about an answer or leave context on an
// idea, and reply. Threads are saved in the map and can be resolved and reopened. A comment is never an answer: it
// unblocks no question, changes no work state and never reaches the agent's work. Shared by the Store and the app.

export const discussionLimits = { text: 4000, messages: 50, threads: 200 };
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
// The map's threads. Validation refuses a map whose threads the views cannot read; anything else is skipped here.
export const threadsOf = map => (Array.isArray(map?.discussions?.threads) ? map.discussions.threads.filter(thread => isRecord(thread) && Array.isArray(thread.messages)) : []);
export const isOpenThread = thread => thread.status === 'open';
// An idea's threads: open ones first, each group oldest first.
export const nodeThreads = (map, nodeId) => { const own = threadsOf(map).filter(thread => thread.nodeId === nodeId); return [...own.filter(isOpenThread), ...own.filter(thread => !isOpenThread(thread))]; };
// Who wrote a message and when, as the card shows it: "Ana · 4 Nov, 10:00".
export const messageMeta = message => { const at = new Date(message.at); return `${message.by?.name ?? 'Someone'}${Number.isNaN(at.getTime()) ? '' : ` · ${at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}`; };
const replyKey = threadId => `discussion-reply:${threadId}`, newKey = nodeId => `discussion-new:${nodeId}`;

// The idea's Discussion section, below its questions: open threads, each with its messages as literal text and a reply
// box, then resolved ones, collapsed; and "Start a discussion". Typed text is kept as drafts through a redraw. Read-only
// when not `live`; nothing at all in history when there is nothing to read.
export function discussionHtml(map, node, { esc, live, drafts = {} }) {
  const threads = nodeThreads(map, node.id), open = threads.filter(isOpenThread), resolved = threads.filter(thread => !isOpenThread(thread));
  if (!live && !threads.length) return '';
  const nodeId = esc(node.id);
  const messages = thread => `<ol class="discussion-messages">${thread.messages.map(message => `<li><p class="discussion-meta">${esc(messageMeta(message))}</p><p class="discussion-text">${esc(message.text)}</p></li>`).join('')}</ol>`;
  const reply = thread => (live ? `<form class="discussion-reply" data-reply-form="${esc(thread.id)}" data-node-id="${nodeId}"><label for="reply-${esc(thread.id)}">Reply</label><textarea id="reply-${esc(thread.id)}" name="text" rows="2" maxlength="${discussionLimits.text}" required data-draft="${esc(replyKey(thread.id))}">${esc(drafts[replyKey(thread.id)] ?? '')}</textarea>`
    + `<div class="detail-actions"><button type="submit" class="secondary">Reply</button><button type="button" class="text-button" data-discussion-resolve="${esc(thread.id)}" data-node-id="${nodeId}">Resolve</button></div></form>` : '');
  const reopen = thread => (live ? `<button type="button" class="text-button" data-discussion-reopen="${esc(thread.id)}" data-node-id="${nodeId}">Reopen</button>` : '');
  const start = live ? `<details data-editor="discussion"><summary>Start a discussion</summary><form id="discussion-form" data-node-id="${nodeId}"><p class="form-note">For people sharing this map. A comment is never an answer, and your agent never reads it.</p>`
    + `<label for="discussion-text">Comment</label><textarea id="discussion-text" name="text" rows="3" maxlength="${discussionLimits.text}" required data-draft="${esc(newKey(node.id))}">${esc(drafts[newKey(node.id)] ?? '')}</textarea><button type="submit" class="secondary">Comment</button></form></details>` : '';
  return `<section class="discussion" aria-labelledby="discussion-heading-${nodeId}"><h3 class="section-label" id="discussion-heading-${nodeId}" tabindex="-1">Discussion</h3>`
    + open.map(thread => `<article class="discussion-thread" data-thread="${esc(thread.id)}">${messages(thread)}${reply(thread)}</article>`).join('')
    + (resolved.length ? `<details class="discussion-resolved" data-editor="discussion-resolved"><summary>Resolved (${resolved.length})</summary>${resolved.map(thread => `<article class="discussion-thread resolved" data-thread="${esc(thread.id)}">${messages(thread)}${thread.resolvedBy?.name ? `<p class="form-note">Resolved by ${esc(thread.resolvedBy.name)}.</p>` : ''}${reopen(thread)}</article>`).join('')}</details>` : '')
    + start + '</section>';
}
// The action a submitted discussion form asks for, or null for any other form.
export function discussionRequest(form, data) {
  if (form.id === 'discussion-form') return { type: 'comment', input: { text: data.text } };
  if (form.dataset?.replyForm) return { type: 'comment', input: { text: data.text, threadId: form.dataset.replyForm } };
  return null;
}
// Resolve and Reopen. True when the click was one of these. Focus stays in the section: on its heading after resolving,
// in the reply box of a thread just reopened.
export async function discussionClick(event, { act, toast, renderDetail }) {
  const focus = selector => document.querySelector(`#detail ${selector}`)?.focus();
  const resolve = event.target.closest('[data-discussion-resolve]'), reopen = resolve ? null : event.target.closest('[data-discussion-reopen]');
  const target = resolve ?? reopen; if (!target) return false;
  const threadId = resolve ? target.dataset.discussionResolve : target.dataset.discussionReopen, nodeId = target.dataset.nodeId;
  target.disabled = true;
  if (await act(nodeId, resolve ? 'resolve-discussion' : 'reopen-discussion', { threadId })) {
    toast(resolve ? 'Resolved.' : 'Reopened.'); renderDetail(true);
    focus(resolve ? `#discussion-heading-${nodeId}` : `[data-reply-form="${threadId}"] textarea`);
  }
  target.disabled = false;
  return true;
}
// The "Open discussions" progress filter: every idea with an open thread. Built per map, as Assigned is.
export function openDiscussionsFilter(map) {
  return { id: 'discussions', kind: 'progress', label: 'Open discussions', empty: 'No discussion is open.', matches: node => threadsOf(map).some(thread => thread.nodeId === node.id && isOpenThread(thread)),
    lines: node => { const open = threadsOf(map).filter(thread => thread.nodeId === node.id && isOpenThread(thread)); return open.length ? [{ text: `${open.length} open discussion${open.length === 1 ? '' : 's'}; latest from ${messageMeta(open.flatMap(thread => thread.messages).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) ?? {})}` }] : []; } };
}
