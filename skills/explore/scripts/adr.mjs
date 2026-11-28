// Lightweight ADR (F5) in the Store: the adr-draft map job, accepting the draft, and the one place Explore writes into
// the user's project: docs/adr/ in the workspace, only from the browser's Save file, only an accepted draft whose exact
// bytes the user previewed, and never over an existing file. Explore never runs Git.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { textField } from './fields.mjs';
import { packetBudget } from './guidance.mjs';
import { includedKey, proposalOutdated } from './map-jobs.mjs';
import { certaintyText } from '../assets/questions.js';
import { ADR_DRAFT, maxAdrRecords, adrTitleMax, adrSectionMax, adrFileMax, adrSections, adrPathPattern, renderAdr, adrFileText, adrSlug } from '../assets/adr.js';

class AdrProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new AdrProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

// The records a draft reads: 1–40 saved, current answers ({ nodeId, questionId }) or explored ideas' findings ({ nodeId }).
function normalizeSelection(map, selection) {
  need(Array.isArray(selection) && selection.length >= 1 && selection.length <= maxAdrRecords, `Choose 1 to ${maxAdrRecords} answers or findings.`);
  const seen = new Set();
  return selection.map(item => {
    const node = map.nodes.find(n => n.id === item?.nodeId);
    const record = item?.questionId === undefined ? { nodeId: node?.id } : { nodeId: node?.id, questionId: node?.questions.find(q => q.id === item.questionId && q.answer && !q.supersededAt)?.id };
    need(node && (item?.questionId === undefined ? node.status === 'explored' : record.questionId), 'A chosen record is not a saved answer or an explored idea\'s findings on this map.');
    const key = `${record.nodeId}/${record.questionId ?? ''}`; need(!seen.has(key), 'A record is chosen twice.'); seen.add(key);
    return record;
  });
}
// The packet: each record with its idea, review state and staleness, in full where it fits; what it read is kept (F1).
function adrPacket({ map, job, budget }) {
  const records = job.input.selection.map(({ nodeId, questionId }) => {
    const node = map.nodes.find(n => n.id === nodeId), base = { nodeId, idea: clip(node.title, 100), reviewState: node.reviewState, stale: !!node.stale };
    if (!questionId) return { ...base, summary: clip(node.summary, 700), findings: clip(node.body === node.prompt ? '' : node.body, 2400) };
    const question = node.questions.find(q => q.id === questionId);
    return { ...base, questionId, question: clip(question.text, 400), answer: clip(question.answer, 1200), certainty: certaintyText(question) };
  });
  const packet = { records, ...(job.input.titleHint ? { titleHint: job.input.titleHint } : {}), resultFormat, instruction };
  need(JSON.stringify(packet).length <= budget - 800, 'These answers and findings do not fit in one draft. Choose fewer.');
  packet[includedKey] = records.map(({ nodeId, questionId }) => ({ nodeId, ...(questionId ? { questionId } : {}), contentRevision: map.nodes.find(n => n.id === nodeId).contentRevision }));
  return packet;
}
const resultFormat = { title: `at most ${adrTitleMax} characters`, context: 'Markdown', decision: 'Markdown', consequences: 'Markdown', alternatives: 'Markdown, optional', openQuestions: 'Markdown, optional',
  refs: [{ nodeId: 'from records', questionId: 'from records, for an answer' }], limits: `each section at most ${adrSectionMax} characters; refs name records you were given` };
const instruction = 'Draft an architecture decision record from these records alone: the user\'s saved answers and the findings of explored ideas. Do no new research. Write context, the decision, its consequences, and alternatives and open questions where the records give them. Where the user never gave a reason, write "Not recorded"; never invent one. Cite every record you rely on in refs. You only draft: never write the file; the user edits, accepts and saves it.';

function validateAdr(result, { job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => !['title', ...adrSections.map(([key]) => key), 'refs'].includes(key));
  need(!extra.length, `An ADR draft returns a title, its sections and refs; remove ${extra.join(', ')}.`);
  const title = textField(result.title, 'Title', adrTitleMax, fail);
  const sections = Object.fromEntries(adrSections.map(([key, heading]) => [key, textField(result[key], heading, adrSectionMax, fail, { optional: key === 'alternatives' || key === 'openQuestions' })]).filter(([, value]) => value));
  const read = new Set((job.included ?? []).map(record => `${record.nodeId}/${record.questionId ?? ''}`)), seen = new Set();
  need(Array.isArray(result.refs) && result.refs.length >= 1, 'Cite at least one record you relied on in refs.');
  const refs = result.refs.map((ref, index) => {
    const key = `${ref?.nodeId}/${ref?.questionId ?? ''}`;
    need(read.has(key), `Ref ${index + 1} names a record that was not read for this draft.`);
    need(!seen.has(key), `Ref ${index + 1} repeats a record.`); seen.add(key);
    return { nodeId: ref.nodeId, ...(ref.questionId ? { questionId: ref.questionId } : {}) };
  });
  return { title, ...sections, refs };
}

export const adrJobTypes = {
  [ADR_DRAFT]: {
    label: 'Draft an ADR', target: 'map',
    reason: 'The user asked for an architecture decision record drafted from chosen answers and findings.',
    prepare: ({ map, input }) => {
      const selection = normalizeSelection(map, input.selection), titleHint = textField(input.titleHint, 'Title', adrTitleMax, message => need(false, message), { optional: true });
      adrPacket({ map, job: { input: { selection, titleHint } }, budget: packetBudget(map) }); // Refuses a choice that cannot fit, before anything is queued.
      return { selection, ...(titleHint ? { titleHint } : {}) };
    },
    packet: adrPacket,
    validate: validateAdr,
    isStale: ({ map, job }) => proposalOutdated(map, { included: job.included }),
    proposalOutdated,
    // One editable item: the record as Explore renders it from the fixed template.
    store: ({ map, job, result, stale, makeId, at }) => {
      map.proposals = [...(map.proposals || []), { id: makeId('proposal'), jobId: job.id, type: ADR_DRAFT, createdAt: at, included: job.included || [], ...(stale ? { stale: true } : {}),
        items: [{ id: makeId('item'), title: result.title, refs: result.refs, text: renderAdr(map, result), review: 'unreviewed' }] }];
    },
  },
};

const findItem = (map, input) => {
  const proposal = (map.proposals ?? []).find(item => item.id === input.proposalId && item.type === ADR_DRAFT), item = proposal?.items.find(entry => entry.id === input.itemId);
  need(item, 'That draft no longer exists.', 404);
  return item;
};
// The file: a plain docs/adr/ folder in the workspace (never through a link), and a name that matches NNNN-name.md.
async function adrFolder(workspace) {
  const docs = path.join(workspace, 'docs'), folder = path.join(docs, 'adr');
  for (const dir of [docs, folder]) {
    const info = await lstat(dir).catch(() => null);
    need(!info || (info.isDirectory() && !info.isSymbolicLink()), 'docs/adr/ must be a plain folder in this workspace, not a link or a file.');
  }
  return folder;
}
function adrTarget(folder, relative) {
  need(typeof relative === 'string' && adrPathPattern.test(relative), 'Save under docs/adr/ as NNNN-name.md: four digits, then lowercase letters, digits and hyphens.');
  return path.join(folder, relative.slice('docs/adr/'.length));
}
// One more than the highest four-digit prefix in the folder, or 1.
async function nextNumber(folder) {
  const names = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Math.max(0, ...names.map(name => /^(\d{4})-/.exec(name)?.[1]).filter(Boolean).map(Number)) + 1;
}
const exists = file => lstat(file).then(() => true, () => false);

export const adrActions = {
  // Accept the draft, with the user's edits. Accepting saves nothing to the project; Save file does that.
  'adr-accept': { target: 'map', apply: ({ map, input, actor }) => {
    const item = findItem(map, input);
    need(item.review === 'unreviewed', 'This draft was already accepted or dismissed.', 409);
    const text = input.text === undefined ? item.text : textField(input.text, 'The record', adrFileMax, message => need(false, message));
    need(Buffer.byteLength(text, 'utf8') <= adrFileMax, 'The record must be at most 64 KiB.');
    Object.assign(item, { text, review: 'accepted', reviewedAt: new Date().toISOString(), ...(actor?.name ? { reviewedBy: { name: actor.name } } : {}) });
  } },
  // Save an accepted draft to docs/adr/: only from the browser's Save file (the server's ADR route passes the
  // workspace; the action route never does), only if the bytes are the ones previewed, and only to a new file.
  'adr-save': { target: 'map', apply: async ({ map, input, store, file }) => {
    need(file?.workspace, 'Only Save file in the browser writes a decision record.', 403);
    const item = findItem(map, input);
    need(item.review === 'accepted', 'Accept the draft before saving it.', 409);
    need(!item.file, `This record was already saved to ${item.file?.path}.`, 409);
    const folder = await adrFolder(file.workspace), target = adrTarget(folder, input.path), bytes = adrFileText(item.text, today());
    need(Buffer.byteLength(bytes, 'utf8') <= adrFileMax, 'The record must be at most 64 KiB.');
    need(input.sha256 === sha256(bytes), 'The record changed since you previewed it. Preview it again, then save.', 409);
    await mkdir(folder, { recursive: true }); // Created only on a confirmed save.
    let handle;
    try { handle = await open(target, 'wx'); } catch (error) { need(error.code !== 'EEXIST', `A file is already at ${input.path}; nothing was written. Choose another number.`, 409); throw error; }
    try { await handle.writeFile(bytes, 'utf8'); } finally { await handle.close(); }
    item.file = { path: input.path, sha256: input.sha256, savedAt: new Date().toISOString() };
    store.event(map, 'adr-saved', null, input.path);
  } },
};

// What Save file would write: the suggested path (or the one asked about), whether it is free, the exact bytes and
// their SHA-256. Read-only; the folder is not created.
export async function adrFilePreview(store, workspace, mapId, { proposalId, itemId, path: asked }) {
  const map = await store.get(mapId), item = findItem(map, { proposalId, itemId });
  need(item.review === 'accepted', 'Accept the draft before saving it.', 409);
  const folder = await adrFolder(workspace), text = adrFileText(item.text, today());
  const suggested = `docs/adr/${String(await nextNumber(folder)).padStart(4, '0')}-${adrSlug(item.title)}.md`, chosen = asked ?? suggested;
  return { path: chosen, suggested, free: !(await exists(adrTarget(folder, chosen))), text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), ...(item.file ? { saved: item.file } : {}) };
}
