// Result checks (K3): the skill's own exploration rules, applied to an investigation result before it is
// saved. Errors are certain breaches (re-asking what the user already answered, or repeating something in
// one result): the result is rejected and the agent fixes and resends it with the same claim. Everything
// heuristic is only a warning, so a false positive never blocks delivery.

// Comparisons ignore case, repeated whitespace and trailing punctuation.
const normal = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?.!,;:…]+$/, '');
export const sameText = (a, b) => normal(a) === normal(b);
const quote = value => { const text = String(value).replace(/\s+/g, ' ').trim(); return `“${text.length > 120 ? `${text.slice(0, 119)}…` : text}”`; };

const questionWord = /^(what|which|who|whom|whose|when|where|why|how)\b/i;
// More than one question mark, or two clauses joined by "and"/"or" that each start with a question word.
function compound(text) {
  if ((text.match(/\?/g) || []).length > 1) return true;
  const [first, ...rest] = text.split(/,?\s+\b(?:and|or)\b\s+/i).map(part => part.trim());
  return questionWord.test(first) && rest.some(part => questionWord.test(part));
}
const weakNote = source => sameText(source.note, source.title) || source.note.trim() === source.url || source.note.trim().split(/\s+/).length < 5;

// `result` is a structurally valid, normalized investigation result for `node`. Each finding is
// { code, field, message }; `field` names the item, such as `questions[1]`.
export function checkResult(result, map, node) {
  const errors = [], warnings = [], earlier = map.nodes.flatMap(n => n.questions);
  const seenQuestions = [], seenTitles = [];
  result.questions.forEach((question, i) => {
    const field = `questions[${i}]`;
    if (earlier.some(q => q.answer && !q.supersededAt && sameText(q.text, question.text))) errors.push({ code: 'answered-question', field, message: `${quote(question.text)} was already answered. Build on the saved answer instead of asking again.` });
    else if (earlier.some(q => q.answer && q.supersededAt && sameText(q.text, question.text))) warnings.push({ code: 'superseded-question', field, message: `${quote(question.text)} was answered under an earlier premise. Ask again only if the change makes that answer doubtful.` });
    if (seenQuestions.some(text => sameText(text, question.text))) errors.push({ code: 'duplicate-question', field, message: `${quote(question.text)} appears twice in this result.` });
    if (compound(question.text)) warnings.push({ code: 'compound-question', field, message: `${quote(question.text)} may ask two things. Ask one thing per question.` });
    seenQuestions.push(question.text);
  });
  result.suggestions.forEach((suggestion, i) => {
    const field = `suggestions[${i}]`;
    if (seenTitles.some(title => sameText(title, suggestion.title))) errors.push({ code: 'duplicate-suggestion', field, message: `${quote(suggestion.title)} appears twice in this result.` });
    else if (map.nodes.some(n => n.parentId === node.id && sameText(n.title, suggestion.title))) warnings.push({ code: 'existing-branch', field, message: `${quote(suggestion.title)} is already a direction under this idea, so it is skipped.` });
    else if (map.nodes.some(n => sameText(n.title, suggestion.title))) warnings.push({ code: 'existing-branch', field, message: `${quote(suggestion.title)} matches an existing idea elsewhere in the map. Avoid duplicating existing directions.` });
    seenTitles.push(suggestion.title);
  });
  result.sources.forEach((source, i) => {
    if (weakNote(source)) warnings.push({ code: 'weak-source-note', field: `sources[${i}]`, message: `The note for ${quote(source.title)} states no claim. Say what the source supports or challenges.` });
  });
  return { errors, warnings };
}
