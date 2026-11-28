// Lightweight ADR (F5) in the Store: the adr-draft map job, reviewing the draft, and the one place Explore writes into
// the user's project outside ideas/ and .explore/: docs/adr/ in the workspace, only from the browser's Save file, only an
// accepted draft whose exact bytes the user previewed, and never over an existing file. Explore never runs Git.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { textField } from './fields.mjs';
import { packetBudget } from './guidance.mjs';
import { includedKey, proposalOutdated } from './map-jobs.mjs';
import { certaintyText } from '../assets/questions.js';
import { answerChoices } from '../assets/workspace-view.js';
import { ADR_DRAFT, maxAdrRecords, adrTitleMax, adrSectionMax, adrFileMax, adrSections, adrName, renderAdr, adrFileText, adrSlug, adrToday } from '../assets/adr.js';

class AdrProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new AdrProblem(message, status); };
const clip = (value, limit) => { const text = String(value ?? ''); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const oneLine = (value, field, max, fail, options) => { const text = textField(value, field, max, fail, options); if (text !== undefined && /[\r\n]/.test(text)) fail(`${field} must be one line.`); return text; };

// The records a draft reads: 1–40 of what the shared selector offers (F1's answerChoices with findings): saved, current
// answers ({ nodeId, questionId }) and explored ideas' findings ({ nodeId }).
function normalizeSelection(map, selection) {
  need(Array.isArray(selection) && selection.length >= 1 && selection.length <= maxAdrRecords, `Choose 1 to ${maxAdrRecords} answers or findings.`);
  const offered = new Set(answerChoices(map, { findings: true }).flatMap(group => [...(group.findings ? [`${group.nodeId}/`] : []), ...group.answers.map(answer => `${group.nodeId}/${answer.questionId}`)]));
  const seen = new Set();
  return selection.map(item => {
    const key = `${item?.nodeId}/${item?.questionId ?? ''}`;
    need(offered.has(key), 'A chosen record is not a saved answer or an explored idea\'s findings on this map.');
    need(!seen.has(key), 'A record is chosen twice.'); seen.add(key);
    return { nodeId: item.nodeId, ...(item.questionId !== undefined ? { questionId: item.questionId } : {}) };
  });
}
// The packet: each record with its idea, review state and staleness. The records share the room: when they would not fit,
// their text is shortened step by step (marked, with how to read it in full); a choice that cannot fit even then is refused.
const steps = [{ findings: 2400, summary: 700, answer: 1200 }, { findings: 1200, summary: 400, answer: 600 }, { findings: 500, summary: 200, answer: 300 }, { findings: 200, summary: 120, answer: 150 }];
const retrieval = 'Use CLI read --map MAP --node NODE --section findings, or --section questions --question ID, to read anything shortened here.';
function adrPacket({ map, job, budget }) {
  const build = caps => job.input.selection.map(({ nodeId, questionId }) => {
    const node = map.nodes.find(n => n.id === nodeId), base = { nodeId, idea: clip(node.title, 100), reviewState: node.reviewState, stale: !!node.stale };
    const texts = questionId ? { answer: node.questions.find(q => q.id === questionId).answer } : { summary: node.summary, findings: node.body === node.prompt ? '' : node.body };
    const cut = Object.entries(texts).some(([key, text]) => String(text ?? '').length > caps[key]), clipped = Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, clip(text, caps[key])]));
    const question = questionId ? node.questions.find(q => q.id === questionId) : null;
    return { ...base, ...(question ? { questionId, question: clip(question.text, 400), certainty: certaintyText(question) } : {}), ...clipped, ...(cut ? { shortened: true } : {}) };
  });
  let packet;
  for (const caps of steps) {
    const records = build(caps);
    packet = { records, ...(job.input.titleHint ? { titleHint: job.input.titleHint } : {}), ...(records.some(record => record.shortened) ? { retrieval } : {}), resultFormat, instruction };
    if (JSON.stringify(packet).length <= budget - 800) break;
  }
  need(JSON.stringify(packet).length <= budget - 800, 'These answers and findings do not fit in one draft. Choose fewer.');
  packet[includedKey] = packet.records.map(({ nodeId, questionId }) => ({ nodeId, ...(questionId ? { questionId } : {}), contentRevision: map.nodes.find(n => n.id === nodeId).contentRevision }));
  return packet;
}
const resultFormat = { title: `one line, at most ${adrTitleMax} characters`, context: 'Markdown', decision: 'Markdown', consequences: 'Markdown', alternatives: 'Markdown, optional', openQuestions: 'Markdown, optional',
  refs: [{ nodeId: 'from records', questionId: 'from records, for an answer' }], limits: `each section at most ${adrSectionMax} characters; at least one ref, each a record you were given` };
const instruction = 'Draft an architecture decision record from these records alone: the user\'s saved answers and the findings of explored ideas. Do no new research. Write context, the decision, its consequences, and alternatives and open questions where the records give them. Where the user never gave a reason, write "Not recorded"; never invent one. Cite every record you rely on in refs. You only draft: never write the file; the user edits, accepts and saves it.';

function validateAdr(result, { job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => !['title', ...adrSections.map(([key]) => key), 'refs'].includes(key));
  need(!extra.length, `An ADR draft returns a title, its sections and refs; remove ${extra.join(', ')}.`);
  const title = oneLine(result.title, 'Title', adrTitleMax, fail);
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
      const selection = normalizeSelection(map, input.selection), titleHint = oneLine(input.titleHint, 'Title', adrTitleMax, message => need(false, message), { optional: true });
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
    // F1's review-proposal for an editable item: accepted or dismissed once, so a saved record is never reviewed again;
    // accepting saves the user's edited text. Accepting writes nothing to the project.
    reviewRefusal: 'Choose Accept or Dismiss.', finalReview: true,
    review: ({ item, input }) => {
      if (input.decision === 'accepted') {
        const text = input.text === undefined ? item.text : textField(input.text, 'The record', adrFileMax, message => need(false, message));
        need(Buffer.byteLength(text, 'utf8') <= adrFileMax, 'The record must be at most 64 KiB.');
        item.text = text;
      }
    },
  },
};

const findItem = (map, input) => {
  const proposal = (map.proposals ?? []).find(item => item.id === input.proposalId && item.type === ADR_DRAFT), item = proposal?.items.find(entry => entry.id === input.itemId);
  need(item, 'That draft no longer exists.', 404);
  return item;
};
// The folder: docs/adr/ in the workspace, plain folders all the way (never through a link), as it resolves on disk.
async function adrFolder(workspace) {
  const docs = path.join(workspace, 'docs'), folder = path.join(docs, 'adr');
  for (const dir of [docs, folder]) {
    const info = await lstat(dir).catch(() => null);
    need(!info || (info.isDirectory() && !info.isSymbolicLink()), 'docs/adr/ must be a plain folder in this workspace, not a link or a file.');
  }
  return folder;
}
// The file: only its name comes from the request, and it lands directly in the folder.
function adrTarget(folder, relative) {
  const name = adrName(relative);
  need(name, 'Save under docs/adr/ as NNNN-name.md: four digits, then lowercase letters, digits and hyphens, at most 60.');
  const target = path.join(folder, name);
  need(path.dirname(target) === folder, 'Save under docs/adr/ only.');
  return target;
}
// One more than the highest four-digit prefix in the folder, or 1; never past 9999.
async function nextNumber(folder) {
  const names = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  return Math.min(9999, Math.max(0, ...names.map(name => /^(\d{4})-/.exec(name)?.[1]).filter(Boolean).map(Number)) + 1);
}
const exists = file => lstat(file).then(() => true, () => false);

export const adrActions = {
  // Save an accepted draft to docs/adr/: only from the browser's Save file (the server's ADR route passes the workspace;
  // the action route never does), only if the bytes are the ones previewed, and only to a new file. Returns how to take
  // the file back if the map cannot be saved after it, so a retry never leaves a second copy.
  'adr-save': { target: 'map', apply: async ({ map, input, store, file }) => {
    need(file?.workspace, 'Only Save file in the browser writes a decision record.', 403);
    const item = findItem(map, input);
    need(item.review === 'accepted', 'Accept the draft before saving it.', 409);
    need(!item.file, `This record was already saved to ${item.file?.path}.`, 409);
    const folder = await adrFolder(file.workspace), target = adrTarget(folder, input.path), bytes = adrFileText(item.text, adrToday());
    need(Buffer.byteLength(bytes, 'utf8') <= adrFileMax, 'The record must be at most 64 KiB.');
    need(input.sha256 === sha256(bytes), 'The record changed since you previewed it. Preview it again, then save.', 409);
    await mkdir(folder, { recursive: true }); // Created only on a confirmed save.
    let handle;
    try { handle = await open(target, 'wx'); }
    catch (error) { need(error.code !== 'EEXIST', `A file is already at ${input.path}; nothing was written. Choose another number.`, 409); need(false, `The file could not be written (${error.code ?? 'error'}). Nothing was saved.`); }
    const takeBack = () => unlink(target).catch(() => {}); // Created by this save alone, so removing it touches nothing else.
    try {
      await handle.writeFile(bytes, 'utf8'); await handle.close();
      // A link swapped in between the check and the write is caught here, and the file taken back.
      need(await realpath(folder) === path.join(await realpath(file.workspace), 'docs', 'adr'), 'docs/adr/ changed while saving; nothing was saved.');
    } catch (error) { await handle.close().catch(() => {}); await takeBack(); throw error; }
    item.file = { path: input.path, sha256: input.sha256, savedAt: new Date().toISOString() };
    store.event(map, 'adr-saved', null, input.path);
    return takeBack;
  } },
};

// What Save file would write: the suggested path (or the one asked about), whether it is free, the exact bytes and
// their SHA-256. Read-only; the folder is not created.
export async function adrFilePreview(store, workspace, mapId, { proposalId, itemId, path: asked }) {
  const map = await store.get(mapId), item = findItem(map, { proposalId, itemId });
  need(item.review === 'accepted', 'Accept the draft before saving it.', 409);
  const folder = await adrFolder(workspace), text = adrFileText(item.text, adrToday());
  const suggested = `docs/adr/${String(await nextNumber(folder)).padStart(4, '0')}-${adrSlug(item.title)}.md`, chosen = asked ?? suggested;
  return { path: chosen, suggested, free: !(await exists(adrTarget(folder, chosen))), text, sha256: sha256(text), bytes: Buffer.byteLength(text, 'utf8'), ...(item.file ? { saved: item.file } : {}) };
}
