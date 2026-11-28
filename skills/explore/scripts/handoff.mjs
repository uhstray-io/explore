// Implementation handoff (F4) in the Store: the handoff map job. From records the user chose, the agent writes one
// document in the format they picked; it becomes one editable proposal item the user accepts or dismisses, once. The
// agent's own text is kept beside the user's. Nothing is executed, sent or created anywhere.
import { textField } from './fields.mjs';
import { packetBudget } from './guidance.mjs';
import { outdatedRecords, proposalOutdated } from './map-jobs.mjs';
import { chosenRecords, recordsPacket, citedRecords, editableReview, oneLine } from './record-drafts.mjs';
import { HANDOFF, handoffFormats, maxHandoffRecords, handoffTitleMax, handoffTextMax } from '../assets/handoff.js';

class HandoffProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message) => { if (!condition) throw new HandoffProblem(message); };
const fail = message => need(false, message);
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };

const formatOf = options => {
  need(options === undefined || (options && typeof options === 'object' && !Array.isArray(options)), 'Options must be an object.');
  need(Object.hasOwn(handoffFormats, options?.format), `Choose what to write: ${Object.keys(handoffFormats).join(', ')}.`);
  return options.format;
};
const perFormat = {
  brief: 'Write a short brief: the goal, what was decided and what is still open.',
  spec: 'Write a specification: the requirements the records settle, each with a check that would show it is met.',
  plan: 'Write a plan: the proposed work in order, each step with what it depends on.',
  prompt: 'Write a prompt addressed to a future implementer: what to build, the decisions to keep, and what to ask about first.',
  tasks: 'Write a task list: proposed tasks in order, each small enough to do and check on its own.',
};
const instruction = format => `From these records alone (the user's saved answers and explored ideas' findings) and the original idea, write a ${handoffFormats[format].toLowerCase()} for whoever implements this. ${perFormat[format]} Do no new research. Owners, estimates and acceptance criteria the records never give stay "Not recorded"; never invent them. Put an answer that is not Decided, a finding that is unreviewed or stale, and anything the records disagree on under "Open questions", never under "Decisions". Cite every record you rely on in refs. You only write the document: never start implementing, run commands, open issues or send it anywhere.`;
const resultFormat = { title: `one line, at most ${handoffTitleMax} characters`, markdown: `the document, at most ${handoffTextMax.toLocaleString('en')} characters`,
  refs: [{ nodeId: 'from records', questionId: 'from records, for an answer' }], limits: 'at least one ref, each a record you were given; any other field rejects the result' };

const handoffPacket = ({ map, job, budget }) => recordsPacket({ map, selection: job.input.selection, budget, tooBig: 'These answers and findings do not fit in one handoff. Choose fewer.',
  fields: { idea: clip(map.originalIdea ?? '', 1200), format: job.input.format, resultFormat, instruction: instruction(job.input.format) } });

function validateHandoff(result, { job }) {
  const extra = Object.keys(result).filter(key => !['title', 'markdown', 'refs'].includes(key));
  need(!extra.length, `A handoff returns a title, its markdown and refs; remove ${extra.join(', ')}.`);
  return { title: oneLine(result.title, 'Title', handoffTitleMax, fail), markdown: textField(result.markdown, 'The handoff', handoffTextMax, fail), refs: citedRecords(result.refs, job, fail) };
}

export const handoffJobTypes = {
  [HANDOFF]: {
    label: 'Implementation handoff', target: 'map',
    reason: 'The user asked for an implementation handoff written from chosen answers and findings.',
    prepare: ({ map, input }) => {
      const selection = chosenRecords(map, input.selection, { max: maxHandoffRecords }), format = formatOf(input.options);
      handoffPacket({ map, job: { input: { selection, format } }, budget: packetBudget(map) }); // Refuses a choice that cannot fit, before anything is queued.
      return { selection, format };
    },
    packet: handoffPacket,
    validate: validateHandoff,
    isStale: ({ map, job }) => proposalOutdated(map, { included: job.included }),
    proposalOutdated, outdatedRecords,
    // One editable item, with the agent's own text kept as `original`.
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: HANDOFF, createdAt: at, included: job.included || [], ...(stale ? { stale: true } : {}),
        items: [{ id: makeId('item'), title: result.title, format: job.input.format, refs: result.refs, text: result.markdown, original: result.markdown, review: 'unreviewed' }] }];
    },
    ...editableReview({ name: 'The handoff', max: handoffTextMax }),
  },
};
