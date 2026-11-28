// Thought inbox (K8): rough thoughts jotted on a map without deciding where they go. When the user asks, the agent
// proposes a place for each (a new suggested branch, or a note on an idea); the user accepts or dismisses each one.
// Nothing is placed, and nothing runs, until the user says so. Shared by the Store and the app; it imports nothing.
export const SORT_THOUGHTS = 'sort-thoughts';
export const thoughtMax = 4000, maxOpenThoughts = 200, maxSorted = 20;
const isOpenJob = job => job.status === 'queued' || job.status === 'running';

// The open thoughts, oldest first; anything unreadable in a pulled map is skipped (the validator reports it).
export const openThoughts = map => (Array.isArray(map.inbox) ? map.inbox.filter(thought => thought && thought.state === 'open' && typeof thought.text === 'string') : []);
// The newest proposal of where thoughts belong.
export const sortProposalFor = map => (map.proposals ?? []).filter(proposal => proposal.type === SORT_THOUGHTS).at(-1) ?? null;
// The newest unreviewed proposal item for a thought, with its proposal.
export function proposalItemFor(map, thought) {
  for (const proposal of [...(map.proposals ?? [])].reverse()) {
    if (proposal.type !== SORT_THOUGHTS) continue;
    const item = proposal.items.find(entry => entry.thoughtId === thought.id && entry.review === 'unreviewed');
    if (item) return { proposal, item };
  }
  return null;
}

// The inspector: an idea's notes, the user's own words placed from the inbox.
export function notesHtml(node, { esc }) {
  const notes = Array.isArray(node.notes) ? node.notes.filter(note => typeof note?.text === 'string') : [];
  return notes.length ? `<h3 class="section-label">Your notes</h3><ul class="idea-notes">${notes.map(note => `<li>${esc(note.text)}</li>`).join('')}</ul>` : '';
}

// The inbox dialog's body: open thoughts, each with Edit and Discard and the agent's proposal if any, then the request
// (Ask the agent where these belong, its preview, or the work waiting). `editing` is the thought being edited.
export function inboxHtml({ map, esc, live, editing, preview, listening }) {
  const titles = new Map(map.nodes.map(node => [node.id, node.title])), thoughts = openThoughts(map);
  const show = id => (titles.has(id) ? `<button type="button" class="text-button" data-focus-node="${esc(id)}">Show “${esc(titles.get(id))}”</button>` : '');
  const proposal = thought => {
    const found = proposalItemFor(map, thought); if (!found) return '';
    const { proposal: { id: proposalId }, item } = found, dismiss = live ? `<button type="button" class="text-button" data-dismiss-item="${esc(item.id)}" data-proposal="${esc(proposalId)}">Dismiss</button>` : '';
    const accept = live ? `<button type="button" class="secondary" data-place-thought="${esc(item.id)}" data-proposal="${esc(proposalId)}">Accept</button>` : '';
    if (item.thoughtText !== thought.text) return `<div class="thought-proposal"><p>This thought changed since your agent sorted it.</p>${dismiss}</div>`;
    if (item.action === 'unplaced') return `<div class="thought-proposal"><p>Your agent could not place it: ${esc(item.reason)}</p>${dismiss}</div>`;
    const where = item.action === 'new-branch' ? `a new branch under “${esc(titles.get(item.parentId) ?? item.parentId)}”: ${esc(item.title)}` : `a note on “${esc(titles.get(item.nodeId) ?? item.nodeId)}”. ${esc(item.reason)}`;
    return `<div class="thought-proposal"><p>Your agent suggests ${where}</p>${show(item.action === 'new-branch' ? item.parentId : item.nodeId)} ${accept} ${dismiss}</div>`;
  };
  const row = thought => (editing === thought.id && live
    ? `<li class="thought"><label for="thought-edit" class="visually-hidden">Edit this thought</label><textarea id="thought-edit" maxlength="${thoughtMax}" rows="3">${esc(thought.text)}</textarea><div class="glossary-actions"><button type="button" class="primary" data-thought-save="${esc(thought.id)}">Save</button><button type="button" class="text-button" data-thought-cancel="">Cancel</button></div></li>`
    : `<li class="thought"><p class="thought-text">${esc(thought.text)}</p>${live ? `<div class="glossary-actions"><button type="button" class="text-button" data-thought-edit="${esc(thought.id)}">Edit</button><button type="button" class="text-button" data-thought-discard="${esc(thought.id)}">Discard</button></div>` : ''}${proposal(thought)}</li>`);
  const pending = (map.jobs ?? []).find(job => job.type === SORT_THOUGHTS && isOpenJob(job)), count = Math.min(thoughts.length, maxSorted);
  const request = !live || !thoughts.length ? ''
    : pending ? `<p class="question-help-status" role="status">${pending.status === 'running' ? 'Your agent is sorting these thoughts.' : listening ? 'Your agent will pick this up next.' : 'Queued for your agent.'} <button type="button" class="text-button" data-inbox-stop="${esc(pending.id)}">Stop</button></p>`
    : preview ? `<div class="inbox-preview"><p>Your agent will read ${count === 1 ? '1 open thought' : `${count} open thoughts`} and an index of ${map.nodes.length === 1 ? '1 idea' : `${map.nodes.length} ideas`} (titles, kinds, status and a short summary). Nothing else is sent, and nothing is placed until you accept it.${thoughts.length > maxSorted ? ` The oldest ${maxSorted} go first.` : ''}</p><div class="brief-actions"><button type="button" class="primary" data-inbox-send="">Send to your agent</button><button type="button" class="text-button" data-inbox-cancel="">Cancel</button></div></div>`
    : '<button type="button" class="primary" data-inbox-sort="">Ask the agent where these belong</button>';
  return `${thoughts.length ? `<ul class="inbox-thoughts">${thoughts.map(row).join('')}</ul>` : '<p class="form-note">No open thoughts. Jot one down above.</p>'}${request}`;
}
