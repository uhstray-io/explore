import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDialog } from '../skills/explore/assets/brief-dialog.js';
import { importDialog } from '../skills/explore/assets/import-dialog.js';

// The brief dialog and the import flow, moved out of app.js unchanged. A small fake DOM; no server.
function fakeDocument() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, open: false, dataset: {}, files: [],
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, select() {}, click() { return this.fire('click'); } });
    }
    return elements.get(id);
  };
  return { querySelector: selector => element(selector.replace(/^#/, '')), element };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the brief shows the latest request only, and falls back to selected text when copying fails', async () => {
  const doc = fakeDocument(); globalThis.document = doc;
  const pending = [];
  const api = route => new Promise(resolve => pending.push({ route, resolve }));
  try {
    const show = briefDialog({ api, map: () => ({ id: 'map-1' }), download() {} });
    show(); show('node-a');
    assert.deepEqual(pending.map(call => call.route), ['/maps/map-1/brief', '/maps/map-1/brief?node=node-a']);
    pending[1].resolve({ title: 'Branch', revision: 4, markdown: '# Branch', sections: [], counts: {}, glossary: { agreed: { items: [], omitted: 0 }, proposed: { items: [], omitted: 0 } } });
    await settle();
    pending[0].resolve({ title: 'Old', revision: 3, markdown: '# Old', sections: [], counts: {} });
    await settle();
    assert.equal(doc.element('brief-title').textContent, 'Branch brief');
    assert.match(doc.element('brief-status').textContent, /^Saved revision 4\./, 'the slower, older request is ignored');
    globalThis.navigator ??= {};
    const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    try {
      await doc.element('copy-brief').fire('click');
      assert.equal(doc.element('brief-copy-fallback').value, '# Branch'); assert.equal(doc.element('brief-copy-fallback').hidden, false);
    } finally { if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard); else delete globalThis.navigator.clipboard; }
  } finally { delete globalThis.document; }
});

test('an import with the same ID asks first, then imports a copy or opens the one here', async () => {
  const doc = fakeDocument(); globalThis.document = doc;
  const calls = [], opened = [], toasts = [];
  let reply = { conflict: { mapId: 'map-1', existing: { title: 'Here' }, incoming: { title: 'File' } } };
  const api = async (route, body) => { calls.push([route, body]); return reply; };
  try {
    importDialog({ api, esc: String, toast: message => toasts.push(message), refresh: async () => {}, openMap: async id => opened.push(id) });
    const file = doc.element('import-file');
    file.files = [{ text: async () => JSON.stringify({ id: 'map-1' }) }];
    await file.fire('change');
    assert.equal(doc.element('import-dialog').open, true); assert.deepEqual(calls, [['/import', { data: { id: 'map-1' }, asCopy: false }]]);
    reply = { imported: 'map-2' };
    await doc.element('import-dialog').fire('click', { target: { closest: () => ({ dataset: { importCopy: '' } }) } });
    assert.deepEqual(calls.at(-1), ['/import', { data: { id: 'map-1' }, asCopy: true }]); assert.deepEqual(opened, ['map-2']);
    assert.match(toasts.at(-1), /Map imported/);
    file.files = [{ text: async () => 'not json' }];
    await file.fire('change');
    assert.match(toasts.at(-1), /not valid JSON/);
  } finally { delete globalThis.document; }
});
