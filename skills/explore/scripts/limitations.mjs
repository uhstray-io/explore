// Conflicts and evidence gaps (C3). A result may record where sources disagree or evidence was not found, each
// with what it affects and a next step. They are the agent's account, kept apart from the findings text.
import { textField, recordId, citedSource } from './fields.mjs';
import { limitationKinds, limitationLabel, maxLimitations, limitationScope } from '../assets/limitations.js';
import { markdownText } from '../assets/workspace-view.js';

// Returns { limitations } to keep on the result, or {} when it has none. `checked` is the rest of the normalized
// result: records may cite only its sources and name only its options, and a record that blocks a recommendation
// needs one that recommends nothing. `fail(message)` throws the caller's validation error.
export function normalizeLimitations(result, checked, fail) {
  const need = (condition, message) => { if (!condition) fail(message); };
  const { limitations } = result;
  if (limitations === undefined) return {};
  need(Array.isArray(limitations) && limitations.length <= maxLimitations, `limitations must be a list of at most ${maxLimitations} records.`);
  if (!limitations.length) return {};
  const urls = new Set(checked.sources.map(source => source.url)), optionIds = new Set((checked.options || []).map(option => option.id)), ids = new Set();
  // A list of references, each checked (and kept as saved) by `clean`, none twice.
  const list = (value, field, noun, max, label, clean) => {
    if (value === undefined) return [];
    need(Array.isArray(value) && value.length <= max, `${label}: ${field} must be a list of at most ${max} items.`);
    const items = value.map(clean);
    need(new Set(items).size === items.length, `${label} lists the same ${noun} twice.`);
    return items;
  };
  return { limitations: limitations.map((record, index) => {
    const label = `Limitation ${index + 1}`;
    need(record && typeof record === 'object' && !Array.isArray(record), `${label} must be an object.`);
    recordId(record.id, { label, kind: 'Limitation', seen: ids }, fail);
    need(Object.hasOwn(limitationKinds, record.kind), `${label}: kind must be conflict or missing-evidence.`);
    const summary = textField(record.summary, `${label} summary`, 600, fail), nextStep = textField(record.nextStep, `${label} Next step`, 400, fail);
    const sources = list(record.sources, 'sources', 'source', 20, label, url => citedSource(url, urls, label, fail));
    if (record.kind === 'conflict') need(sources.length >= 2, `${label}: a conflict needs at least two of this result's sources.`);
    const scope = list(record.optionIds, 'optionIds', 'option', 4, label, id => { need(optionIds.has(id), `${label} names an option that is not in this result.`); return id; });
    need(record.blocksRecommendation === undefined || typeof record.blocksRecommendation === 'boolean', `${label}: blocksRecommendation must be true or false.`);
    if (record.blocksRecommendation) need(checked.recommendation?.optionId === null, `${label} blocks a recommendation, so the result needs options and a recommendation with optionId null.`);
    return { id: record.id, kind: record.kind, summary, nextStep, ...(sources.length ? { sources } : {}), ...(scope.length ? { optionIds: scope } : {}), ...(record.blocksRecommendation ? { blocksRecommendation: true } : {}) };
  }) };
}

// One record as lines. Section reads keep the text as saved, so an agent can resend it; node Markdown passes
// `format: markdownText` to keep each value on one line and escaped.
export function limitationRecord(node, record, format = text => text) {
  return [`- **${format(limitationLabel(record.kind))}** (${format(record.id)}): ${format(record.summary)}`, `  - Affects: ${format(limitationScope(node, record))}`,
    ...(record.sources?.length ? [`  - Sources: ${record.sources.join(', ')}`] : []), ...(record.blocksRecommendation ? ['  - Blocks a recommendation'] : []),
    `  - Next step: ${format(record.nextStep)}`];
}
export function limitationLines(node) {
  if (!node.limitations?.length) return [];
  return ['## Conflicts and evidence gaps', '', '_The agent\'s account of what is still unresolved, not a conclusion._', '', ...node.limitations.flatMap(record => limitationRecord(node, record, markdownText))];
}
