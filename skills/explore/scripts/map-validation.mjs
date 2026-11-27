// Map validation (H1): what a well-formed map.json looks like, checked without a server. Pure and
// dependency-free, so the Store, the validate command and later merge tools share one set of rules.
// Problems name a code, a location such as `nodes[3].parentId` and a message; they never quote map content.

export const nodeKinds = ['idea', 'question', 'research', 'decision', 'risk'];
export const semanticRelations = ['depends_on', 'supports', 'contradicts', 'related_to'];
const edgeTypes = new Set(['contains', ...semanticRelations]);
const workStates = new Set(['suggested', 'queued', 'running', 'awaiting-answer', 'explored', 'interrupted']);
const reviewStates = new Set(['unreviewed', 'accepted', 'cleared']);
const jobStates = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
const openJob = job => job.status === 'queued' || job.status === 'running';

// JSON strings cannot contain raw line breaks, so a line starting with a marker is never map content.
export const hasConflictMarkers = raw => /^(<{7}|={7}|>{7})(\s|$)/m.test(raw);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string';
const httpUrl = value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };

export function validateMap(map, { folderId } = {}) {
  const errors = [], warnings = [];
  const error = (code, at, message) => errors.push({ code, at, message });
  // A field of the wrong shape is reported once, and the checks that depend on it are skipped.
  const field = (record, key, at, test, required = true) => {
    if (record[key] === undefined && !required) return false;
    if (test(record[key])) return true;
    error('invalid-field', at, `${at} is missing or has the wrong type.`); return false;
  };
  if (!isRecord(map)) { error('invalid-field', 'map', 'The file is not a JSON object.'); return { errors, warnings }; }
  if (map.schemaVersion !== 1) { error('unsupported-version', 'schemaVersion', 'Only schema version 1 is supported.'); return { errors, warnings }; }
  if (field(map, 'id', 'id', isText) && folderId && map.id !== folderId) error('id-mismatch', 'id', `The map id does not match its folder (${folderId}).`);
  field(map, 'title', 'title', isText);
  field(map, 'revision', 'revision', Number.isSafeInteger);
  field(map, 'updatedAt', 'updatedAt', isText);
  field(map, 'history', 'history', Array.isArray);
  const nodes = field(map, 'nodes', 'nodes', value => Array.isArray(value) && value.length > 0) ? map.nodes : [];
  const edges = field(map, 'edges', 'edges', Array.isArray) ? map.edges : [];
  const jobs = field(map, 'jobs', 'jobs', Array.isArray) ? map.jobs : [];

  const ids = new Map(), questionIds = new Set();
  nodes.forEach((node, i) => {
    const at = `nodes[${i}]`;
    if (!isRecord(node)) { error('invalid-field', at, `${at} is not an object.`); return; }
    if (field(node, 'id', `${at}.id`, isText)) { if (ids.has(node.id)) error('duplicate-id', `${at}.id`, `Idea ${node.id} appears more than once.`); else ids.set(node.id, node); }
    field(node, 'title', `${at}.title`, isText);
    for (const key of ['prompt', 'summary', 'body']) field(node, key, `${at}.${key}`, isText, false);
    if (field(node, 'kind', `${at}.kind`, isText) && !nodeKinds.includes(node.kind)) error('unknown-value', `${at}.kind`, `${at}.kind is not a known kind.`);
    if (field(node, 'status', `${at}.status`, isText) && !workStates.has(node.status)) error('unknown-value', `${at}.status`, `${at}.status is not a known work state.`);
    if (field(node, 'reviewState', `${at}.reviewState`, isText) && !reviewStates.has(node.reviewState)) error('unknown-value', `${at}.reviewState`, `${at}.reviewState is not a known review state.`);
    field(node, 'parentId', `${at}.parentId`, value => value === null || isText(value), false);
    field(node, 'stale', `${at}.stale`, value => typeof value === 'boolean', false);
    if (field(node, 'questions', `${at}.questions`, Array.isArray)) node.questions.forEach((question, j) => {
      const qat = `${at}.questions[${j}]`;
      if (!isRecord(question)) { error('invalid-field', qat, `${qat} is not an object.`); return; }
      if (field(question, 'id', `${qat}.id`, isText)) { if (questionIds.has(question.id)) error('duplicate-id', `${qat}.id`, `Question ${question.id} appears more than once.`); questionIds.add(question.id); }
      field(question, 'text', `${qat}.text`, isText);
      field(question, 'answer', `${qat}.answer`, value => value === null || isText(value), false);
    });
    if (field(node, 'sources', `${at}.sources`, Array.isArray)) node.sources.forEach((source, j) => {
      if (!isRecord(source) || !isText(source.url) || !httpUrl(source.url)) error('source-url', `${at}.sources[${j}].url`, 'Sources must link with HTTP or HTTPS.');
    });
  });
  const exists = id => ids.has(id);
  if (field(map, 'rootId', 'rootId', isText) && nodes.length && !exists(map.rootId)) error('missing-node', 'rootId', `The root idea ${map.rootId} does not exist.`);
  nodes.forEach((node, i) => {
    if (!isRecord(node) || !isText(node.parentId)) return;
    if (!exists(node.parentId)) { error('missing-node', `nodes[${i}].parentId`, `The parent ${node.parentId} does not exist.`); return; }
    // Walking up must reach the top; meeting this idea again means its parents form a loop.
    for (let at = ids.get(node.parentId), steps = 0; at; at = isText(at.parentId) ? ids.get(at.parentId) : null) {
      if (at === node || ++steps > nodes.length) { error('parent-cycle', `nodes[${i}].parentId`, `The parents of ${node.id} form a loop.`); break; }
    }
  });

  edges.forEach((edge, i) => {
    const at = `edges[${i}]`;
    if (!isRecord(edge)) { error('invalid-field', at, `${at} is not an object.`); return; }
    if (field(edge, 'type', `${at}.type`, isText) && !edgeTypes.has(edge.type)) error('unknown-value', `${at}.type`, `${at}.type is not a known link type.`);
    for (const end of ['from', 'to']) if (field(edge, end, `${at}.${end}`, isText) && !exists(edge[end])) error('missing-node', `${at}.${end}`, `The linked idea ${edge[end]} does not exist.`);
    if (edge.type === 'contains' && exists(edge.to) && ids.get(edge.to).parentId !== edge.from) warnings.push({ code: 'contains-parent', at, message: `${edge.to} is contained by ${edge.from} but has a different parent.` });
  });

  const jobIds = new Set(), open = new Set();
  jobs.forEach((job, i) => {
    const at = `jobs[${i}]`;
    if (!isRecord(job)) { error('invalid-field', at, `${at} is not an object.`); return; }
    if (field(job, 'id', `${at}.id`, isText)) { if (jobIds.has(job.id)) error('duplicate-id', `${at}.id`, `Job ${job.id} appears more than once.`); jobIds.add(job.id); }
    if (field(job, 'status', `${at}.status`, isText) && !jobStates.has(job.status)) error('unknown-value', `${at}.status`, `${at}.status is not a known job state.`);
    // Work covering the whole map has no idea; unknown job types belong to newer versions and are kept.
    if (field(job, 'nodeId', `${at}.nodeId`, value => value === null || isText(value), false) && isText(job.nodeId) && !exists(job.nodeId)) error('missing-node', `${at}.nodeId`, `The job's idea ${job.nodeId} does not exist.`);
    if (openJob(job)) {
      const key = JSON.stringify([job.type ?? 'investigate', job.nodeId ?? null, job.subjectId ?? null]);
      if (open.has(key)) error('duplicate-open-job', at, 'Two open jobs of one kind are waiting on the same idea.');
      open.add(key);
    }
  });

  if (map.growth !== undefined && !(isRecord(map.growth) && map.growth.version === 1 && Array.isArray(map.growth.batches))) error('invalid-growth', 'growth', 'Growth history must be { version: 1, batches: [...] }.');
  else (map.growth?.batches || []).forEach((batch, i) => {
    if (!isRecord(batch) || !Number.isSafeInteger(batch.sequence) || !isText(batch.at) || !Array.isArray(batch.nodeIds) || !Array.isArray(batch.edges)) error('invalid-growth', `growth.batches[${i}]`, `growth.batches[${i}] is malformed.`);
  });
  for (const [id, point] of Object.entries(isRecord(map.view?.positions) ? map.view.positions : {})) {
    if (!isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) error('invalid-position', `view.positions.${id}`, `The saved position of ${id} is not a pair of numbers.`);
  }
  return { errors, warnings };
}

// Checks the bytes of a map.json: encoding, size, Git conflict markers and JSON first, then the map itself.
export function checkMapFile(bytes, { folderId, maxBytes = 64 * 1024 * 1024 } = {}) {
  const fail = (code, message) => ({ map: null, errors: [{ code, at: 'map.json', message }], warnings: [] });
  if (bytes.length > maxBytes) return fail('too-large', `The file is larger than ${maxBytes} bytes.`);
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('invalid-utf8', 'The file is not valid UTF-8 text.'); }
  if (hasConflictMarkers(raw)) return fail('conflict-markers', 'This map has unresolved Git conflict markers. Resolve them, then validate again.');
  let map;
  try { map = JSON.parse(raw); } catch { return fail('invalid-json', 'The file is not valid JSON.'); }
  return { map, ...validateMap(map, { folderId }) };
}
