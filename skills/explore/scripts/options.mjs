// Options and a conditional recommendation (C1). When a branch is really a choice, a result can
// compare 1–4 options and give one conditional recommendation, or say what is still missing.
// This is the agent's judgement, never a decision: only the user answers or accepts.
import { textField, recordId } from './fields.mjs';

const normal = value => value.trim().replace(/\s+/g, ' ').toLowerCase();

// Returns the comparison fields to keep on the result, or {} when the result has none.
// `fail(message)` throws the caller's validation error.
export function normalizeComparison(result, fail) {
  const need = (condition, message) => { if (!condition) fail(message); };
  const text = (value, field, max, optional = false) => textField(value, field, max, fail, { optional });
  const { options, optionsLimit, recommendation } = result;
  if (options === undefined) {
    need(recommendation === undefined, 'A recommendation needs options to recommend from.');
    need(optionsLimit === undefined, 'optionsLimit is allowed only with a single option.');
    return {};
  }
  need(Array.isArray(options) && options.length >= 1 && options.length <= 4, 'Give 1–4 options.');
  const ids = new Set(), titles = new Set();
  const normalized = options.map((option, index) => {
    need(option && typeof option === 'object' && !Array.isArray(option), `Option ${index + 1} must be an object.`);
    recordId(option.id, { label: `Option ${index + 1}`, kind: 'Option', seen: ids }, fail);
    const title = text(option.title, 'Option title', 150);
    need(!titles.has(normal(title)), 'Option titles must differ.'); titles.add(normal(title));
    const list = (value, field) => {
      if (value === undefined) return [];
      need(Array.isArray(value) && value.length <= 4, `${field} must be a list of at most 4 items.`);
      return value.map(item => text(item, field, 240));
    };
    const suggestedAnswer = text(option.suggestedAnswer, 'Suggested answer', 1000, true);
    return { id: option.id, title, description: text(option.description, 'Option description', 600), fit: text(option.fit, 'When it fits', 400),
      pros: list(option.pros, 'Pros'), cons: list(option.cons, 'Cons'), ...(suggestedAnswer ? { suggestedAnswer } : {}) };
  });
  if (normalized.length === 1) need(optionsLimit !== undefined, 'One option needs optionsLimit: say why there is no real alternative.');
  else need(optionsLimit === undefined, 'optionsLimit is allowed only with a single option.');
  need(recommendation !== undefined, 'A recommendation is required with options: recommend one, or use optionId null and say what is missing.');
  need(recommendation && typeof recommendation === 'object' && !Array.isArray(recommendation), 'The recommendation must be an object.');
  let chosen;
  if (recommendation.optionId === null) {
    need(typeof recommendation.missing === 'string' && recommendation.missing.trim(), 'Without a recommendation, say what is missing.');
    chosen = { optionId: null, missing: text(recommendation.missing, 'What is missing', 600) };
  }
  else {
    need(ids.has(recommendation.optionId), 'The recommendation names an option that is not in the list.');
    const reconsiderIf = text(recommendation.reconsiderIf, 'Reconsider if', 600, true);
    chosen = { optionId: recommendation.optionId, rationale: text(recommendation.rationale, 'The recommendation rationale', 800),
      mainTradeoff: text(recommendation.mainTradeoff, 'The main trade-off', 600), ...(reconsiderIf ? { reconsiderIf } : {}) };
  }
  return { options: normalized, ...(normalized.length === 1 ? { optionsLimit: text(optionsLimit, 'optionsLimit', 600) } : {}), recommendation: chosen };
}

// Plain-text lines for Markdown and section reads; the recommendation is always labelled as judgement.
// `comparison` is an idea's own or a question's research; `level` nests the headings under their section.
export function comparisonLines(comparison, { level = 2 } = {}) {
  if (!comparison.options?.length) return [];
  const heading = '#'.repeat(level), lines = [`${heading} Options`, ''];
  if (comparison.optionsLimit) lines.push(`_Only one real option: ${comparison.optionsLimit}_`, '');
  for (const option of comparison.options) {
    lines.push(`${heading}# ${option.title} (${option.id})`, '', option.description, '', `Fits when: ${option.fit}`);
    if (option.pros.length) lines.push(`Pros: ${option.pros.join('; ')}`);
    if (option.cons.length) lines.push(`Cons: ${option.cons.join('; ')}`);
    if (option.suggestedAnswer) lines.push(`Suggested answer (a draft, not the user's answer): ${option.suggestedAnswer}`);
    lines.push('');
  }
  lines.push(`${heading} Recommendation`, '', '_The agent\'s judgement, not a decision._', '');
  const r = comparison.recommendation;
  if (!r || r.optionId === null) lines.push(`No recommendation yet. Missing: ${r?.missing ?? 'not recorded'}`);
  else {
    const title = comparison.options.find(option => option.id === r.optionId)?.title ?? r.optionId;
    lines.push(`Recommended: ${title} (${r.optionId})`, `Why: ${r.rationale}`, `Main trade-off: ${r.mainTradeoff}`);
    if (r.reconsiderIf) lines.push(`Reconsider if: ${r.reconsiderIf}`);
  }
  return lines;
}
