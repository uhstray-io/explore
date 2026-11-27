// Alerts when a result arrives (K12): a count in the tab title while the tab is hidden and, if the user turned
// them on, a browser notification. Only the open map is watched, and only agent results count: the user's own
// answers, activations and drags never complete a job. Alerts arrive only while this tab is open.
const isInvestigation = job => !job.type || job.type === 'investigate';

// Branch results that arrived between two snapshots of one map: investigations that became completed and are not
// stale. An idea now waiting for an answer has a question; any other has finished.
export function resultEvents(before, after) {
  const earlier = new Map((before?.jobs || []).map(job => [job.id, job.status]));
  return (after?.jobs || []).filter(job => isInvestigation(job) && job.status === 'completed' && !job.stale && earlier.get(job.id) !== 'completed')
    .map(job => after.nodes.find(node => node.id === job.nodeId)).filter(Boolean)
    .map(node => ({ nodeId: node.id, title: node.title, kind: node.status === 'awaiting-answer' ? 'question' : 'finished' }));
}
// What a notification says: the map and idea titles only, never findings, questions or answers, because
// notifications can appear on a lock screen.
export function alertText(mapTitle, events) {
  if (events.length === 1) return { title: mapTitle, body: `${events[0].title} ${events[0].kind === 'question' ? 'has a question for you' : 'finished'}` };
  const questions = events.filter(event => event.kind === 'question').length;
  return { title: mapTitle, body: `${events.length} ideas updated${questions ? `, ${questions} with a question for you` : ''}` };
}
export const badgeTitle = (count, base = 'Explore') => count ? `(${count}) ${base}` : base;
export const notifyKey = 'explore-notify';

// The page side. `notice(before, after)` is called with each new snapshot of the open map. Results a few seconds
// apart (`groupMs`) become one notification; clicking it focuses the tab and the idea.
export function createAlerts({ focusNode, doc = document, win = window, storage = localStorage, groupMs = 3000 }) {
  const base = doc.title;
  let unseen = 0, waiting = [], timer = null;
  const wanted = () => { try { return storage.getItem(notifyKey) === 'on'; } catch { return false; } };
  const allowed = () => typeof win.Notification === 'function' && win.Notification.permission === 'granted';
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) { unseen = 0; doc.title = base; } });
  function send(mapTitle) {
    const events = waiting; waiting = []; timer = null;
    if (!events.length || !doc.hidden || !wanted() || !allowed()) return;
    const { title, body } = alertText(mapTitle, events);
    const notification = new win.Notification(title, { body, tag: 'explore-result' });
    notification.onclick = () => { win.focus(); focusNode(events[0].nodeId); notification.close(); };
  }
  return {
    notice(before, after) {
      if (!doc.hidden || !before || before.id !== after.id) return;
      const events = resultEvents(before, after); if (!events.length) return;
      unseen += events.length; doc.title = badgeTitle(unseen, base);
      waiting.push(...events); clearTimeout(timer); timer = setTimeout(() => send(after.title), groupMs);
    },
  };
}
