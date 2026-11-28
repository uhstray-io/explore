// Lightweight ADR (F5) in the Store: the adr-draft map job, reviewing the draft, and the one place Explore writes into
// the user's project outside ideas/ and .explore/: docs/adr/ in the workspace, only from the browser's Save file, only an
// accepted draft whose exact bytes the user previewed, and never over an existing file. Explore never runs Git.
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { textField } from './fields.mjs';
import { packetBudget } from './guidance.mjs';
import { proposalOutdated } from './map-jobs.mjs';
import { chosenRecords, recordsPacket, citedRecords, editableReview, oneLine } from './record-drafts.mjs';
import { ADR_DRAFT, maxAdrRecords, adrTitleMax, adrSectionMax, adrFileMax, adrSections, adrName, renderAdr, adrFileText, adrSlug, adrToday } from '../assets/adr.js';

class AdrProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new AdrProblem(message, status); };
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// The packet: the chosen records (record-drafts.mjs), the title the user has in mind, and how to draft.
const adrPacket = ({ map, job, budget }) => recordsPacket({ map, selection: job.input.selection, budget, tooBig: 'These answers and findings do not fit in one draft. Choose fewer.',
  fields: { ...(job.input.titleHint ? { titleHint: job.input.titleHint } : {}), resultFormat, instruction } });
const resultFormat = { title: `one line, at most ${adrTitleMax} characters`, context: 'Markdown', decision: 'Markdown', consequences: 'Markdown', alternatives: 'Markdown, optional', openQuestions: 'Markdown, optional',
  refs: [{ nodeId: 'from records', questionId: 'from records, for an answer' }], limits: `each section at most ${adrSectionMax} characters; at least one ref, each a record you were given` };
const instruction = 'Draft an architecture decision record from these records alone: the user\'s saved answers and the findings of explored ideas. Do no new research. Write context, the decision, its consequences, and alternatives and open questions where the records give them. Where the user never gave a reason, write "Not recorded"; never invent one. Cite every record you rely on in refs. You only draft: never write the file; the user edits, accepts and saves it.';

function validateAdr(result, { job }) {
  const fail = message => need(false, message);
  const extra = Object.keys(result).filter(key => !['title', ...adrSections.map(([key]) => key), 'refs'].includes(key));
  need(!extra.length, `An ADR draft returns a title, its sections and refs; remove ${extra.join(', ')}.`);
  const title = oneLine(result.title, 'Title', adrTitleMax, fail);
  const sections = Object.fromEntries(adrSections.map(([key, heading]) => [key, textField(result[key], heading, adrSectionMax, fail, { optional: key === 'alternatives' || key === 'openQuestions' })]).filter(([, value]) => value));
  return { title, ...sections, refs: citedRecords(result.refs, job, fail) };
}

export const adrJobTypes = {
  [ADR_DRAFT]: {
    label: 'Draft an ADR', target: 'map',
    reason: 'The user asked for an architecture decision record drafted from chosen answers and findings.',
    prepare: ({ map, input }) => {
      const selection = chosenRecords(map, input.selection, { max: maxAdrRecords }), titleHint = oneLine(input.titleHint, 'Title', adrTitleMax, message => need(false, message), { optional: true });
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
    // Accept or Dismiss, once; accepting saves the user's edited text and writes nothing to the project.
    ...editableReview({ name: 'The record', max: adrFileMax, bytes: true }),
  },
};

const findItem = (map, input) => {
  const proposal = (map.proposals ?? []).find(item => item.id === input.proposalId && item.type === ADR_DRAFT), item = proposal?.items.find(entry => entry.id === input.itemId);
  need(item, 'That draft no longer exists.', 404);
  return item;
};
// docs/ and docs/adr/ in the workspace: 'missing', 'plain' (a folder, not a link) or 'other'.
const folders = workspace => [path.join(workspace, 'docs'), path.join(workspace, 'docs', 'adr')];
const folderKinds = workspace => Promise.all(folders(workspace).map(dir => lstat(dir).then(info => (info.isDirectory() && !info.isSymbolicLink() ? 'plain' : 'other'), () => 'missing')));
// The folder: docs/adr/ in the workspace, plain folders all the way (never through a link), or not there yet.
async function adrFolder(workspace) {
  need((await folderKinds(workspace)).every(kind => kind !== 'other'), 'docs/adr/ must be a plain folder in this workspace, not a link or a file.');
  return folders(workspace)[1];
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
    // Created by this save alone; removed only while the path still names that same file, so taking it back never
    // removes another one (if a link were swapped in after the write).
    let made = null;
    const takeBack = async () => { const now = await lstat(target, { bigint: true }).catch(() => null); if (made && now?.isFile() && now.ino === made.ino && now.dev === made.dev) await unlink(target).catch(() => {}); };
    try {
      made = await handle.stat({ bigint: true });
      await handle.writeFile(bytes, 'utf8'); await handle.close();
      // The folders are checked again as they were before the write: a link swapped in between is caught, and the file taken back.
      need((await folderKinds(file.workspace)).every(kind => kind === 'plain'), 'docs/adr/ changed while saving; nothing was saved.');
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
