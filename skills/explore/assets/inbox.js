// Thought inbox (K8): rough thoughts jotted on a map without deciding where they go. When the user asks, the agent
// proposes a place for each (a new suggested branch, or a note on an idea); the user accepts or dismisses each one.
// Nothing is placed, and nothing runs, until the user says so. Shared by the Store and the app.
import { proposalsOf, waitingWords } from './workspace-view.js';

export const SORT_THOUGHTS = 'sort-thoughts';
export const thoughtMax = 4000, maxOpenThoughts = 200, maxSorted = 20;
const isOpenJob = job => job.status === 'queued' || job.status === 'running';
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A thought's text as a short key: a proposal keeps it, so it can tell when the thought changed since it was sorted.
export const textKey = text => { let a = 0x811c9dc5, b = 5381; for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = (Math.imul(b, 33) + c) | 0; } return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0'); };
// The open thoughts, oldest first; anything unreadable in a pulled map is skipped (the validator reports it).
export const openThoughts = map => (Array.isArray(map.inbox) ? map.inbox.filter(thought => thought && thought.state === 'open' && typeof thought.text === 'string') : []);
// An idea's notes, the user's own words placed from the inbox; anything unreadable is skipped.
export const notesOf = node => (Array.isArray(node.notes) ? node.notes.filter(note => typeof note?.text === 'string') : []);
// The newest proposal item about a thought, with its proposal, whatever its review.
function newestItem(map, thought) {
  for (const proposal of [...proposalsOf(map, SORT_THOUGHTS)].reverse()) {
    const item = proposal.items.find(entry => entry.thoughtId === thought.id);
    if (item) return { proposal, item };
  }
  return null;
}
// The proposal waiting for the user about a thought: only the newest one about it, while it is unreviewed. A dismissed
// suggestion never brings back an older one.
export function proposalItemFor(map, thought) {
  const found = newestItem(map, thought);
  return found?.item.review === 'unreviewed' ? found : null;
}
// The thoughts to send, in order: never sorted first, then those whose suggestion was set aside or which changed since;
// oldest first within each, so every thought gets its turn. A thought whose suggestion still waits is not sent again.
export function sortOrder(map) {
  const rank = thought => { const found = newestItem(map, thought); return !found ? 0 : found.item.review === 'unreviewed' && found.item.textKey === textKey(thought.text) ? 2 : 1; };
  return openThoughts(map).map((thought, index) => ({ thought, index, rank: rank(thought) })).filter(entry => entry.rank < 2).sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.thought);
}

// The inspector: an idea's notes, the user's own words placed from the inbox.
export function notesHtml(node, { esc }) {
  const notes = notesOf(node);
  return notes.length ? `<h3 class="section-label">Your notes</h3><ul class="idea-notes">${notes.map(note => `<li>${esc(note.text)}</li>`).join('')}</ul>` : '';
}

// What the agent will read, from F1's job preview of the packet itself.
export function previewText(packet) {
  const read = packet.thoughts.length, left = packet.remainingThoughts ?? 0, total = packet.ideas.length + (packet.omittedIdeas ?? 0), terms = packet.glossary?.length ?? 0;
  const extras = [packet.goal ? 'the map\'s goal' : '', terms ? count(terms, 'agreed term') : ''].filter(Boolean);
  return `Your agent will read ${count(read, 'thought')} in full${left ? ` (${count(left, 'more waits', 'more wait')} for a later sort)` : ''} and an index of ${packet.omittedIdeas ? `${packet.ideas.length} of ${total} ideas` : count(total, 'idea')} (titles, kinds, status and a short summary)${extras.length ? `, with ${extras.join(' and ')}` : ''}. Nothing is placed until you accept it.`;
}

// The inbox dialog's body: open thoughts, each with Edit and Discard and the agent's suggestion if any, then the request
// (Ask the agent where these belong, the preview of what it reads, the work waiting, or why the last sort failed).
// `editing` is the thought being edited; `preview` the job preview's packet; `readOnly` the history note, when not live.
export function inboxHtml({ map, esc, live, editing, preview, listening, readOnly = '' }) {
  const titles = new Map(map.nodes.map(node => [node.id, node.title])), thoughts = openThoughts(map);
  const idea = id => (titles.has(id) ? `“${esc(titles.get(id))}”` : 'a removed idea');
  const show = (id, thought) => (titles.has(id) ? `<button type="button" class="text-button" id="show-${esc(thought.id)}" data-focus-node="${esc(id)}">Show ${idea(id)}</button>` : '');
  const about = thought => `aria-describedby="thought-text-${esc(thought.id)}"`;
  const suggestion = thought => {
    const found = proposalItemFor(map, thought); if (!found) return '';
    const { proposal: { id: proposalId }, item } = found;
    const dismiss = live ? `<button type="button" class="text-button" data-dismiss-item="${esc(item.id)}" data-proposal="${esc(proposalId)}" data-thought="${esc(thought.id)}" ${about(thought)}>Dismiss</button>` : '';
    if (item.textKey !== textKey(thought.text)) return `<div class="thought-proposal"><p>This thought changed since your agent sorted it. Ask again to place it.</p>${dismiss}</div>`;
    if (item.action === 'unplaced') return `<div class="thought-proposal"><p>Your agent could not place it: ${esc(item.reason)}</p>${dismiss}</div>`;
    const accept = live ? `<button type="button" class="secondary" data-place-thought="${esc(item.id)}" data-proposal="${esc(proposalId)}" data-thought="${esc(thought.id)}" ${about(thought)}>Accept</button>` : '';
    const where = item.action === 'new-branch' ? `a new branch under ${idea(item.parentId)}: <strong>${esc(item.title)}</strong></p><p class="form-note">${esc(item.body)}` : `a note on ${idea(item.nodeId)}. ${esc(item.reason)}`;
    return `<div class="thought-proposal"><p>Your agent suggests ${where}</p>${show(item.action === 'new-branch' ? item.parentId : item.nodeId, thought)} ${accept} ${dismiss}</div>`;
  };
  const row = thought => (editing === thought.id && live
    ? `<li class="thought" id="thought-${esc(thought.id)}"><label for="thought-edit" class="visually-hidden">Edit this thought</label><textarea id="thought-edit" maxlength="${thoughtMax}" rows="3">${esc(thought.text)}</textarea><div class="glossary-actions"><button type="button" class="primary" data-thought-save="${esc(thought.id)}">Save</button><button type="button" class="text-button" data-thought-cancel="${esc(thought.id)}">Cancel</button></div></li>`
    : `<li class="thought" id="thought-${esc(thought.id)}"><p class="thought-text" id="thought-text-${esc(thought.id)}">${esc(thought.text)}</p>${live ? `<div class="glossary-actions"><button type="button" class="text-button" data-thought-edit="${esc(thought.id)}" ${about(thought)}>Edit</button><button type="button" class="text-button" data-thought-discard="${esc(thought.id)}" ${about(thought)}>Discard</button></div>` : ''}${suggestion(thought)}</li>`);
  const sorts = (map.jobs ?? []).filter(job => job.type === SORT_THOUGHTS), pending = sorts.find(isOpenJob), last = sorts.at(-1);
  const failed = last && (last.status === 'failed' || last.status === 'interrupted') ? `<p class="state-note warning" id="inbox-status" tabindex="-1">Your agent could not sort these thoughts. ${esc(last.error ?? 'It stopped before it finished.')}</p>` : '';
  const request = !live || !thoughts.length ? ''
    : pending ? `<p class="question-help-status" id="inbox-status" tabindex="-1" role="status">${waitingWords(pending, listening, 'sorting these thoughts')} <button type="button" class="text-button" data-inbox-stop="${esc(pending.id)}">Stop</button></p>`
    : preview ? `<div class="inbox-preview"><p>${esc(previewText(preview))}</p><div class="brief-actions"><button type="button" class="primary" data-inbox-send="">Send to your agent</button><button type="button" class="text-button" data-inbox-cancel="">Cancel</button></div></div>`
    : !sortOrder(map).length ? '<p class="form-note">Every thought has a suggestion waiting for you.</p>'
    : `${failed}<button type="button" class="primary" data-inbox-sort="">Ask the agent where these belong</button>`;
  const note = live ? '' : `<p class="form-note">${esc(readOnly)} Return to the live map to add or place thoughts.</p>`;
  return `${note}${thoughts.length ? `<ul class="inbox-thoughts">${thoughts.map(row).join('')}</ul>` : '<p class="form-note">No open thoughts. Jot one down above.</p>'}${request}`;
}
