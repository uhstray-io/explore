// Reviewed project brief (G2): the user picks files, the agent writes a brief separating facts (quoted from a file),
// its own inferences and what it could not tell, and the user corrects and approves it. Its rules and markup, shared by
// the Store and the app.
import { draftsOf, draftStatusHtml } from './record-drafts.js';

export const PROJECT_BRIEF = 'project-brief';
export const briefLimits = { files: 8, fileBytes: 256 * 1024, facts: 25, inferences: 15, unknowns: 10, statements: 15, text: 400, quote: 300, unknownText: 300, packet: 3000 };
export const briefSections = ['purpose', 'stack', 'architecture', 'conventions', 'constraints'];
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const projectBriefOf = map => ({ draft: null, approved: null, statements: [], ...(isRecord(map?.projectBrief) ? map.projectBrief : {}) });
const statusWords = { changed: 'changed', missing: 'missing' };

// A file's state as the app last asked for it (`status` from GET …/project-brief), or null when unknown.
const fileState = (status, file) => status?.files?.find(entry => entry.path === file)?.status ?? null;
// What prompted a question (its snapshot of approved facts and statements), with a warning when a file changed since.
export function promptedByHtml(question, { esc, status }) {
  if (!Array.isArray(question.promptedBy) || !question.promptedBy.length) return '';
  const items = question.promptedBy.map(item => `${esc(item.text)}${item.file ? ` <span class="form-note">(${esc(item.file)}${statusWords[fileState(status, item.file)] ? `, ${statusWords[fileState(status, item.file)]} since` : ''})</span>` : ' <span class="form-note">(your statement)</span>'}`);
  const changed = question.promptedBy.some(item => item.file && statusWords[fileState(status, item.file)]);
  return `<p class="prompted-by${changed ? ' warning' : ''}">Prompted by: ${items.join('; ')}${changed ? ' Check it before relying on this question.' : ''}</p>`;
}

// The dialog's body: the files' state, progress, the draft under review, the approved brief, and the request form.
// `editing` the item being rewritten; `errors` per-path refusals of the last request; `paths` the typed paths.
export function projectBriefHtml({ map, esc, listening, live = true, status = null, editing = null, errors = [], paths = null }) {
  const brief = projectBriefOf(map), shown = brief.draft ?? brief.approved, drafts = draftsOf(map, PROJECT_BRIEF);
  const stale = (status?.files ?? []).filter(file => file.status !== 'current');
  const banner = shown && stale.length ? `<div class="state-note warning" id="project-brief-files" tabindex="-1"><p>${stale.map(file => `${esc(file.path)} is ${statusWords[file.status]}`).join('; ')} since the brief was written. Facts from ${stale.length === 1 ? 'it' : 'them'} are unverified until you refresh the brief.</p></div>` : '';
  const check = shown && live ? '<button type="button" class="text-button" data-brief-check>Check files</button>' : '';
  const progress = draftStatusHtml(drafts, { esc, listening, live, prefix: 'project-brief', doing: 'writing the project brief', failure: 'Your agent could not write the project brief.', earlier: 'An earlier view of the map: return to the live map to change the brief.' });
  const from = fact => `<details class="brief-quote"><summary>From ${esc(fact.file)}${statusWords[fileState(status, fact.file)] ? ` <span class="warning">(${statusWords[fileState(status, fact.file)]} since)</span>` : ''}</summary><blockquote>${esc(fact.quote)}</blockquote></details>`;
  const editor = (id, text) => `<div class="brief-edit"><label for="brief-edit-${esc(id)}" class="visually-hidden">Your wording</label><textarea id="brief-edit-${esc(id)}" rows="2" maxlength="${briefLimits.text}" data-brief-text>${esc(text)}</textarea><div class="brief-actions"><button type="button" class="primary" data-brief-save="${esc(id)}">Save as your statement</button><button type="button" class="text-button" data-brief-cancel>Cancel</button></div></div>`;
  const controls = (kind, id, canEdit) => (live && brief.draft ? `<div class="brief-actions">${canEdit ? `<button type="button" class="text-button" data-brief-edit="${esc(id)}">Edit</button>` : ''}<button type="button" class="text-button" data-brief-remove="${esc(`${kind}:${id}`)}">Remove</button></div>` : '');
  const item = (label, body, extra = '') => `<li class="brief-item"><p><span class="brief-label">${label}</span> ${body}</p>${extra}</li>`;
  const section = name => `<span class="form-note">${esc(name)}</span>`;
  const list = version => !version ? '' : `<ul class="brief-items">`
    + brief.statements.map(entry => item('Your statement', esc(entry.text), editing === entry.id ? editor(entry.id, entry.text) : controls('statements', entry.id, true))).join('')
    + version.facts.map(fact => item(`Fact ${section(fact.section)}`, esc(fact.text), from(fact) + (editing === fact.id ? editor(fact.id, fact.text) : controls('facts', fact.id, true)))).join('')
    + version.inferences.map(entry => item(`Agent inference ${section(entry.section)}`, `${esc(entry.text)}${entry.basedOn.length ? ` <span class="form-note">(from ${entry.basedOn.map(esc).join(', ')})</span>` : ''}`, controls('inferences', entry.id, false))).join('')
    + version.unknowns.map((entry, i) => item(`Not found in these files ${section(entry.section)}`, esc(entry.text), controls('unknowns', i, false))).join('') + '</ul>';
  const add = live && brief.draft ? `<div class="brief-add"><label for="brief-statement">Add a statement of your own</label><textarea id="brief-statement" rows="2" maxlength="${briefLimits.text}"></textarea><button type="button" class="secondary" data-brief-add>Add</button></div>` : '';
  const review = brief.draft ? `<h3 class="section-label" id="project-brief-draft" tabindex="-1">Draft for review</h3><p class="form-note">Remove what is wrong, rewrite a fact as your own statement, or add one. Investigations keep using ${brief.approved ? 'the approved brief' : 'no brief'} until you approve this.</p>${list(brief.draft)}${add}`
    + (live ? '<div class="brief-actions"><button type="button" class="primary" data-brief-approve>Approve brief</button><button type="button" class="text-button" data-brief-discard>Discard draft</button></div>' : '') : '';
  const approved = !brief.draft && brief.approved ? `<h3 class="section-label" id="project-brief-approved" tabindex="-1">Approved brief</h3><p class="form-note">Investigations receive this, with what changed in its files.</p>${list(brief.approved)}`
    + (live ? '<div class="brief-actions"><button type="button" class="secondary" data-brief-start-edit>Edit</button><button type="button" class="secondary" data-brief-refresh>Refresh from files</button><button type="button" class="text-button" data-brief-clear>Clear brief</button></div>' : '') : '';
  const files = paths ?? (shown?.files ?? []).map(file => file.path).join('\n');
  const refused = errors.length ? `<ul class="state-note warning" id="project-brief-errors">${errors.map(error => `<li><code>${esc(error.path)}</code>: ${esc(error.message)}</li>`).join('')}</ul>` : '';
  const ask = live && !drafts.pending && !brief.draft ? `<h3 class="section-label">${brief.approved ? 'Ask for a new brief' : 'Ask for a brief'}</h3><label for="project-brief-paths">Files in this workspace, one path per line (up to ${briefLimits.files})</label>`
    + `<textarea id="project-brief-paths" rows="4" placeholder="README.md&#10;package.json">${esc(files)}</textarea>${refused}<p class="form-note">Never your secrets: Explore refuses .env files, keys and anything named like a password or token, and anything outside the workspace.</p><button type="button" class="primary" data-brief-ask>Ask your agent</button>` : '';
  return banner + check + progress + review + approved + ask;
}
