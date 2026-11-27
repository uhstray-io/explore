import { isWaiting } from './questions.js';
import { plural } from './workspace-view.js';

// Since you were last here (K2): what happened on a map since this browser last showed it, read from the map's
// event log. It is worked out in the browser, never queues work and never writes to the map. The cursor is per
// browser by design.
const cap = 8;
const capped = list => ({ items: list.slice(0, cap), total: list.length });
const unique = nodes => [...new Map(nodes.filter(Boolean).map(node => [node.id, node])).values()];
const brief = node => ({ id: node.id, title: node.title, summary: node.summary });
const countWaiting = map => map.nodes.reduce((sum, node) => sum + node.questions.filter(isWaiting).length, 0);

// Where this browser left a map: when, and how far through its event log.
export const visitCursor = (map, at = new Date().toISOString()) => ({ at, events: map.history?.length ?? 0, lastEventAt: map.history?.at(-1)?.at ?? null });

// What is new since `cursor`, or null when nothing is (or there is no cursor yet). With `until`, only what happened
// up to then counts: a return to the tab is summarised as of the moment of return, never the user's later changes.
export function sinceLastVisit(map, cursor, until = null) {
  if (!cursor) return null;
  const history = map.history || [];
  // The event index holds while the event before it is unchanged; a file replaced (say by Git) falls back to time.
  const aligned = cursor.events <= history.length && (cursor.events === 0 || history[cursor.events - 1]?.at === cursor.lastEventAt);
  const before = at => !until || (at ?? '') <= until;
  const events = (aligned ? history.slice(cursor.events) : history.filter(event => (event.at ?? '') > cursor.at)).filter(event => before(event.at));
  // Flags and new directions carry their own times. A collaborator's work pulled later can be older than this visit,
  // so the threshold is the earlier of the visit and the first new event (less a millisecond: a flag is stamped just
  // before its event).
  const firstNew = aligned && events.length ? new Date(Date.parse(events[0].at) - 1).toISOString() : cursor.at;
  const since = firstNew < cursor.at ? firstNew : cursor.at;
  const nodeOf = id => map.nodes.find(node => node.id === id);
  // A "result" event is an applied result (a stale one is recorded as stale-result); its detail is the job.
  const results = events.filter(event => event.type === 'result').map(event => ({ node: nodeOf(event.nodeId), jobId: event.detail })).filter(result => result.node);
  const newFindings = unique(results.map(result => result.node)).map(brief);
  const newQuestions = results.reduce((sum, { node, jobId }) => sum + node.questions.filter(q => q.jobId === jobId && isWaiting(q)).length, 0);
  const staleNow = map.nodes.filter(node => node.stale);
  // Flagged since the visit: a review cause newer than the threshold. Older and legacy flags only count in the total.
  const flagged = staleNow.filter(node => (node.reviewCauses || []).some(cause => (cause.at ?? '') >= since && before(cause.at)));
  const stopped = unique(events.filter(event => event.type === 'failed' || event.type === 'interrupted').map(event => nodeOf(event.nodeId))).filter(node => node.status === 'interrupted');
  const newDirections = map.nodes.filter(node => node.status === 'suggested' && (node.createdAt ?? '') >= since && before(node.createdAt)).length;
  if (!newFindings.length && !newQuestions && !flagged.length && !stopped.length && !newDirections) return null;
  return { since: cursor.at, newFindings: capped(newFindings), newQuestions, waitingNow: countWaiting(map), flagged: capped(flagged.map(brief)), staleNow: staleNow.length, stopped: capped(stopped.map(brief)), newDirections };
}

// The card shown above the overview. Each line is a button; none of them changes the map.
export function sinceVisitHtml(summary, { esc, when }) {
  const ideas = (list, label) => list.items.map(node => `<li><button type="button" class="text-button" data-focus-node="${esc(node.id)}">${label}: ${esc(node.title)}</button></li>`).join('')
    + (list.total > list.items.length ? `<li class="since-more">and ${list.total - list.items.length} more</li>` : '');
  const lines = [
    ideas(summary.newFindings, 'New finding'),
    summary.newQuestions ? `<li>${plural(summary.newQuestions, 'new question')} · ${summary.waitingNow} waiting for you <button type="button" class="text-button" data-since-filter="answer">Show questions</button></li>` : '',
    summary.flagged.total ? `<li>${plural(summary.flagged.total, 'idea')} flagged for review · ${summary.staleNow} need review <button type="button" class="text-button" data-since-filter="stale">Show flagged</button></li>${ideas(summary.flagged, 'Flagged')}` : '',
    ideas(summary.stopped, 'Stopped (Retry is on the idea)'),
    summary.newDirections ? `<li>${plural(summary.newDirections, 'new direction')} suggested</li>` : '',
  ];
  return `<section class="since-visit" aria-label="Since you were last here"><div class="since-visit-heading"><strong>Since you were last here</strong> <span>${esc(when)}</span><button type="button" class="icon-button" data-since-dismiss aria-label="Dismiss">×</button></div><ul>${lines.join('')}</ul></section>`;
}

// The card in the page and the cursor in this browser's storage.
//   open(map)               a map was opened: summarise since the stored cursor.
//   render(map, {historic}) every render: shows the card unless dismissed or in history. While the map is live
//                           and the tab visible it remembers the visit, so the user's own changes never count as new.
//                           The first render after the tab was hidden first summarises what arrived meanwhile, as of
//                           the moment the tab was shown again, whichever refresh brings it.
export function sinceVisitPanel({ esc, openFilter, focusAfterDismiss }) {
  const box = document.querySelector('#since-visit'), key = mapId => `explore-seen:${mapId}`;
  const read = mapId => { try { return JSON.parse(localStorage.getItem(key(mapId))); } catch { return null; } };
  const remember = map => { try { localStorage.setItem(key(map.id), JSON.stringify(visitCursor(map))); } catch {} };
  let summary = null, dismissed = false, away = document.hidden ? true : null; // null, true while hidden, or the return time.
  document.addEventListener('visibilitychange', () => { away = document.hidden ? true : away && new Date().toISOString(); });
  box.addEventListener('click', event => {
    if (event.target.closest('[data-since-dismiss]')) { dismissed = true; box.hidden = true; focusAfterDismiss(); }
    const filter = event.target.closest('[data-since-filter]'); if (filter) openFilter(filter.dataset.sinceFilter);
  });
  const summarise = (map, until = null) => {
    summary = sinceLastVisit(map, read(map.id), until); dismissed = false; away = null;
    box.innerHTML = summary ? sinceVisitHtml(summary, { esc, when: new Date(summary.since).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : '';
  };
  return {
    open: map => summarise(map),
    render(map, { historic }) {
      if (!historic && typeof away === 'string') summarise(map, away);
      box.hidden = !summary || dismissed || historic;
      if (!historic && !away && !document.hidden) remember(map);
    },
  };
}
