import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { workLabels, reviewWord, constellationLayout, treeOrder } from '../assets/graph.js';
import { hasCurrentAnswer, isWaiting, certaintyText } from '../assets/questions.js';
import { downloadName } from '../assets/workspace-view.js';
import { maxIdeas, maxBytes, xml, summaryOf, findingsOf, hasWrittenFindings } from '../assets/export-formats.js';
import { Problem, hasFindings } from './store.mjs';

// A read-only viewer file (I4): one HTML page holding only the ideas the user chose, which anyone can open offline.
// Map text is data in a JSON block and reaches the page only as text; a policy allows just the page's own script and
// style, by hash, so the file fetches nothing. Jobs, history, workers, claim keys, paths and tokens never go in.
const need = (condition, message, status = 400) => { if (!condition) throw new Problem(message, status); };

// What an idea's findings are worth, in the words the page shows: work state, then review. Findings research wrote
// and nobody accepted say "not accepted", whatever the work state, as the other exports say "unreviewed".
const labelsOf = node => {
  const review = reviewWord(node) || (hasWrittenFindings(node) ? 'not accepted' : null);
  return { labels: [workLabels[node.status] || node.status, review].filter(Boolean), review };
};

// What the file holds for `selection`, [{ id, answers, findings }]: each chosen idea's title, kind and states, and
// only the fields chosen for it, in tree order. A parent link exists only to a chosen parent, and the map title
// appears only when the root is chosen.
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
  const nodes = treeOrder(map).map(({ node }) => node).filter(node => chosen.has(node.id)).map(node => {
    const { answers, findings } = chosen.get(node.id);
    const out = { id: node.id, title: node.title, kind: node.kind, ...labelsOf(node), parentId: chosen.has(node.parentId) ? node.parentId : null, position: positions[node.id] ?? null };
    if (findings) {
      // Ideas saved before premises were kept apart hold only a body: once researched, that body is findings.
      const premise = node.prompt || (hasFindings(map, node) ? null : node.body), summary = summaryOf(node), written = findingsOf(node);
      Object.assign(out, premise ? { premise } : {}, summary ? { summary } : {}, written ? { findings: written } : {},
        { sources: (node.sources || []).map(({ title, url, note }) => ({ title, url, note })) });
    }
    if (answers) out.questions = node.questions.filter(question => !question.supersededAt && !question.dismissedAt)
      .map(question => hasCurrentAnswer(question) ? { text: question.text, answer: question.answer, certainty: certaintyText(question), status: 'answered' }
        : { text: question.text, answer: null, certainty: null, status: isWaiting(question) ? 'waiting' : 'later' });
    return out;
  });
  return { heading: chosen.has(map.rootId) ? map.title : 'Selected ideas', nodes };
}

// The file's own script and style, with line endings as a browser hashes them: an HTML parser turns CRLF into LF,
// so a Windows checkout's copy would never match a hash of its raw bytes.
const asset = name => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
export function viewerParts(read = asset) {
  const lf = text => text.replace(/\r\n?/g, '\n');
  return { script: lf(read('viewer-page.js')), style: lf(read('viewer.css')) };
}
// JSON safe inside a script block: nothing in it can close the block, open a comment, or end a line in JavaScript.
const unsafeInScript = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const scriptJson = value => JSON.stringify(value).replace(unsafeInScript, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sha = source => `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;

// `{ expectedRevision, nodes }` from the browser. Refuses a missing or stale revision and anything over 4 MiB.
export function viewerFile(map, { expectedRevision, nodes } = {}, { parts = viewerParts() } = {}) {
  need(Number.isInteger(expectedRevision), 'Say which map revision you previewed.');
  need(expectedRevision === map.revision, 'This map changed. Preview again.', 409);
  const data = viewerData(map, nodes), { script, style } = parts;
  const policy = `default-src 'none'; script-src ${sha(script)}; style-src ${sha(style)}; img-src 'none'; base-uri 'none'; form-action 'none'`;
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">`
    + `<meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${xml(data.heading)}</title><style>${style}</style></head>`
    + `<body><div id="viewer"></div><script type="application/json" id="viewer-data">${scriptJson(data)}</script><script>${script}</script></body></html>\n`;
  const bytes = Buffer.byteLength(html);
  need(bytes <= maxBytes, `This viewer would be ${(bytes / 1048576).toFixed(1)} MiB, over the 4 MiB limit. Choose fewer ideas, or leave out findings.`, 413);
  return { html, data, filename: downloadName(data.heading, '-viewer.html'), mapId: map.id, revision: map.revision, count: data.nodes.length, bytes };
}
