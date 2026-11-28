// Field checks shared by the validators of agent results. Each takes `fail(message)`, which throws the
// caller's own error, so the Store, options and job types report problems the same way.

import { stanceOf } from '../assets/sources.js';

// Trimmed text of at most `max` characters. An optional field that is undefined, null or '' is absent.
export function textField(value, field, max, fail, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required.`);
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value.trim();
}
// A record's identifier, unique among `seen`: a letter, then letters, digits, _ or -, at most 32 in all.
const idPattern = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// `label` names this record in a message ("Claim 2"), `kind` its list ("Claim").
export function recordId(value, { label, kind, seen }, fail) {
  if (typeof value !== 'string' || !idPattern.test(value)) fail(`${label} needs an identifier that starts with a letter (letters, digits, _ or -, at most 32).`);
  if (seen.has(value)) fail(`${kind} identifiers must be unique.`);
  seen.add(value);
  return value;
}
// A source a record cites, compared and kept as the result saved it (trimmed). `urls` is a Set of saved URLs.
export function citedSource(value, urls, label, fail) {
  const url = typeof value === 'string' ? value.trim() : null;
  if (!urls.has(url)) fail(`${label} cites a source that is not in this result's sources.`);
  return url;
}
export function safeUrl(value, fail) {
  const url = textField(value, 'Source URL', 2000, fail);
  let protocol = null;
  try { protocol = new URL(url).protocol; } catch {}
  if (protocol !== 'https:' && protocol !== 'http:') fail('Source URL must be a valid HTTP or HTTPS URL.');
  return url;
}
// Up to 20 sources the agent read, each with the claim it supports or challenges. An optional `stance` (K10) says
// whether the source supports the finding, challenges it or gives context (stanceWords). Left out, null or empty is
// none, stored as nothing, as for other optional fields; any other value rejects the result. `stance` false ignores
// it: Help me answer research has no finding for a source to support.
export function sourceList(value, fail, at = new Date().toISOString(), { stance: keepStance = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail('Sources must be an array of at most 20 items.');
  return value.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('Source must be an object.');
    const given = keepStance && s.stance !== undefined && s.stance !== null && s.stance !== '';
    if (given && !stanceOf(s)) fail('A source stance must be supports, challenges or context.');
    return { title: textField(s.title, 'Source title', 200, fail), url: safeUrl(s.url, fail), note: textField(s.note, 'Evidence note', 1500, fail), ...(given ? { stance: s.stance } : {}), retrievedAt: at };
  });
}
