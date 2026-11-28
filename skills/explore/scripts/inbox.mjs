// Thought inbox (K8) in the Store: capturing thoughts (no agent needed), the sort-thoughts map job that proposes where
// each belongs, and placing an accepted proposal. Only the user places a thought; suggestions stay inactive.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { treeOrder } from '../assets/graph.js';
import { SORT_THOUGHTS, thoughtMax, maxOpenThoughts, maxSorted, openThoughts } from '../assets/inbox.js';
import { nodeKinds } from './map-validation.mjs';

class InboxProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new InboxProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const thoughtText = value => textField(typeof value === 'string' ? value.trim() : value, 'A thought', thoughtMax, message => need(false, message));
const openThought = (map, id) => { const thought = (map.inbox ?? []).find(item => item.id === id); need(thought, 'Thought not found.', 404); need(thought.state === 'open', 'This thought was already placed or discarded.', 409); return thought; };

export const inboxActions = {
  'inbox-add': { target: 'map', apply: ({ map, input, store }) => {
    need(openThoughts(map).length < maxOpenThoughts, `The inbox holds at most ${maxOpenThoughts} open thoughts. Place or discard some first.`, 409);
    map.inbox = [...(Array.isArray(map.inbox) ? map.inbox : []), { id: `thought-${randomUUID().slice(0, 8)}`, text: thoughtText(input.text), createdAt: new Date().toISOString(), state: 'open' }];
    store.event(map, 'thought-added', null, map.inbox.at(-1).id);
  } },
  'inbox-edit': { target: 'map', apply: ({ map, input, store }) => {
    const thought = openThought(map, input.thoughtId), text = thoughtText(input.text);
    need(text !== thought.text, 'Nothing changed.', 409);
    thought.text = text;
    store.event(map, 'thought-edited', null, thought.id);
  } },
  'inbox-discard': { target: 'map', apply: ({ map, input, store }) => {
    const thought = openThought(map, input.thoughtId);
    Object.assign(thought, { state: 'discarded', discardedAt: new Date().toISOString() });
    store.event(map, 'thought-discarded', null, thought.id);
  } },
  // Accept one proposal item: a new suggested branch through the same path as Add a direction, or the thought's own
  // words as a note on an idea. A note changes no content, flags nothing and never reopens a finished branch.
  'place-thought': { target: 'map', apply: ({ map, input, store }) => {
    const proposal = (map.proposals ?? []).find(item => item.id === input.proposalId && item.type === SORT_THOUGHTS), item = proposal?.items.find(entry => entry.id === input.itemId);
    need(item, 'That proposal no longer exists.', 404);
    need(item.review === 'unreviewed', 'This proposal was already accepted or dismissed.', 409);
    need(item.action !== 'unplaced', 'Your agent could not place this thought, so it can only be dismissed.', 409);
    const thought = openThought(map, item.thoughtId);
    need(thought.text === item.thoughtText, 'This thought changed since your agent sorted it. Ask again to place it.', 409);
    const at = new Date().toISOString();
    let target;
    if (item.action === 'new-branch') {
      const parent = map.nodes.find(node => node.id === item.parentId); need(parent, 'The idea it would go under no longer exists.', 409);
      target = store.node(item.title, item.body, item.kind ?? 'research', parent.id);
      const edge = { from: parent.id, to: target.id, type: 'contains' };
      map.nodes.push(target); map.edges.push(edge); store.recordGrowth(map, [target], [edge]);
      store.event(map, 'suggested', target.id, 'A thought from the inbox became a direction; not yet activated.');
    } else {
      target = map.nodes.find(node => node.id === item.nodeId); need(target, 'The idea it would go on no longer exists.', 409);
      target.notes = [...(Array.isArray(target.notes) ? target.notes : []), { id: `note-${randomUUID().slice(0, 8)}`, text: thought.text, createdAt: at, fromThought: thought.id }];
    }
    Object.assign(thought, { state: 'placed', placedAt: at, placement: { action: item.action, nodeId: target.id } });
    Object.assign(item, { review: 'accepted', reviewedAt: at });
    store.event(map, 'thought-placed', target.id, `${thought.id}: ${item.action}`);
  } },
};

// The packet: the thoughts in full and a bounded index of ideas in reading order; omitted ideas are counted.
function sortPacket({ map, job, budget }) {
  const ids = new Set(job.input.thoughtIds), thoughts = (map.inbox ?? []).filter(item => ids.has(item.id)).map(item => ({ id: item.id, text: item.text }));
  const ideas = treeOrder(map).map(({ node }) => ({ id: node.id, title: clip(node.title, 100), kind: node.kind, status: node.status, completed: node.status === 'explored' || !!node.completedAt, summary: clip(node.summary, 200) }));
  const packet = { thoughts, ideas, omittedIdeas: 0, retrieval: 'Use CLI read --map MAP --query TEXT to find more ideas, and read --map MAP --node NODE for one.', instruction };
  const limit = budget - 800;
  while (JSON.stringify(packet).length > limit && packet.ideas.length > 1) { packet.ideas.pop(); packet.omittedIdeas++; }
  return packet;
}
const instruction = 'Propose a place for each thought; never activate anything. Return placements: exactly one per thought, { thoughtId, action: "new-branch", parentId, title, body, kind? } to start a suggested branch under an idea, { thoughtId, action: "note", nodeId, reason } to add the thought as the user\'s note on an existing idea, or { thoughtId, action: "unplaced", reason }. Prefer a note when a thought adds to an existing branch, and a new branch when it opens a separate question. A thought that changes a finished premise becomes a new branch, not a note. Only the user accepts a placement.';

function validateSort(result, { map, job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => key !== 'placements');
  need(!extra.length, `Return only placements; remove ${extra.join(', ')}.`);
  const wanted = new Set(job.input.thoughtIds), seen = new Set(), exists = id => map.nodes.some(node => node.id === id);
  need(Array.isArray(result.placements) && result.placements.length === wanted.size, 'Give exactly one placement for every thought.');
  return { placements: result.placements.map((item, index) => {
    const label = `Placement ${index + 1}`;
    need(item && typeof item === 'object' && !Array.isArray(item), `${label} must be an object.`);
    need(wanted.has(item.thoughtId), `${label} names a thought that was not sent.`);
    need(!seen.has(item.thoughtId), `${label} places a thought twice; give exactly one placement for every thought.`); seen.add(item.thoughtId);
    need(['new-branch', 'note', 'unplaced'].includes(item.action), `${label}: action must be new-branch, note or unplaced.`);
    if (item.action === 'new-branch') {
      need(exists(item.parentId), `${label} names an idea that does not exist.`);
      return { thoughtId: item.thoughtId, action: 'new-branch', parentId: item.parentId, title: textField(item.title, `${label} title`, 100, fail), body: textField(item.body, `${label} body`, 4000, fail), kind: nodeKinds.has(item.kind) ? item.kind : 'research' };
    }
    if (item.action === 'note') need(exists(item.nodeId), `${label} names an idea that does not exist.`);
    return { thoughtId: item.thoughtId, action: item.action, ...(item.action === 'note' ? { nodeId: item.nodeId } : {}), reason: textField(item.reason, `${label} reason`, 600, fail) };
  }) };
}

export const inboxJobTypes = {
  [SORT_THOUGHTS]: {
    label: 'Sort thoughts', target: 'map',
    reason: 'The user asked where the inbox thoughts belong.',
    // The open thoughts to sort: the ones the user named, or the oldest 20; their words are kept to spot later edits.
    prepare: ({ map, input }) => {
      const open = openThoughts(map), chosen = input.thoughtIds === undefined ? open.slice(0, maxSorted) : open.filter(thought => input.thoughtIds.includes(thought.id));
      need(chosen.length >= 1 && chosen.length <= maxSorted, `Choose 1 to ${maxSorted} open thoughts.`);
      return { thoughtIds: chosen.map(thought => thought.id), texts: Object.fromEntries(chosen.map(thought => [thought.id, thought.text])) };
    },
    packet: sortPacket,
    validate: validateSort,
    isStale: ({ map, job }) => job.input.thoughtIds.some(id => { const thought = (map.inbox ?? []).find(item => item.id === id); return !thought || thought.state !== 'open' || thought.text !== job.input.texts?.[id]; }),
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: SORT_THOUGHTS, createdAt: at, ...(stale ? { stale: true } : {}),
        items: result.placements.map(item => ({ id: makeId('item'), ...item, thoughtText: job.input.texts?.[item.thoughtId] ?? '', review: 'unreviewed' })) }];
    },
  },
};

// Branch packets carry an idea's notes, labelled as the user's own; node Markdown lists them.
export const notesForPacket = node => (Array.isArray(node.notes) ? node.notes.filter(note => typeof note?.text === 'string').map(note => ({ text: clip(note.text, 600) })) : []);
export const notesInstruction = 'selected.userNotes are the user\'s own notes on this idea: context they want considered, not findings or answers.';
export function noteLines(node) {
  const notes = Array.isArray(node.notes) ? node.notes.filter(note => typeof note?.text === 'string') : [];
  return notes.length ? ['## Your notes', '', '_The user\'s own notes, not findings._', '', ...notes.map(note => `- ${markdownText(note.text)}`)] : [];
}
