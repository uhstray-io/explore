import test from 'node:test';
import assert from 'node:assert/strict';
import { briefDialog, briefFilename, briefPreview } from '../skills/explore/assets/brief-dialog.js';

// The brief dialog, moved out of app.js. A small fake DOM; no server.
function fakeDocument() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id, { id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, open: false,
        addEventListener(type, fn) { (handlers[type] ??= []).push(fn); }, fire(type, event = {}) { return Promise.all((handlers[type] || []).map(fn => fn(event))); },
        showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, select() {} });
    }
    return elements.get(id);
  };
  return { querySelector: selector => element(selector.replace(/^#/, '')), element };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const brief = (title, revision) => ({ title, revision, markdown: `# ${title}`, sections: [], counts: {} });

test('only the latest request shows, whether an older one succeeds or fails late', async () => {
  const doc = fakeDocument(); globalThis.document = doc;
  const pending = [];
  try {
    const show = briefDialog({ api: route => new Promise((resolve, reject) => pending.push({ route, resolve, reject })), map: () => ({ id: 'map-1' }), download() {} });
    show(); show('node-a');
    assert.deepEqual(pending.map(call => call.route), ['/maps/map-1/brief', '/maps/map-1/brief?node=node-a']);
    pending[1].resolve(brief('Branch', 4)); await settle();
    pending[0].resolve(brief('Old', 3)); await settle();
    assert.equal(doc.element('brief-title').textContent, 'Branch brief');
    assert.match(doc.element('brief-status').textContent, /^Saved revision 4\./, 'an older success is ignored');
    show(); show('node-a');
    pending[3].resolve(brief('Branch', 5)); await settle();
    pending[2].reject(new Error('offline')); await settle();
    assert.match(doc.element('brief-status').textContent, /^Saved revision 5\./, 'an older failure is ignored too');
  } finally { delete globalThis.document; }
});

test('Retry asks again for the same branch, and copying falls back to selected text', async () => {
  const doc = fakeDocument(); globalThis.document = doc;
  const routes = []; let fail = true;
  try {
    const show = briefDialog({ api: async route => { routes.push(route); if (fail) throw new Error('offline'); return brief('Branch', 4); }, map: () => ({ id: 'map-1' }), download() {} });
    await show('node-a');
    assert.equal(doc.element('retry-brief').hidden, false); assert.match(doc.element('brief-status').textContent, /Could not prepare the brief\. offline/);
    fail = false;
    await doc.element('retry-brief').fire('click');
    assert.deepEqual(routes, ['/maps/map-1/brief?node=node-a', '/maps/map-1/brief?node=node-a'], 'the branch, not the whole map');
    globalThis.navigator ??= {};
    const clipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    try {
      await doc.element('copy-brief').fire('click');
      assert.equal(doc.element('brief-copy-fallback').value, '# Branch'); assert.equal(doc.element('brief-copy-fallback').hidden, false);
    } finally { if (clipboard) Object.defineProperty(globalThis.navigator, 'clipboard', clipboard); else delete globalThis.navigator.clipboard; }
  } finally { delete globalThis.document; }
});
test('brief filenames remain usable for titles containing platform path characters', () => {
  assert.equal(briefFilename('Pricing / launch: Q4?'), 'Pricing - launch- Q4--brief.md');
  assert.equal(briefFilename(''), 'exploration-brief.md');
  assert.equal(briefFilename('Plan...'), 'Plan-brief.md');
  assert.ok(!briefFilename('../data\\node\u0000').includes('/'));
});

test('brief preview treats saved HTML and links as text while preserving stale and omission notices', () => {
  const brief = { originalIdea: '<img src=x onerror=alert(1)>', counts: { nodes: 3, explored: 2, accepted: 1, stale: 1, awaitingAnswer: 0 }, sections: [
    { label: '<script>alert(1)</script>', omitted: 2, items: [{ title: 'Research <b>title</b>', text: '[click](javascript:alert(1)) & <iframe>', nodeId: 'node-123', status: 'explored', reviewState: 'accepted', stale: true }] },
  ] };
  const html = briefPreview(brief);
  assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<iframe'));
  assert.ok(!html.includes('<a ') && !html.includes('<b>title'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Explored · needs review/);
  assert.match(html, /2 more records/);
  assert.match(html, /node-123/);
});
