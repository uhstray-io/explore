import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { presentation, constellationLayout } from '../assets/graph.js';
import { hasCurrentAnswer, isWaiting, certaintyText } from '../assets/questions.js';
import { downloadName } from '../assets/workspace-view.js';
import { hasFindings } from './store.mjs';

// A read-only viewer file (I4): one HTML page holding only the ideas the user chose, which anyone can open offline.
// Map text is data in a JSON block and reaches the page only as text; a policy allows just the page's own script and
// style, by hash, so the file fetches nothing. Jobs, history, workers, claim keys, paths and tokens never go in.
class ViewerProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new ViewerProblem(message, status); };
export const maxIdeas = 500, maxBytes = 4 * 1024 * 1024;
const asset = name => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');

// What the file holds for `selection`, [{ id, answers, findings }]: each chosen idea's title, kind and states, and
// only the fields chosen for it. A parent link exists only to a chosen parent, and the map title only with the root.
export function viewerData(map, selection) {
  need(Array.isArray(selection) && selection.length > 0, 'Choose at least one idea.');
  need(selection.length <= maxIdeas, `A viewer holds at most ${maxIdeas} ideas. Choose fewer.`, 413);
  const chosen = new Map(), ids = new Set(map.nodes.map(node => node.id));
  for (const entry of selection) {
    need(entry && typeof entry === 'object' && ids.has(entry.id), 'Choose ideas from this map.');
    need(typeof entry.answers === 'boolean' && typeof entry.findings === 'boolean', 'Say for each idea whether to include answers and findings.');
    need(!chosen.has(entry.id), 'Choose each idea once.');
    chosen.set(entry.id, entry);
  }
  const positions = constellationLayout(map).positions;
  const nodes = map.nodes.filter(node => chosen.has(node.id)).map(node => {
    const { answers, findings } = chosen.get(node.id), researched = hasFindings(map, node);
    const out = { id: node.id, title: node.title, kind: node.kind, state: presentation(node).label, stale: !!node.stale, review: node.reviewState, researched,
      parentId: chosen.has(node.parentId) ? node.parentId : null, position: positions[node.id] ?? null };
    if (findings) Object.assign(out, { premise: node.prompt || node.body, ...(researched ? { summary: node.summary, findings: node.body } : {}),
      sources: (node.sources || []).map(({ title, url, note }) => ({ title, url, note })) });
    if (answers) out.questions = node.questions.filter(question => !question.supersededAt && !question.dismissedAt)
      .map(question => hasCurrentAnswer(question) ? { text: question.text, answer: question.answer, certainty: certaintyText(question), status: 'answered' }
        : { text: question.text, answer: null, certainty: null, status: isWaiting(question) ? 'waiting' : 'later' });
    return out;
  });
  return { heading: chosen.has(map.rootId) ? map.title : 'Selected ideas', nodes };
}

// JSON safe inside a script block: nothing in it can close the block, open a comment, or end a line in JavaScript.
const unsafeInScript = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const scriptJson = value => JSON.stringify(value).replace(unsafeInScript, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const text = value => String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
const sha = source => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;

// `{ expectedRevision, nodes }` from the browser. Refuses a stale revision and anything over 4 MiB.
export function viewerFile(map, { expectedRevision, nodes } = {}) {
  need(expectedRevision === map.revision, 'This map changed. Preview again.', 409);
  const data = viewerData(map, nodes), script = asset('viewer-page.js'), style = asset('viewer.css');
  const policy = `default-src 'none'; script-src ${sha(script)}; style-src ${sha(style)}; img-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${text(data.heading)}</title><style>${style}</style></head>`
    + `<body><div id="viewer"></div><script type="application/json" id="viewer-data">${scriptJson(data)}</script><script>${script}</script></body></html>\n`;
  const bytes = Buffer.byteLength(html);
  need(bytes <= maxBytes, `This viewer would be ${(bytes / 1048576).toFixed(1)} MiB, over the 4 MiB limit. Choose fewer ideas, or leave out findings.`, 413);
  return { html, data, filename: downloadName(map.title, '-viewer.html'), revision: map.revision, count: data.nodes.length, bytes };
}
