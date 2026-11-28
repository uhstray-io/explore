// Result checks (K3): the skill's own exploration rules, applied to an investigation result before it is
// saved. Errors are certain breaches (re-asking what the user already answered, or dismissed on this idea, or
// repeating something in one result): the result is rejected and the agent fixes and resends it with the same claim.
// Everything heuristic is only a warning, so a false positive never blocks delivery.
import { comparableText as normal } from '../assets/workspace-view.js';

const keys = texts => new Set(texts.map(normal));
const quote = value => { const text = String(value).replace(/\s+/g, ' ').trim(); return `“${text.length > 120 ? `${text.slice(0, 119)}…` : text}”`; };
// The idea's existing direction with this title, if any. A delivery skips such a suggestion.
export const existingChild = (map, node, title) => map.nodes.find(n => n.parentId === node.id && normal(n.title) === normal(title)) ?? null;

const questionWord = /^(what|which|who|whom|whose|when|where|why|how)\b/i;
// More than one question mark, or two clauses joined by "and"/"or" that each start with a question word. The
// benchmark (scripts/benchmark.mjs) reuses this and the note check on saved maps.
export function compoundQuestion(text) {
  if ((text.match(/\?/g) || []).length > 1) return true;
  const [first, ...rest] = text.split(/,?\s+\b(?:and|or)\b\s+/i).map(part => part.trim());
  return questionWord.test(first) && rest.some(part => questionWord.test(part));
}
// A note that only repeats the title, or is too short to state a claim. Notes arrive trimmed.
export const weakSourceNote = source => normal(source.note) === normal(source.title) || source.note.split(/\s+/).length < 5;

// `result` is a structurally valid, normalized investigation result for `node`. Each finding is
// { code, field, message }; `field` names the item, such as `questions[1]`.
export function checkAgainstMap(result, map, node) {
  const errors = [], warnings = [], earlier = map.nodes.flatMap(n => n.questions);
  const answered = keys(earlier.filter(q => q.answer && !q.supersededAt).map(q => q.text));
  // A dismissal means "not useful here": the agent sees this idea's dismissals, not every branch's.
  const dismissedHere = keys(node.questions.filter(q => q.dismissedAt && !q.supersededAt).map(q => q.text));
  const dismissedElsewhere = keys(map.nodes.filter(n => n.id !== node.id).flatMap(n => n.questions).filter(q => q.dismissedAt && !q.supersededAt).map(q => q.text));
  const superseded = keys(earlier.filter(q => q.answer && q.supersededAt).map(q => q.text));
  const titles = keys(map.nodes.map(n => n.title)), seenQuestions = new Set(), seenTitles = new Set();
  result.questions.forEach((question, i) => {
    const field = `questions[${i}]`, key = normal(question.text);
    if (answered.has(key)) errors.push({ code: 'answered-question', field, message: `${quote(question.text)} was already answered. Build on the saved answer instead of asking again.` });
    else if (dismissedHere.has(key)) errors.push({ code: 'dismissed-question', field, message: `${quote(question.text)} was dismissed by the user on this idea. Do not ask it again.` });
    else if (dismissedElsewhere.has(key)) warnings.push({ code: 'dismissed-elsewhere', field, message: `${quote(question.text)} was dismissed on another idea. Ask it here only if it matters for this one.` });
    else if (superseded.has(key)) warnings.push({ code: 'superseded-question', field, message: `${quote(question.text)} was answered under an earlier premise. Ask again only if the change makes that answer doubtful.` });
    if (seenQuestions.has(key)) errors.push({ code: 'duplicate-question', field, message: `${quote(question.text)} appears twice in this result.` });
    if (compoundQuestion(question.text)) warnings.push({ code: 'compound-question', field, message: `${quote(question.text)} may ask two things. Ask one thing per question.` });
    seenQuestions.add(key);
  });
  result.suggestions.forEach((suggestion, i) => {
    const field = `suggestions[${i}]`, key = normal(suggestion.title);
    if (seenTitles.has(key)) errors.push({ code: 'duplicate-suggestion', field, message: `${quote(suggestion.title)} appears twice in this result.` });
    else if (existingChild(map, node, suggestion.title)) warnings.push({ code: 'existing-branch', field, message: `${quote(suggestion.title)} is already a direction under this idea, so it is skipped.` });
    else if (titles.has(key)) warnings.push({ code: 'existing-branch', field, message: `${quote(suggestion.title)} matches an existing idea elsewhere in the map. Avoid duplicating existing directions.` });
    seenTitles.add(key);
  });
  result.sources.forEach((source, i) => {
    if (weakSourceNote(source)) warnings.push({ code: 'weak-source-note', field: `sources[${i}]`, message: `The note for ${quote(source.title)} states no claim. Say what the source supports or challenges.` });
  });
  return { errors, warnings };
}
