// A source's stance (K10): whether it supports the finding, challenges it or gives context. The one list, used by the
// result checks, the map validator, node Markdown, the context reader and the source library. It imports nothing.
export const stanceWords = { supports: 'Supports', challenges: 'Challenges', context: 'Context' };
// A source's recorded stance, or null: none recorded, or a value that is not one (a hand edit the validator reports).
export const stanceOf = source => (typeof source?.stance === 'string' && Object.hasOwn(stanceWords, source.stance) ? source.stance : null);
