import test from 'node:test';
import assert from 'node:assert/strict';
import { importDialog } from '../skills/explore/assets/import-dialog.js';

// The map import flow, moved out of app.js. A small fake DOM; no server.
function setup(firstReply) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, innerHTML: '', value: '', open: false, files: [],
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, click() {} });
    }
    return elements.get(id);
  };
  globalThis.document = { querySelector: selector => element(selector.replace(/^#/, '')) };
  const calls = [], opened = [], toasts = [];
  const context = { reply: firstReply };
  importDialog({ api: async (route, body) => { calls.push([route, body]); return context.reply; }, esc: String, toast: message => toasts.push(message), refresh: async () => {}, openMap: async id => opened.push(id) });
  const pick = async text => { element('import-file').files = [{ text: async () => text }]; await element('import-file').fire('change'); };
  const choose = dataset => element('import-dialog').fire('click', { target: { closest: () => ({ dataset }) } });
  return { element, calls, opened, toasts, context, pick, choose };
}
const conflict = { conflict: { mapId: 'map-1', existing: { title: 'Here' }, incoming: { title: 'File' } } };

test('the same ID asks first; Import as a copy imports once and opens the copy', async () => {
  const io = setup(conflict);
  try {
    await io.pick(JSON.stringify({ id: 'map-1' }));
    assert.equal(io.element('import-dialog').open, true); assert.deepEqual(io.calls, [['/import', { data: { id: 'map-1' }, asCopy: false }]]);
    io.context.reply = { imported: 'map-2' };
    await io.choose({ importCopy: '' });
    assert.deepEqual(io.calls.at(-1), ['/import', { data: { id: 'map-1' }, asCopy: true }]); assert.deepEqual(io.opened, ['map-2']);
    assert.equal(io.element('import-dialog').open, false); assert.match(io.toasts.at(-1), /Map imported/);
    await io.choose({ importCopy: '' });
    assert.equal(io.calls.length, 2, 'a second click after the choice does nothing');
  } finally { delete globalThis.document; }
});

test('Keep the one here opens it without importing, and a file that is not JSON says so', async () => {
  const io = setup(conflict);
  try {
    await io.pick(JSON.stringify({ id: 'map-1' }));
    await io.choose({ importKeep: '' });
    assert.deepEqual(io.opened, ['map-1']); assert.equal(io.calls.length, 1, 'no second import'); assert.equal(io.element('import-dialog').open, false);
    await io.pick('not json');
    assert.match(io.toasts.at(-1), /not valid JSON/); assert.equal(io.calls.length, 1);
  } finally { delete globalThis.document; }
});
