import { appliedResults } from './since-visit.js';
import { isWaiting } from './questions.js';

// Alerts when a result arrives (K12): a count in the tab title while the tab is hidden and, if the user turned
// them on, a browser notification. Only the open map is watched. A result is read from the map's event log, as
// "Since you were last here" reads it, so the user's own answers, activations and drags never count, and neither
// does a pull or a branch switch (an outside change), which no agent delivered.
const unique = events => [...new Map(events.map(event => [event.nodeId, event])).values()];

// Branch results that arrived between two snapshots of the open map. An idea whose result asked something that
// still waits has a question; any other has finished.
export function resultEvents(before, after) {
  if (after.outsideChange?.at !== before.outsideChange?.at) return [];
  const earlier = before.history || [], later = after.history || [];
  // Only events appended to the same log count; a replaced file is not news from an agent.
  if (earlier.length > later.length || (earlier.length && later[earlier.length - 1]?.at !== earlier.at(-1)?.at)) return [];
  return unique(appliedResults(after, later.slice(earlier.length)).map(({ node, jobId }) => ({ mapId: after.id, nodeId: node.id, title: node.title,
    kind: node.questions.some(question => question.jobId === jobId && isWaiting(question)) ? 'question' : 'finished' })));
}
// What a notification says: the map and idea titles only, never findings, questions or answers, because
// notifications can appear on a lock screen.
export function alertText(mapTitle, events) {
  if (events.length === 1) return { title: mapTitle, body: `${events[0].title} ${events[0].kind === 'question' ? 'has a question for you' : 'finished'}` };
  const questions = events.filter(event => event.kind === 'question').length;
  return { title: mapTitle, body: `${events.length} ideas updated${questions ? `, ${questions} with a question for you` : ''}` };
}
export const badgeTitle = (count, base = 'Explore') => count ? `(${count}) ${base}` : base;
// How often the app checks for changes: a hidden tab still checks, more slowly, so alerts can arrive.
export const pollDelay = hidden => hidden ? 15000 : 2500;

// The page side. `notice(before, after)` takes each new snapshot of the open map. Everything unseen since the tab
// was hidden makes up the count and the notification, which replaces the previous one and alerts again.
// Clicking it opens the idea. The opt-in lives here too: only setEnabled(true) ever asks the browser.
export function createAlerts({ open, doc = document, win = window, storage = localStorage, groupMs = 3000 }) {
  const base = doc.title, key = 'explore-notify';
  let unseen = [], timer = null;
  const permission = () => typeof win.Notification === 'function' ? win.Notification.permission : 'unavailable';
  const wanted = () => { try { return storage.getItem(key) === 'on'; } catch { return false; } };
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) { unseen = []; doc.title = base; } });
  const enabled = () => wanted() && permission() === 'granted';
  function send(mapTitle) {
    timer = null;
    if (!unseen.length || !doc.hidden || !enabled()) return;
    const { title, body } = alertText(mapTitle, unseen), first = unseen[0];
    const notification = new win.Notification(title, { body, tag: 'explore-result', renotify: true });
    notification.onclick = () => { win.focus(); open(first); notification.close(); };
  }
  return {
    notice(before, after) {
      if (!doc.hidden) return;
      const events = resultEvents(before, after); if (!events.length) return;
      unseen = unique([...unseen, ...events]); doc.title = badgeTitle(unseen.length, base);
      clearTimeout(timer); timer = setTimeout(() => send(after.title), groupMs); // Results a few seconds apart arrive as one.
    },
    // Whether this browser can show notifications here at all.
    available: () => permission() === 'default' || permission() === 'granted',
    enabled,
    // Turns notifications on or off; turning them on asks the browser, and only here. Resolves the outcome.
    async setEnabled(on) {
      if (on && permission() === 'default') await win.Notification.requestPermission();
      const result = on && permission() === 'granted';
      try { storage.setItem(key, result ? 'on' : 'off'); } catch {}
      return result;
    },
  };
}
