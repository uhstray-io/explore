// Comment threads (H6) in the Store: comment (start a thread or reply), resolve and reopen. Each changes only the
// discussions and adds a history event: never an idea's work or review state, its questions, answers or revision, its
// jobs or its growth. A comment is never an answer.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { discussionLimits, threadsOf, nodeThreads, isOpenThread } from '../assets/discussions.js';

class DiscussionProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new DiscussionProblem(message, status); };
const fail = message => need(false, message);
const by = (actor, key = 'by') => (actor?.name ? { [key]: { name: actor.name } } : {});
const id = prefix => `${prefix}-${randomUUID().slice(0, 8)}`;
const threadOf = (map, node, input) => {
  const thread = threadsOf(map).find(entry => entry.id === input.threadId && entry.nodeId === node.id);
  need(thread, 'That discussion no longer exists.', 404);
  return thread;
};

export const discussionActions = {
  // Start a thread, or reply to an open one (`threadId`).
  comment: { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const text = textField(input.text, 'Comment', discussionLimits.text, fail), at = new Date().toISOString();
    const message = { id: id('message'), at, ...by(actor), text };
    if (input.threadId !== undefined) {
      const thread = threadOf(map, node, input);
      need(isOpenThread(thread), 'This discussion is resolved. Reopen it to reply.', 409);
      need(thread.messages.length < discussionLimits.messages, `A discussion holds at most ${discussionLimits.messages} messages. Start a new one.`, 409);
      thread.messages.push(message);
      store.event(map, 'commented', node.id, thread.id);
      return;
    }
    need(threadsOf(map).length < discussionLimits.threads, `A map holds at most ${discussionLimits.threads} discussions. Reply in one that is already there.`, 409);
    map.discussions ??= { version: 1, threads: [] }; // A map that has them already passed validation, so they are kept as they are.
    const thread = { id: id('thread'), nodeId: node.id, createdAt: at, status: 'open', messages: [message] };
    map.discussions.threads.push(thread);
    store.event(map, 'commented', node.id, thread.id);
  } },
  'resolve-discussion': { target: 'node', apply: ({ map, node, input, store, actor }) => {
    const thread = threadOf(map, node, input);
    need(isOpenThread(thread), 'This discussion is already resolved.', 409);
    Object.assign(thread, { status: 'resolved', resolvedAt: new Date().toISOString(), ...by(actor, 'resolvedBy') });
    store.event(map, 'discussion-resolved', node.id, thread.id);
  } },
  'reopen-discussion': { target: 'node', apply: ({ map, node, input, store }) => {
    const thread = threadOf(map, node, input);
    need(!isOpenThread(thread), 'This discussion is already open.', 409);
    thread.status = 'open'; delete thread.resolvedAt; delete thread.resolvedBy;
    store.event(map, 'discussion-reopened', node.id, thread.id);
  } },
};

// Discussions on ideas a restart or a branch restore removes go with them; the version kept before still has them.
export const openThreadsOn = (map, ids) => threadsOf(map).filter(thread => ids.has(thread.nodeId) && isOpenThread(thread)).length;
export function dropThreadsOn(map, ids) {
  if (map.discussions && threadsOf(map).some(thread => ids.has(thread.nodeId))) map.discussions.threads = map.discussions.threads.filter(thread => !ids.has(thread.nodeId));
}
// The `discussion` section of `read --node`: every thread, open first, each labelled as people talking, not an answer.
export const discussionRecords = (map, node) => nodeThreads(map, node.id).map(thread => [`## ${thread.id} (${isOpenThread(thread) ? 'open' : 'resolved'})`,
  'Discussion between people, not an answer.', ...thread.messages.map(message => `${message.by?.name ?? 'Someone'}, ${message.at}: ${message.text}`)].join('\n'));
// The idea's Markdown view (committed with the map): "Discussion (not answers)", each message as literal text, quoted
// line by line.
export function discussionLines(map, node) {
  const threads = nodeThreads(map, node.id);
  if (!threads.length) return [];
  const day = at => (Number.isNaN(new Date(at).getTime()) ? 'an unknown date' : new Date(at).toISOString().slice(0, 10));
  return ['', '## Discussion (not answers)', ...threads.flatMap(thread => ['', `### ${isOpenThread(thread) ? 'Open' : 'Resolved'}, started ${day(thread.createdAt)}`,
    ...thread.messages.flatMap(message => ['', `**${markdownText(message.by?.name ?? 'Someone')}**, ${day(message.at)}:`, '', ...message.text.split(/\r?\n/).map(line => (line.trim() ? `> ${markdownText(line)}` : '>'))])])];
}
