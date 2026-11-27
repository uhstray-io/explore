import test from 'node:test';
import assert from 'node:assert/strict';
import { resultEvents, alertText, badgeTitle, createAlerts } from '../skills/explore/assets/alerts.js';

// Alert when a result arrives (K12, #58). Illustrative maps and a fake page only.
const map = (jobs, nodes = [{ id: 'n1', title: 'Sync', status: 'explored' }, { id: 'n2', title: 'Battery', status: 'awaiting-answer' }]) => ({ id: 'map-a', title: 'Field notebook', nodes, jobs });

test('a result is finished or has a question; stale results and the user\'s own changes are not', () => {
  const before = map([{ id: 'j1', nodeId: 'n1', status: 'running' }, { id: 'j2', nodeId: 'n2', status: 'running' }, { id: 'j3', nodeId: 'n1', status: 'running' }, { id: 'j4', nodeId: 'n1', type: 'question-help', status: 'running' }]);
  const after = map([{ id: 'j1', nodeId: 'n1', status: 'completed' }, { id: 'j2', nodeId: 'n2', status: 'completed' }, { id: 'j3', nodeId: 'n1', status: 'completed', stale: true }, { id: 'j4', nodeId: 'n1', type: 'question-help', status: 'completed' }, { id: 'j5', nodeId: 'n1', status: 'queued' }]);
  assert.deepEqual(resultEvents(before, after), [{ nodeId: 'n1', title: 'Sync', kind: 'finished' }, { nodeId: 'n2', title: 'Battery', kind: 'question' }]);
  assert.deepEqual(resultEvents(after, after), [], 'nothing new');
});

test('a notification names only the map and the ideas, never findings or questions', () => {
  assert.deepEqual(alertText('Field notebook', [{ title: 'Sync', kind: 'finished' }]), { title: 'Field notebook', body: 'Sync finished' });
  assert.deepEqual(alertText('Field notebook', [{ title: 'Battery', kind: 'question' }]), { title: 'Field notebook', body: 'Battery has a question for you' });
  assert.deepEqual(alertText('Field notebook', [{ title: 'Sync', kind: 'finished' }, { title: 'Battery', kind: 'question' }]), { title: 'Field notebook', body: '2 ideas updated, 1 with a question for you' });
  assert.equal(badgeTitle(0), 'Explore'); assert.equal(badgeTitle(2), '(2) Explore');
});

function page({ hidden = true, permission = 'granted', wanted = 'on', notifications = true } = {}) {
  const listeners = {}, shown = [], focused = [];
  const doc = { title: 'Explore', hidden, addEventListener: (type, listener) => { listeners[type] = listener; } };
  class FakeNotification { constructor(title, options) { this.title = title; this.options = options; shown.push(this); } close() {} }
  FakeNotification.permission = permission;
  const win = { focus() {}, ...(notifications ? { Notification: FakeNotification } : {}) };
  const storage = { getItem: () => wanted };
  const alerts = createAlerts({ focusNode: id => focused.push(id), doc, win, storage, groupMs: 0 });
  return { alerts, doc, shown, focused, show: () => { doc.hidden = false; listeners.visibilitychange(); } };
}
const before = map([{ id: 'j1', nodeId: 'n2', status: 'running' }]), after = map([{ id: 'j1', nodeId: 'n2', status: 'completed' }]);

test('while the tab is hidden a result adds a count to the title, and showing the tab clears it', async () => {
  const { alerts, doc, show } = page({ wanted: 'off' });
  alerts.notice(before, after);
  assert.equal(doc.title, '(1) Explore');
  show(); assert.equal(doc.title, 'Explore');
  alerts.notice(before, after); assert.equal(doc.title, 'Explore', 'nothing while the tab is shown');
});

test('a notification appears only when the user turned it on, the browser allows it and the tab is hidden', async () => {
  let p = page();
  p.alerts.notice(before, after); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(p.shown.length, 1); assert.equal(p.shown[0].title, 'Field notebook'); assert.equal(p.shown[0].options.body, 'Battery has a question for you');
  p.shown[0].onclick(); assert.deepEqual(p.focused, ['n2'], 'clicking it focuses that idea');
  for (const options of [{ wanted: 'off' }, { permission: 'denied' }, { notifications: false }]) {
    p = page(options);
    assert.doesNotThrow(() => p.alerts.notice(before, after));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(p.shown.length, 0, JSON.stringify(options)); assert.equal(p.doc.title, '(1) Explore', 'the badge still works');
  }
});

test('another map, or no earlier snapshot, never alerts', () => {
  const { alerts, doc } = page();
  alerts.notice(null, after); alerts.notice({ ...before, id: 'map-b' }, after);
  assert.equal(doc.title, 'Explore');
});
