import { isOpen } from './questions.js';

// Since you were last here (K2): what happened on a map since this browser last showed it, read from the map's
// event log. It is worked out in the browser, never queues work and never writes to the map. The cursor is per
// browser by design.
const cap = 8;
const capped = list => ({ items: list.slice(0, cap), more: Math.max(0, list.length - cap) });
const unique = nodes => [...new Map(nodes.filter(Boolean).map(node => [node.id, node])).values()];
const brief = node => ({ id: node.id, title: node.title, summary: node.summary });
const waiting = question => isOpen(question) && !question.deferredAt;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Where this browser left a map: when, and how far through its event log.
export const visitCursor = (map, at = new Date().toISOString()) => ({ at, events: map.history?.length ?? 0, lastEventAt: map.history?.at(-1)?.at ?? null });

// What is new since `cursor`, or null when nothing is (or there is no cursor yet).
export function sinceLastVisit(map, cursor) {
  if (!cursor) return null;
  const history = map.history || [];
  // The event index holds while the event before it is unchanged; a file replaced (say by Git) falls back to time.
  const aligned = cursor.events <= history.length && (cursor.events === 0 || history[cursor.events - 1]?.at === cursor.lastEventAt);
  const events = aligned ? history.slice(cursor.events) : history.filter(event => (event.at ?? '') > cursor.at);
  const nodeOf = id => map.nodes.find(node => node.id === id);
  // Applied results only: a stale one never changed the idea.
  const results = events.filter(event => event.type === 'result').map(event => ({ node: nodeOf(event.nodeId), job: map.jobs.find(job => job.id === event.detail) }))
    .filter(({ node, job }) => node && job?.status === 'completed' && !job.stale);
  const newFindings = unique(results.map(result => result.node)).map(brief);
  const newQuestions = results.reduce((sum, { node, job }) => sum + node.questions.filter(q => q.jobId === job.id && waiting(q)).length, 0);
  const staleNow = map.nodes.filter(node => node.stale);
  // Flagged since the visit: a review cause newer than the cursor. Older and legacy flags only count in the total.
  const flagged = staleNow.filter(node => (node.reviewCauses || []).some(cause => (cause.at ?? '') > cursor.at));
  const stopped = unique(events.filter(event => event.type === 'failed' || event.type === 'interrupted').map(event => nodeOf(event.nodeId))).filter(node => node.status === 'interrupted');
  const newDirections = map.nodes.filter(node => node.status === 'suggested' && (node.createdAt ?? '') > cursor.at).length;
  if (!newFindings.length && !newQuestions && !flagged.length && !stopped.length && !newDirections) return null;
  return { since: cursor.at, newFindings: capped(newFindings), newQuestions, waitingNow: map.nodes.reduce((sum, node) => sum + node.questions.filter(waiting).length, 0),
    flagged: capped(flagged.map(brief)), staleNow: staleNow.length, stopped: capped(stopped.map(brief)), newDirections };
}

// The card shown above the overview when a map opens. Each line is a button; none of them changes the map.
export function sinceVisitHtml(summary, { esc, when }) {
  const ideas = (list, label) => list.items.map(node => `<li><button type="button" class="text-button" data-focus-node="${esc(node.id)}">${label}: ${esc(node.title)}</button></li>`).join('')
    + (list.more ? `<li class="since-more">and ${list.more} more</li>` : '');
  const lines = [
    ideas(summary.newFindings, 'New finding'),
    summary.newQuestions ? `<li>${plural(summary.newQuestions, 'new question')} · ${summary.waitingNow} waiting for you <button type="button" class="text-button" data-since-filter="answer">Show questions</button></li>` : '',
    summary.flagged.items.length ? `<li>${plural(summary.flagged.items.length + summary.flagged.more, 'idea')} flagged for review · ${summary.staleNow} need review <button type="button" class="text-button" data-since-filter="stale">Review flagged</button></li>${ideas(summary.flagged, 'Flagged')}` : '',
    ideas(summary.stopped, 'Stopped (Retry is on the idea)'),
    summary.newDirections ? `<li>${plural(summary.newDirections, 'new direction')} suggested</li>` : '',
  ];
  return `<section class="since-visit" aria-label="Since you were last here"><div class="since-visit-heading"><strong>Since you were last here</strong> <span>${esc(when)}</span><button type="button" class="icon-button" data-since-dismiss aria-label="Dismiss">×</button></div><ul>${lines.join('')}</ul></section>`;
}

// The card in the page, and the cursor in this browser's storage. `open` shows what is new and remembers the
// visit; `seen` keeps the cursor current on every render of the live map, so the user's own changes never
// appear in their next summary.
export function sinceVisitPanel({ esc, showFilter }) {
  const box = document.querySelector('#since-visit'), key = mapId => `explore-seen:${mapId}`;
  const read = mapId => { try { return JSON.parse(localStorage.getItem(key(mapId))); } catch { return null; } };
  const remember = map => { try { localStorage.setItem(key(map.id), JSON.stringify(visitCursor(map))); } catch {} };
  box.addEventListener('click', event => {
    if (event.target.closest('[data-since-dismiss]')) box.hidden = true;
    const filter = event.target.closest('[data-since-filter]'); if (filter) showFilter(filter.dataset.sinceFilter);
  });
  return {
    open(map) {
      const summary = sinceLastVisit(map, read(map.id));
      box.innerHTML = summary ? sinceVisitHtml(summary, { esc, when: new Date(summary.since).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : '';
      box.hidden = !summary; remember(map);
    },
    seen(map) { if (!document.hidden) remember(map); },
    hide() { box.hidden = true; },
  };
}
