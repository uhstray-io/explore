// Map validation (H1): the one place that decides what a map.json may contain. The Store reads every map
// through decodeMap and readProblem, so it refuses exactly the problems marked `unreadable`; the validate
// command reports all of them. Pure and dependency-free. Each problem has a code, a location such as
// `nodes[3].parentId` and a fixed message, never a value from the file, which may be private or crafted.

export const mapFolderPattern = /^map-[a-f0-9]{8}$/;
export const validId = value => typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value);
export const nodeKinds = new Set(['idea', 'question', 'research', 'decision', 'risk']);
export const semanticRelations = new Set(['depends_on', 'supports', 'contradicts', 'related_to']);
const edgeTypes = new Set(['contains', ...semanticRelations]);
const workStates = new Set(['suggested', 'queued', 'running', 'awaiting-answer', 'explored', 'interrupted']);
const reviewStates = new Set(['unreviewed', 'accepted', 'cleared']);
const jobStates = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
export const isOpenJob = job => job.status === 'queued' || job.status === 'running';
// At most one open job of a kind per idea (or the whole map) and subject.
export const openJobKey = job => JSON.stringify([job.type ?? 'investigate', job.nodeId ?? null, job.subjectId ?? null]);

// Why the server will not open a map, in plain words.
export const unreadableMessages = {
  'invalid-utf8': 'This map file is not valid UTF-8 text. Restore it from Git or a preserved copy.',
  'conflict-markers': 'This map has unresolved Git conflict markers. Resolve them in its map.json, then open it again.',
  'invalid-json': 'This map file is not valid JSON. Restore it from Git or a preserved copy.',
  'unsupported-version': 'This map uses an unsupported format version.',
  'invalid-map': 'This map file is missing required parts or belongs to another folder. Restore it from Git or a preserved copy.',
  'too-large': 'This map file is larger than 64 MiB. Restore it from Git or a preserved copy.',
};
export const maxMapBytes = 64 * 1024 * 1024;
// JSON strings cannot contain raw line breaks, so a line starting with a marker is never map content.
export const hasConflictMarkers = raw => /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);
// Bytes to a parsed map, with one policy for everyone: strict UTF-8, and a leading byte-order mark is ignored.
export function decodeMap(bytes) {
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { problem: 'invalid-utf8' }; }
  if (hasConflictMarkers(raw)) return { problem: 'conflict-markers' };
  try { return { map: JSON.parse(raw) }; } catch { return { problem: 'invalid-json' }; }
}
// What the server reads from these bytes as the map in `folderId`: { map }, or the { problem } it cannot open.
export function readMapFile(bytes, folderId) {
  if (bytes.length > maxMapBytes) return { problem: 'too-large' };
  const decoded = decodeMap(bytes);
  if (decoded.problem) return decoded;
  const problem = readProblem(decoded.map, folderId);
  return problem ? { problem } : decoded;
}
// The reason, if any, that the server cannot open this parsed map.
export function readProblem(map, folderId) {
  const blocking = validateMap(map, { folderId }).errors.find(error => error.unreadable);
  return !blocking ? null : blocking.code === 'unsupported-version' ? 'unsupported-version' : 'invalid-map';
}

// Generated Markdown names the revision it was made from, so an out-of-date view can be found.
export const generatedFrom = revision => `Generated from map revision ${revision}.`;
export function generatedRevision(text) { const match = String(text).match(/Generated (?:from|view of) map revision (\d+)\./); return match ? Number(match[1]) : null; }

const messages = {
  'invalid-field': 'This field is missing or has the wrong type.',
  'invalid-id': 'This is not a valid Explore ID (lowercase letters, digits and hyphens).',
  'unknown-value': 'This is not one of the values Explore knows.',
  'unsupported-version': 'Only schema version 1 is supported.',
  'id-mismatch': 'The map ID does not match its folder.',
  'duplicate-id': 'This ID is used more than once.',
  'missing-node': 'This points at an idea that does not exist.',
  'parent-cycle': 'The parents of this idea form a loop.',
  'duplicate-open-job': 'Another open job of the same kind is already waiting on this idea.',
  'source-url': 'Sources must link with HTTP or HTTPS.',
  'invalid-growth': 'Growth history is malformed.',
  'invalid-position': 'A saved position must be a pair of numbers.',
  'contains-parent': "A containment link disagrees with the idea's parent.",
};

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string';
const httpUrl = value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
const isGrowth = value => isRecord(value) && value.version === 1 && Array.isArray(value.batches);
// A field rule: `test` accepts good values and `code` names a failure. `optional` lets the field be absent
// and `nullable` lets it be null. `unreadable` marks failures the server cannot open a map with; it can
// be a test of the value, as for IDs, where anything but text is unreadable but an unusual string is not.
const rule = (test, options = {}) => ({ test, code: 'invalid-field', optional: false, nullable: false, unreadable: false, ...options });
const text = options => rule(isText, options);
const list = options => rule(Array.isArray, options);
const oneOf = (values, options) => rule(value => values.has(value), { code: 'unknown-value', ...options });
const anId = ({ unreadable = false, ...options } = {}) => rule(validId, { code: 'invalid-id', ...options, unreadable: unreadable ? value => !isText(value) : false });
const shapes = {
  map: { id: anId({ unreadable: true }), title: text({ unreadable: true }), revision: rule(Number.isSafeInteger, { unreadable: true }), updatedAt: text({ unreadable: true }),
    rootId: anId(), nodes: rule(value => Array.isArray(value) && value.length > 0, { unreadable: true }), edges: list({ unreadable: true }), jobs: list({ unreadable: true }),
    history: list({ unreadable: true }), view: rule(isRecord, { optional: true }), growth: rule(isGrowth, { code: 'invalid-growth', optional: true }) },
  // Generated views read every idea's title and summary and every source's title, so those must be text too.
  node: { id: anId({ unreadable: true }), title: text({ unreadable: true }), kind: oneOf(nodeKinds), status: oneOf(workStates), reviewState: oneOf(reviewStates),
    prompt: text({ optional: true }), summary: text({ unreadable: true }), body: text({ optional: true }), parentId: anId({ optional: true, nullable: true }),
    stale: rule(value => typeof value === 'boolean', { optional: true }), questions: list({ unreadable: true }), sources: list({ unreadable: true }) },
  question: { id: anId(), text: text(), answer: text({ optional: true, nullable: true }) },
  source: { title: text({ unreadable: true }), url: rule(httpUrl, { code: 'source-url' }) },
  edge: { from: anId(), to: anId(), type: oneOf(edgeTypes) },
  job: { id: anId(), status: oneOf(jobStates), nodeId: anId({ optional: true, nullable: true }) },
  batch: { sequence: rule(Number.isSafeInteger, { code: 'invalid-growth' }), at: text({ code: 'invalid-growth' }), nodeIds: list({ code: 'invalid-growth' }), edges: list({ code: 'invalid-growth' }) },
};

export function validateMap(map, { folderId } = {}) {
  const errors = [], warnings = [];
  const report = (code, at, unreadable = false) => errors.push({ code, at, message: messages[code], ...(unreadable ? { unreadable: true } : {}) });
  // Each field of a record against its table; false when the record itself is missing.
  const check = (value, shape, at, { unreadable = false } = {}) => {
    if (!isRecord(value)) { report('invalid-field', at || 'map', unreadable); return false; }
    for (const [key, field] of Object.entries(shape)) {
      const item = value[key];
      if ((item === undefined && field.optional) || (item === null && field.nullable) || field.test(item)) continue;
      report(field.code, at ? `${at}.${key}` : key, typeof field.unreadable === 'function' ? field.unreadable(item) : field.unreadable);
    }
    return true;
  };
  if (!isRecord(map)) { report('invalid-field', 'map', true); return { errors, warnings }; }
  if (map.schemaVersion !== 1) { report('unsupported-version', 'schemaVersion', true); return { errors, warnings }; }

  // Shapes.
  check(map, shapes.map, '');
  if (folderId && isText(map.id) && map.id !== folderId) report('id-mismatch', 'id', true);
  const nodes = Array.isArray(map.nodes) ? map.nodes : [], edges = Array.isArray(map.edges) ? map.edges : [], jobs = Array.isArray(map.jobs) ? map.jobs : [];
  nodes.forEach((node, i) => {
    if (!check(node, shapes.node, `nodes[${i}]`, { unreadable: true })) return;
    if (Array.isArray(node.questions)) node.questions.forEach((question, j) => check(question, shapes.question, `nodes[${i}].questions[${j}]`));
    if (Array.isArray(node.sources)) node.sources.forEach((source, j) => check(source, shapes.source, `nodes[${i}].sources[${j}]`));
  });
  edges.forEach((edge, i) => check(edge, shapes.edge, `edges[${i}]`, { unreadable: true }));
  jobs.forEach((job, i) => check(job, shapes.job, `jobs[${i}]`, { unreadable: true }));
  if (isGrowth(map.growth)) map.growth.batches.forEach((batch, i) => check(batch, shapes.batch, `growth.batches[${i}]`));

  // References.
  const ids = new Map(), questionIds = new Set(), jobIds = new Set(), open = new Set();
  nodes.forEach((node, i) => {
    if (!isRecord(node) || !isText(node.id)) return;
    if (ids.has(node.id)) report('duplicate-id', `nodes[${i}].id`); else ids.set(node.id, node);
    if (Array.isArray(node.questions)) node.questions.forEach((question, j) => {
      if (!isRecord(question) || !isText(question.id)) return;
      if (questionIds.has(question.id)) report('duplicate-id', `nodes[${i}].questions[${j}].id`); else questionIds.add(question.id);
    });
  });
  const missing = id => isText(id) && !ids.has(id);
  if (nodes.length && missing(map.rootId)) report('missing-node', 'rootId');
  nodes.forEach((node, i) => {
    if (!isRecord(node) || !isText(node.parentId)) return;
    if (missing(node.parentId)) { report('missing-node', `nodes[${i}].parentId`); return; }
    // Walking up must reach the top; meeting this idea again means its parents form a loop.
    for (let at = ids.get(node.parentId), steps = 0; at; at = isText(at.parentId) ? ids.get(at.parentId) : null) {
      if (at === node || ++steps > nodes.length) { report('parent-cycle', `nodes[${i}].parentId`); break; }
    }
  });
  edges.forEach((edge, i) => {
    if (!isRecord(edge)) return;
    for (const end of ['from', 'to']) if (missing(edge[end])) report('missing-node', `edges[${i}].${end}`);
    if (edge.type === 'contains' && ids.has(edge.to) && ids.get(edge.to).parentId !== edge.from) warnings.push({ code: 'contains-parent', at: `edges[${i}]`, message: messages['contains-parent'] });
  });
  jobs.forEach((job, i) => {
    if (!isRecord(job)) return;
    if (isText(job.id)) { if (jobIds.has(job.id)) report('duplicate-id', `jobs[${i}].id`); jobIds.add(job.id); }
    // Work covering the whole map has no idea; unknown job types belong to newer versions and are kept.
    if (missing(job.nodeId)) report('missing-node', `jobs[${i}].nodeId`);
    if (isOpenJob(job)) { const key = openJobKey(job); if (open.has(key)) report('duplicate-open-job', `jobs[${i}]`); open.add(key); }
  });
  const positions = map.view?.positions;
  if (isRecord(map.view) && positions !== undefined && !isRecord(positions)) report('invalid-field', 'view.positions');
  for (const [key, point] of Object.entries(isRecord(positions) ? positions : {})) {
    if (!validId(key)) report('invalid-id', 'view.positions');
    else if (!isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) report('invalid-position', `view.positions.${key}`);
  }
  return { errors, warnings };
}

// Checks the bytes of a map.json: size and readability first, then the map itself.
export function checkMapFile(bytes, { folderId, maxBytes = maxMapBytes } = {}) {
  if (bytes.length > maxBytes) return { map: null, errors: [{ code: 'too-large', at: 'map.json', message: `The file is larger than ${maxBytes} bytes.`, unreadable: true }], warnings: [] };
  const { map, problem } = decodeMap(bytes);
  if (problem) return { map: null, errors: [{ code: problem, at: 'map.json', message: unreadableMessages[problem], unreadable: true }], warnings: [] };
  return { map, ...validateMap(map, { folderId }) };
}
