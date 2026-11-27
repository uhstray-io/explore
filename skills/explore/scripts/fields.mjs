// Field checks shared by the validators of agent results. Each takes `fail(message)`, which throws the
// caller's own error, so the Store, options and job types report problems the same way.

// Trimmed text of at most `max` characters. An optional field that is undefined, null or '' is absent.
export function textField(value, field, max, fail, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required.`);
  if (value.length > max) fail(`${field} must be at most ${max} characters.`);
  return value.trim();
}
export function safeUrl(value, fail) {
  const url = textField(value, 'Source URL', 2000, fail);
  let protocol = null;
  try { protocol = new URL(url).protocol; } catch {}
  if (protocol !== 'https:' && protocol !== 'http:') fail('Source URL must be a valid HTTP or HTTPS URL.');
  return url;
}
// Up to 20 sources the agent read, each with the claim it supports or challenges.
export function sourceList(value, fail, at = new Date().toISOString()) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail('Sources must be an array of at most 20 items.');
  return value.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('Source must be an object.');
    return { title: textField(s.title, 'Source title', 200, fail), url: safeUrl(s.url, fail), note: textField(s.note, 'Evidence note', 1500, fail), retrievedAt: at };
  });
}
