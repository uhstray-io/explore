// Keeping focus on the same control when a dialog redraws its markup.
export const cssQuote = value => (globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
// A control as a selector to find it again after a redraw: its id, or all of its data attributes together, so two
// boxes that share one attribute (the same idea, different answers) stay apart. Null when it has neither.
export const controlKey = element => (element.id ? `#${cssQuote(element.id)}`
  : Object.entries(element.dataset ?? {}).map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${cssQuote(value)}"]`).join('') || null);
