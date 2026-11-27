import test from 'node:test';
import assert from 'node:assert/strict';
import { resultEvents, alertText, badgeTitle, pollDelay, createAlerts } from '../skills/explore/assets/alerts.js';

// Alert when a result arrives (K12, #58). Illustrative maps and a fake page only.
const at = minutes => new Date(Date.UTC(2026, 10, 27, 10, minutes)).toISOString();
const nodes = () => [{ id: 'n1', title: 'Sync', status: 'explored', questions: [] }, { id: 'n2', title: 'Battery', status: 'awaiting-answer', questions: [{ id: 'q', jobId: 'j2', answer: null }] }];
const snapshot = (history, extra = {}) => ({ id: 'map-a', title: 'Field notebook', nodes: nodes(), jobs: [], history, ...extra });
const base = [{ at: at(0), type: 'created', nodeId: 'n1' }];
const before = snapshot(base);
const after = snapshot([...base, { at: at(1), type: 'result', nodeId: 'n1', detail: 'j1' }, { at: at(2), type: 'result', nodeId: 'n2', detail: 'j2' }, { at: at(3), type: 'stale-result', nodeId: 'n1', detail: 'j3' }, { at: at(4), type: 'activated', nodeId: 'n1' }]);

test('a result is finished or has a question; stale results and the user\'s own changes are not', () => {
  assert.deepEqual(resultEvents(before, after), [
    { mapId: 'map-a', nodeId: 'n1', title: 'Sync', kind: 'finished' }, { mapId: 'map-a', nodeId: 'n2', title: 'Battery', kind: 'question' }]);
  assert.deepEqual(resultEvents(after, after), [], 'nothing new');
  assert.deepEqual(resultEvents(before, snapshot([...base, { at: at(1), type: 'result', nodeId: 'n1', detail: 'j1' }, { at: at(2), type: 'result', nodeId: 'n1', detail: 'j4' }])).length, 1, 'one idea counts once');
});

test('a pull, a branch switch or a replaced file is not an agent result', () => {
  assert.deepEqual(resultEvents(before, { ...after, outsideChange: { at: at(5) } }), [], 'an outside change');
  assert.deepEqual(resultEvents(snapshot([{ at: at(0), type: 'other' }, ...base]), after), [], 'a different log');
});

test('a notification names only the map and the ideas, never findings or questions', () => {
  assert.deepEqual(alertText('Field notebook', [{ title: 'Sync', kind: 'finished' }]), { title: 'Field notebook', body: 'Sync finished' });
  assert.deepEqual(alertText('Field notebook', [{ title: 'Battery', kind: 'question' }]), { title: 'Field notebook', body: 'Battery has a question for you' });
  assert.deepEqual(alertText('Field notebook', [{ title: 'Sync', kind: 'finished' }, { title: 'Battery', kind: 'question' }]), { title: 'Field notebook', body: '2 ideas updated, 1 with a question for you' });
  assert.equal(badgeTitle(0), 'Explore'); assert.equal(badgeTitle(2), '(2) Explore');
  assert.equal(pollDelay(true), 15000); assert.equal(pollDelay(false), 2500);
});

function page({ hidden = true, permission = 'granted', wanted = 'on', notifications = true } = {}) {
  const listeners = {}, shown = [], opened = [], stored = { 'explore-notify': wanted }, asked = [];
  const doc = { title: 'Explore', hidden, addEventListener: (type, listener) => { listeners[type] = listener; } };
  class FakeNotification { constructor(title, options) { this.title = title; this.options = options; shown.push(this); } close() {} static async requestPermission() { asked.push(true); FakeNotification.permission = 'granted'; return 'granted'; } }
  FakeNotification.permission = permission;
  const win = { focus() {}, ...(notifications ? { Notification: FakeNotification } : {}) };
  const storage = { getItem: key => stored[key] ?? null, setItem: (key, value) => { stored[key] = value; } };
  const alerts = createAlerts({ open: event => opened.push(event), doc, win, storage, groupMs: 0 });
  return { alerts, doc, shown, opened, stored, asked, show: () => { doc.hidden = false; listeners.visibilitychange(); } };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('while the tab is hidden a result adds a count to the title, and showing the tab clears it', () => {
  const { alerts, doc, show } = page({ wanted: 'off' });
  alerts.notice(before, after);
  assert.equal(doc.title, '(2) Explore');
  show(); assert.equal(doc.title, 'Explore');
  alerts.notice(before, after); assert.equal(doc.title, 'Explore', 'nothing while the tab is shown');
});

test('a notification covers everything unseen, alerts again, and opens the idea when clicked', async () => {
  const p = page();
  const firstOnly = snapshot([...base, { at: at(1), type: 'result', nodeId: 'n1', detail: 'j1' }]);
  p.alerts.notice(before, firstOnly); await tick();
  p.alerts.notice(firstOnly, after); await tick();
  assert.equal(p.shown.length, 2); assert.equal(p.shown[1].options.body, '2 ideas updated, 1 with a question for you', 'the second covers both');
  assert.equal(p.shown[1].options.renotify, true);
  p.shown[1].onclick(); assert.deepEqual(p.opened, [{ mapId: 'map-a', nodeId: 'n1', title: 'Sync', kind: 'finished' }]);
});

test('notifications need the user\'s choice and the browser\'s permission; without them the badge still works', async () => {
  for (const options of [{ wanted: 'off' }, { permission: 'denied' }, { notifications: false }]) {
    const p = page(options);
    assert.doesNotThrow(() => p.alerts.notice(before, after)); await tick();
    assert.equal(p.shown.length, 0, JSON.stringify(options)); assert.equal(p.doc.title, '(2) Explore');
  }
  assert.equal(page({ permission: 'denied' }).alerts.available(), false);
  assert.equal(page({ notifications: false }).alerts.available(), false);
});

test('only turning notifications on asks the browser', async () => {
  const p = page({ permission: 'default', wanted: 'off' });
  p.alerts.notice(before, after); await tick();
  assert.deepEqual(p.asked, [], 'never while results arrive');
  assert.equal(await p.alerts.setEnabled(true), true); assert.deepEqual(p.asked, [true]); assert.equal(p.stored['explore-notify'], 'on');
  assert.equal(await p.alerts.setEnabled(false), false); assert.equal(p.stored['explore-notify'], 'off');
});
