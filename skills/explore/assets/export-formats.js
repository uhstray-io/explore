import { workLabels, constellationLayout } from './graph.js';
import { isWaiting, hasCurrentAnswer, certaintyText } from './questions.js';
import { markdownText, downloadName } from './workspace-view.js';

// Diagram and document exports (I3): the whole map, or one idea and everything below it, as Mermaid, JSON Canvas,
// SVG or a printable page. Pure, so the browser and the CLI make the same file from the same map. Every format shows
// work and review state, so a provisional finding never looks accepted, and none carries jobs, workers, claim keys,
// growth history or file paths. A scope that is too large is refused, never cut short.
export const maxIdeas = 500, maxBytes = 4 * 1024 * 1024;
export const exportFormats = {
  mermaid: { label: 'Mermaid diagram', ending: '.mmd', type: 'text/plain;charset=utf-8' },
  canvas: { label: 'JSON Canvas', ending: '.canvas', type: 'application/json;charset=utf-8' },
  svg: { label: 'SVG picture', ending: '.svg', type: 'image/svg+xml;charset=utf-8' },
  print: { label: 'Printable page', ending: '.html', type: 'text/html;charset=utf-8' },
};
const relationWords = { depends_on: 'depends on', supports: 'supports', contradicts: 'contradicts', related_to: 'related to' };
const palette = { ink: '#243e40', muted: '#5f7474', paper: '#fffef9', surface: '#f6f5f0', line: '#ccd8cf', blue: '#426eaa', teal: '#207566', orange: '#94611b', gray: '#81948c', edge: '#a6b7ae' };

// The ideas an export holds: all of them, or `nodeId` and its descendants by parent, in map order. Tree lines join
// an idea to its parent in scope; links (depends on, supports, contradicts, related to) need both ends in scope.
export function exportScope(map, nodeId = null) {
  const top = nodeId ? map.nodes.find(node => node.id === nodeId) : null;
  if (nodeId && !top) throw new Error('That idea is not in this map.');
  let nodes = map.nodes;
  if (top) {
    const ids = new Set([top.id]), children = new Map();
    for (const node of map.nodes) { if (!children.has(node.parentId)) children.set(node.parentId, []); children.get(node.parentId).push(node.id); }
    for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child); // A Set visits what is added while iterating.
    nodes = map.nodes.filter(node => ids.has(node.id));
  }
  const ids = new Set(nodes.map(node => node.id));
  return { top, nodes,
    tree: nodes.filter(node => node !== top && ids.has(node.parentId)).map(node => ({ from: node.parentId, to: node.id })),
    links: (map.edges || []).filter(edge => Object.hasOwn(relationWords, edge.type) && ids.has(edge.from) && ids.has(edge.to)).map(edge => ({ from: edge.from, to: edge.to, relation: relationWords[edge.type] })) };
}

// Work and review state in words. Research that nobody has accepted says "unreviewed", so it never reads as settled.
export function stateLabel(node) {
  const review = node.stale ? 'needs review' : node.reviewState === 'accepted' ? 'accepted' : node.reviewState === 'cleared' ? 'no longer relevant'
    : ['explored', 'awaiting-answer'].includes(node.status) ? 'unreviewed' : null;
  return [workLabels[node.status] || node.status, review].filter(Boolean).join(' · ');
}
const provisional = node => node.stale || (['explored', 'awaiting-answer'].includes(node.status) && !['accepted', 'cleared'].includes(node.reviewState));
const premiseOf = node => String(node.prompt || node.body || '');
// The summary and findings appear only once research wrote them; before that they repeat the premise.
const summaryOf = node => node.summary && !premiseOf(node).startsWith(node.summary) ? node.summary : null;
const findingsOf = node => node.body && node.body !== premiseOf(node) ? node.body : null;

export function exportAs(map, format, { nodeId = null, positions = null } = {}) {
  const spec = Object.hasOwn(exportFormats, format) ? exportFormats[format] : null;
  if (!spec) throw new Error(`Choose a format: ${Object.keys(exportFormats).join(', ')}.`);
  const scope = exportScope(map, nodeId);
  if (scope.nodes.length > maxIdeas) throw new Error(`This ${scope.top ? 'branch' : 'map'} has ${scope.nodes.length} ideas. An export holds at most ${maxIdeas}: export a smaller branch instead.`);
  const text = makers[format](map, scope, positions ?? constellationLayout(map).positions);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) throw new Error(`This export would be ${(bytes / 1048576).toFixed(1)} MiB, over the 4 MiB limit. Export a branch instead.`);
  return { text, filename: downloadName(scope.top ? `${map.title} - ${scope.top.title}` : map.title, spec.ending), type: spec.type, count: scope.nodes.length };
}

// Mermaid: generated IDs, and every label character outside a small safe set as an entity code (#34; for a quote),
// so no title can close a label, start a comment or directive, or add a click handler. Typographic dashes and quotes
// mean nothing to Mermaid, so they stay readable.
const mermaidText = value => [...String(value ?? '').replace(/\s+/g, ' ').trim()].map(char => /[\p{L}\p{N} .,·?!'()\-–—‘’“”…]/u.test(char) ? char : `#${char.codePointAt(0)};`).join('');
function mermaid(map, { nodes, tree, links }) {
  const short = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  return ['flowchart TD',
    ...nodes.map(node => `  ${short.get(node.id)}["${mermaidText(node.title)}<br/>${mermaidText(stateLabel(node))}"]`),
    ...tree.map(line => `  ${short.get(line.from)} --> ${short.get(line.to)}`),
    ...links.map(link => `  ${short.get(link.from)} -.->|${link.relation}| ${short.get(link.to)}`)].join('\n') + '\n';
}

// Cards around each idea's saved or laid-out centre: the layout is spread until cards clear each other, and any card
// still overlapping another (ideas saved on one spot) moves below it. Returns top-left corners.
function placeCards(nodes, positions, width, height, gap) {
  const points = nodes.map(node => positions[node.id] ?? { x: 0, y: 0 });
  let scale = 1;
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
    const dx = Math.abs(points[a].x - points[b].x), dy = Math.abs(points[a].y - points[b].y);
    const needed = Math.min(dx ? (width + gap) / dx : Infinity, dy ? (height + gap) / dy : Infinity);
    if (Number.isFinite(needed)) scale = Math.max(scale, needed);
  }
  scale = Math.min(scale, 6);
  const boxes = nodes.map((node, index) => ({ id: node.id, x: Math.round(points[index].x * scale - width / 2), y: Math.round(points[index].y * scale - height / 2) }));
  const placed = [], clear = (a, b) => a.x >= b.x + width + gap || b.x >= a.x + width + gap || a.y >= b.y + height + gap || b.y >= a.y + height + gap;
  for (const box of [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    for (let blocker = placed.find(other => !clear(box, other)); blocker; blocker = placed.find(other => !clear(box, other))) box.y = blocker.y + height + gap;
    placed.push(box);
  }
  return new Map(boxes.map(box => [box.id, box]));
}

// JSON Canvas 1.0: one text card per idea with title, state and summary (the premise until research writes one).
function canvas(map, { nodes, tree, links }, positions) {
  const width = 320, height = 190, boxes = placeCards(nodes, positions, width, height, 40);
  const card = node => ({ id: node.id, type: 'text', text: `## ${markdownText(node.title)}\n\n_${stateLabel(node)}_\n\n${markdownText(summaryOf(node) ?? premiseOf(node))}`,
    x: boxes.get(node.id).x, y: boxes.get(node.id).y, width, height });
  const edges = [...tree.map(line => ({ fromNode: line.from, toNode: line.to })), ...links.map(link => ({ fromNode: link.from, toNode: link.to, label: link.relation }))];
  return JSON.stringify({ nodes: nodes.map(card), edges: edges.map((edge, index) => ({ id: `edge-${index}`, ...edge })) }, null, '\t') + '\n';
}

// SVG: plain shapes and text only, all text XML-escaped. XML 1.0 forbids most control characters, so they become spaces.
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ' ').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function wrap(text, width = 26, lines = 3) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').flatMap(word => word.match(new RegExp(`.{1,${width}}`, 'gu')) ?? []);
  const out = [];
  for (const word of words) { if (out.length && (out.at(-1) + ' ' + word).length <= width) out[out.length - 1] += ' ' + word; else out.push(word); }
  return out.length > lines ? [...out.slice(0, lines - 1), `${out[lines - 1].slice(0, width - 1)}…`] : out;
}
// A halo in the background colour keeps text readable where a line passes behind it.
const halo = ` paint-order="stroke" stroke="${palette.surface}" stroke-width="4" stroke-linejoin="round"`;
const tone = node => node.stale || ['awaiting-answer', 'queued'].includes(node.status) ? palette.orange : node.status === 'running' ? palette.blue : node.status === 'explored' ? palette.teal : palette.gray;
function svg(map, { nodes, tree, links }, positions) {
  const width = 210, height = 112, pad = 30, boxes = placeCards(nodes, positions, width, height, 26);
  const all = [...boxes.values()], left = Math.min(...all.map(box => box.x)), top = Math.min(...all.map(box => box.y));
  const at = id => { const box = boxes.get(id); return { x: box.x - left + pad + width / 2, y: box.y - top + pad + 24 }; };
  const total = { w: Math.max(...all.map(box => box.x)) - left + width + pad * 2, h: Math.max(...all.map(box => box.y)) - top + height + pad * 2 };
  const line = (a, b, extra = '') => `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"${extra}/>`;
  const idea = node => {
    const centre = at(node.id), root = node.id === map.rootId, title = wrap(node.title);
    const dashed = ['queued', 'interrupted'].includes(node.status) ? ' stroke-dasharray="4 3"' : '';
    return `<g><circle cx="${centre.x}" cy="${centre.y}" r="${root ? 22 : 16}" fill="${palette.paper}" stroke="${tone(node)}" stroke-width="${root ? 2.5 : 1.8}"${dashed}/>`
      + `<text x="${centre.x}" y="${centre.y + 40}"${halo} text-anchor="middle" font-family="Georgia, serif" font-size="13" fill="${palette.ink}">${title.map((text, index) => `<tspan x="${centre.x}" dy="${index ? 16 : 0}">${xml(text)}</tspan>`).join('')}</text>`
      + `<text x="${centre.x}" y="${centre.y + 40 + title.length * 16 + 2}"${halo} text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="10" fill="${provisional(node) ? palette.orange : palette.muted}">${xml(stateLabel(node))}</text></g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total.w}" height="${total.h}" viewBox="0 0 ${total.w} ${total.h}" role="img">`
    + `<title>${xml(map.title)}</title><rect width="${total.w}" height="${total.h}" fill="${palette.surface}"/>`
    + `<g stroke="${palette.edge}" stroke-width="1.6">${tree.map(link => line(at(link.from), at(link.to))).join('')}</g>`
    + `<g stroke="${palette.blue}" stroke-width="1.2" stroke-dasharray="4 6">${links.map(link => line(at(link.from), at(link.to))).join('')}</g>`
    + `<g font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="10" fill="${palette.blue}" text-anchor="middle">${links.map(link => { const a = at(link.from), b = at(link.to); return `<text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 4}">${xml(link.relation)}</text>`; }).join('')}</g>`
    + nodes.map(idea).join('') + '</svg>\n';
}

// A printable page: no script, and a policy that would block one. An overview picture, then each idea in full.
const answerLine = question => question.supersededAt ? `Set aside when the premise changed${question.answer ? ` (the answer then: ${xml(question.answer)})` : ''}`
  : question.dismissedAt ? 'Dismissed' : hasCurrentAnswer(question) ? `${xml(question.answer)} <span class="certainty">(${xml(certaintyText(question))})</span>`
  : isWaiting(question) ? '<span class="waiting">Waiting for an answer</span>' : 'Saved for later';
const sourceUrl = url => /^https?:\/\//i.test(String(url ?? '')) ? `<a href="${xml(url)}">${xml(url)}</a>` : `<span class="url">${xml(url)}</span>`;
const printCss = `body{font:14px/1.6 'Segoe UI',Helvetica,Arial,sans-serif;color:${palette.ink};background:#fff;max-width:900px;margin:32px auto;padding:0 24px}h1,h2{font-family:Georgia,serif;font-weight:normal}h1{font-size:30px;margin:0 0 6px}h2{font-size:22px;margin:0 0 4px}h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:${palette.muted};margin:14px 0 4px}p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.scope,.note{color:${palette.muted};font-size:12px}.overview{margin:20px 0;overflow:auto}.overview svg{max-width:100%;height:auto}.idea{border-top:1px solid ${palette.line};padding:16px 0}.state{color:${palette.teal};font-size:12px}.state.provisional,.waiting{color:${palette.orange}}.certainty,.url{color:${palette.muted}}ul{padding-left:20px}li{margin:6px 0;overflow-wrap:anywhere}a{color:${palette.blue}}@media print{body{margin:0;max-width:none}.overview{break-after:page}.idea{break-inside:avoid-page}a{color:inherit}}`;
function print(map, scope, positions) {
  const section = node => {
    const summary = summaryOf(node), findings = findingsOf(node);
    return `<section class="idea"><h2>${xml(node.title)}</h2><p class="state${provisional(node) ? ' provisional' : ''}">${xml(stateLabel(node))}</p>`
      + `<h3>Premise</h3><p>${xml(premiseOf(node))}</p>`
      + (summary ? `<h3>Summary</h3><p>${xml(summary)}</p>` : '') + (findings ? `<h3>Findings</h3><p>${xml(findings)}</p>` : '')
      + (node.questions?.length ? `<h3>Questions</h3><ul>${node.questions.map(question => `<li><strong>${xml(question.text)}</strong><br>${answerLine(question)}</li>`).join('')}</ul>` : '')
      + (node.sources?.length ? `<h3>Sources</h3><ul>${node.sources.map(source => `<li>${xml(source.title)} — ${sourceUrl(source.url)}${source.note ? `<br>${xml(source.note)}` : ''}</li>`).join('')}</ul>` : '')
      + '</section>';
  };
  const title = scope.top ? `${map.title} - ${scope.top.title}` : map.title;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${xml(title)}</title><style>${printCss}</style></head><body>`
    + `<header><h1>${xml(map.title)}</h1><p class="scope">${scope.top ? `The idea “${xml(scope.top.title)}” and everything below it` : 'The whole map'} · ${scope.nodes.length} ${scope.nodes.length === 1 ? 'idea' : 'ideas'} · exported from Explore</p>`
    + '<p class="note">Each idea shows its work and review state. Findings marked unreviewed or needs review are provisional. To keep a PDF, choose Print, then Save as PDF.</p></header>'
    + `<figure class="overview">${svg(map, scope, positions)}</figure>\n${scope.nodes.map(section).join('\n')}\n</body></html>\n`;
}
const makers = { mermaid, canvas, svg, print };
