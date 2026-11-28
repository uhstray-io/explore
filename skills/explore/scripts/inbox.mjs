// Thought inbox (K8) in the Store: capturing thoughts (no agent needed), the sort-thoughts map job that proposes where
// each belongs, and placing an accepted proposal. Only the user places a thought; suggestions stay inactive.
import { randomUUID } from 'node:crypto';
import { textField } from './fields.mjs';
import { addDirection, directionKinds } from './directions.mjs';
import { existingChild } from './result-checks.mjs';
import { hypothesisTest } from './hypotheses.mjs';
import { includedKey } from './map-jobs.mjs';
import { isCompleted } from './completion.mjs';
import { markdownText } from '../assets/workspace-view.js';
import { treeOrder } from '../assets/graph.js';
import { SORT_THOUGHTS, thoughtMax, maxOpenThoughts, maxSorted, openThoughts, notesOf, sortOrder, textKey } from '../assets/inbox.js';

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
  // Accept one suggestion: a new suggested branch made as Add a direction makes one, or the thought's own words as a
  // note on an idea. A note changes no content, flags nothing and never reopens a finished branch. User-only.
  'place-thought': { target: 'map', apply: ({ map, input, store, actor }) => {
    const proposal = (map.proposals ?? []).find(item => item.id === input.proposalId && item.type === SORT_THOUGHTS), item = proposal?.items.find(entry => entry.id === input.itemId);
    need(item, 'That proposal no longer exists.', 404);
    need(item.review === 'unreviewed', 'This proposal was already accepted or dismissed.', 409);
    need(item.action !== 'unplaced', 'Your agent could not place this thought, so it can only be dismissed.', 409);
    const thought = openThought(map, item.thoughtId);
    need(textKey(thought.text) === item.textKey, 'This thought changed since your agent sorted it. Ask again to place it.', 409);
    const at = new Date().toISOString();
    let target;
    if (item.action === 'new-branch') {
      const parent = map.nodes.find(node => node.id === item.parentId); need(parent, 'The idea it would go under no longer exists.', 409);
      target = addDirection(store, map, parent, { title: item.title, body: item.body, kind: item.kind, test: item.test }, { detail: 'A thought from the inbox became a direction; not yet activated.', unique: true });
    } else {
      target = map.nodes.find(node => node.id === item.nodeId); need(target, 'The idea it would go on no longer exists.', 409);
      target.notes = [...notesOf(target), { id: `note-${randomUUID().slice(0, 8)}`, text: thought.text, createdAt: at, fromThought: thought.id }];
    }
    Object.assign(thought, { state: 'placed', placedAt: at, placement: { action: item.action, nodeId: target.id } });
    Object.assign(item, { review: 'accepted', reviewedAt: at, ...(actor?.name ? { reviewedBy: { name: actor.name } } : {}) });
    store.event(map, 'thought-placed', target.id, `${thought.id}: ${item.action}`);
  } },
};

// The packet: open thoughts in full, those never sorted first, as many as fit in up to 60% of the room (at least one,
// at most 20), then an index of ideas in reading order in the rest, cut in one pass; what was left out is counted. What
// it sent is kept on the job (F1's `included`): each thought's ID and a key of its text, never the text itself.
const retrieval = 'Use CLI read --map MAP --query TEXT to find more ideas, and read --map MAP --node NODE for one.';
function sortPacket({ map, budget }) {
  const limit = budget - 800, order = sortOrder(map), thoughts = [];
  let used = 0;
  for (const thought of order) {
    const size = JSON.stringify({ id: thought.id, text: thought.text }).length + 1;
    if (thoughts.length >= maxSorted || (thoughts.length && used + size > limit * 0.6)) break;
    thoughts.push({ id: thought.id, text: thought.text }); used += size;
  }
  need(thoughts.length, 'No open thoughts are left to sort. Jot one down, then ask again.');
  const ideas = treeOrder(map).map(({ node }) => ({ id: node.id, title: clip(node.title, 100), kind: node.kind, status: node.status, completed: isCompleted(map, node), summary: clip(node.summary, 200) }));
  const packet = { thoughts, remainingThoughts: order.length - thoughts.length, ideas, omittedIdeas: 0, retrieval, instruction };
  const sizes = ideas.map(idea => JSON.stringify(idea).length + 1);
  for (let total = JSON.stringify(packet).length; total > limit && packet.ideas.length > 1;) { total -= sizes.pop(); packet.ideas.pop(); packet.omittedIdeas++; }
  while (JSON.stringify(packet).length > limit && packet.ideas.length > 1) { packet.ideas.pop(); packet.omittedIdeas++; } // The count's own digits.
  packet[includedKey] = thoughts.map(thought => ({ thoughtId: thought.id, textKey: textKey(thought.text) }));
  return packet;
}
const instruction = 'Propose a place for each thought; never activate anything. Return placements: exactly one per thought, { thoughtId, action: "new-branch", parentId, title, body, kind?, test? } to start a suggested branch under an idea (kind research or hypothesis; a hypothesis may say how to test it; never a title its parent already has, and each title once), { thoughtId, action: "note", nodeId, reason } to add the thought as the user\'s note on an existing idea, or { thoughtId, action: "unplaced", reason }. Prefer a note when a thought adds to an existing branch, and a new branch when it opens a separate question. A thought that changes a finished premise becomes a new branch, not a note. Only the user accepts a placement.';

const placementFields = { 'new-branch': ['thoughtId', 'action', 'parentId', 'title', 'body', 'kind', 'test'], note: ['thoughtId', 'action', 'nodeId', 'reason'], unplaced: ['thoughtId', 'action', 'reason'] };
function validateSort(result, { map, job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => key !== 'placements');
  need(!extra.length, `Return only placements; remove ${extra.join(', ')}.`);
  const wanted = new Set((job.included ?? []).map(record => record.thoughtId)), seen = new Set(), titles = new Set(), exists = id => map.nodes.some(node => node.id === id);
  need(Array.isArray(result.placements) && result.placements.length === wanted.size, 'Give exactly one placement for every thought.');
  return { placements: result.placements.map((item, index) => {
    const label = `Placement ${index + 1}`;
    need(item && typeof item === 'object' && !Array.isArray(item), `${label} must be an object.`);
    need(wanted.has(item.thoughtId), `${label} names a thought that was not sent.`);
    need(!seen.has(item.thoughtId), `${label} places a thought twice; give exactly one placement for every thought.`); seen.add(item.thoughtId);
    need(Object.hasOwn(placementFields, item.action), `${label}: action must be new-branch, note or unplaced.`);
    const unknown = Object.keys(item).filter(key => !placementFields[item.action].includes(key));
    need(!unknown.length, `${label} has fields a ${item.action} placement does not take: ${unknown.join(', ')}.`);
    if (item.action === 'new-branch') {
      need(exists(item.parentId), `${label} names an idea that does not exist.`);
      need(item.kind === undefined || directionKinds.has(item.kind), `${label}: kind must be research or hypothesis.`);
      const title = textField(item.title, `${label} title`, 100, fail);
      // A title its parent already has could never be accepted: propose a note on that direction instead.
      need(!existingChild(map, map.nodes.find(node => node.id === item.parentId), title), `${label}: "${title}" is already a direction under that idea; propose a note on it instead.`);
      need(item.test === undefined || item.kind === 'hypothesis', `${label}: only a hypothesis carries a test.`);
      const titleKey = `${item.parentId}/${title.trim().toLowerCase()}`;
      need(!titles.has(titleKey), `${label}: another placement already proposes "${title}" under that idea; give each new branch its own title.`); titles.add(titleKey);
      return { thoughtId: item.thoughtId, action: 'new-branch', parentId: item.parentId, title, body: textField(item.body, `${label} body`, 4000, fail), kind: item.kind ?? 'research', ...(item.test !== undefined ? { test: hypothesisTest(item.test, fail) } : {}) };
    }
    if (item.action === 'note') need(exists(item.nodeId), `${label} names an idea that does not exist.`);
    return { thoughtId: item.thoughtId, action: item.action, ...(item.action === 'note' ? { nodeId: item.nodeId } : {}), reason: textField(item.reason, `${label} reason`, 600, fail) };
  }) };
}

export const inboxJobTypes = {
  [SORT_THOUGHTS]: {
    label: 'Sort thoughts', target: 'map',
    reason: 'The user asked where the inbox thoughts belong.',
    // Which thoughts go is decided when the agent takes the work, from the thoughts open then.
    prepare: ({ map }) => { need(openThoughts(map).length, 'There are no open thoughts to sort.', 409); need(sortOrder(map).length, 'Every open thought has a suggestion waiting for you. Accept or dismiss those first.', 409); return {}; },
    packet: sortPacket,
    validate: validateSort,
    // Stale once a thought it read was placed, discarded or edited.
    isStale: ({ map, job }) => (job.included ?? []).some(record => { const thought = (map.inbox ?? []).find(item => item.id === record.thoughtId); return !thought || thought.state !== 'open' || textKey(thought.text) !== record.textKey; }),
    store: ({ map, job, result, makeId, at }) => {
      const keys = new Map((job.included ?? []).map(record => [record.thoughtId, record.textKey]));
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: SORT_THOUGHTS, createdAt: at,
        items: result.placements.map(item => ({ id: makeId('item'), ...item, textKey: keys.get(item.thoughtId), review: 'unreviewed' })) }];
    },
    // A placed thought whose note or branch is gone (restoring or restarting a branch removed it) goes back to the inbox,
    // so it is never in neither place. The Store runs this before every save.
    beforeSave: map => {
      for (const thought of Array.isArray(map.inbox) ? map.inbox : []) {
        if (thought?.state !== 'placed' || !thought.placement) continue;
        const target = map.nodes.find(node => node.id === thought.placement.nodeId);
        const kept = thought.placement.action === 'note' ? notesOf(target ?? {}).some(note => note.fromThought === thought.id) : !!target;
        if (!kept) { thought.state = 'open'; delete thought.placedAt; delete thought.placement; }
      }
    },
    // Reviewing: accepting places the thought (place-thought), so the generic review only dismisses, once.
    reviewDecisions: ['dismissed'], reviewRefusal: 'Use Accept to place this thought.', finalReview: true,
  },
};

// Branch packets carry an idea's newest notes within 1,500 characters, each at most 600 and marked when shortened,
// labelled as the user's own; the rest are counted. Node Markdown lists them all.
export function notesForPacket(node) {
  const notes = notesOf(node), kept = [];
  let used = 0;
  for (const note of [...notes].reverse()) {
    const text = note.text.length > 600 ? `${note.text.slice(0, 600)}\n[Shortened; read --section notes for the full text.]` : note.text;
    if (kept.length && used + text.length > 1500) break;
    kept.unshift({ text }); used += text.length;
  }
  return kept.length ? { userNotes: kept, ...(kept.length < notes.length ? { omittedNotes: notes.length - kept.length } : {}) } : {};
}
export const notesInstruction = 'selected.userNotes are the user\'s own notes on this idea: context they want considered, not findings or answers.';
export function noteLines(node) {
  const notes = notesOf(node);
  return notes.length ? ['', '## Your notes', '', '_The user\'s own notes, not findings._', '', ...notes.map(note => `- ${markdownText(note.text)}`)] : [];
}
