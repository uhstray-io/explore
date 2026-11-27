import test from 'node:test';
import assert from 'node:assert/strict';
import { sinceLastVisit, visitCursor, sinceVisitHtml } from '../skills/explore/assets/since-visit.js';

// Since you were last here (K2, #50). Illustrative maps only.
const at = minutes => new Date(Date.UTC(2026, 10, 27, 10, minutes)).toISOString();
const node = (id, extra = {}) => ({ id, title: `Idea ${id}`, summary: `About ${id}.`, status: 'explored', questions: [], createdAt: at(0), ...extra });
function fixture() {
  const map = { id: 'map-a', nodes: [node('root')], jobs: [], history: [{ at: at(1), type: 'created', nodeId: 'root' }] };
  const cursor = visitCursor(map, at(2));
  return { map, cursor };
}
const deliver = (map, nodeId, minutes, { stale = false, questions = [] } = {}) => {
  const jobId = `job-${nodeId}-${minutes}`;
  map.jobs.push({ id: jobId, nodeId, status: 'completed', stale });
  map.nodes.find(n => n.id === nodeId).questions.push(...questions.map((text, i) => ({ id: `q-${jobId}-${i}`, text, answer: null, jobId })));
  map.history.push({ at: at(minutes), type: 'result', nodeId, detail: jobId });
};

test('with no cursor nothing is shown, and nothing new shows nothing', () => {
  const { map, cursor } = fixture();
  assert.equal(sinceLastVisit(map, null), null);
  assert.equal(sinceLastVisit(map, cursor), null);
  assert.deepEqual(cursor, { at: at(2), events: 1, lastEventAt: at(1) });
});

test('a result delivered while away is a new finding, with its waiting questions', () => {
  const { map, cursor } = fixture();
  map.nodes.push(node('sync', { status: 'awaiting-answer' }));
  deliver(map, 'sync', 5, { questions: ['Who edits?', 'How often?'] });
  deliver(map, 'sync', 6, { stale: true });
  map.nodes[0].questions.push({ id: 'q-old', text: 'Older?', answer: null });
  const summary = sinceLastVisit(map, cursor);
  assert.deepEqual(summary.newFindings, { items: [{ id: 'sync', title: 'Idea sync', summary: 'About sync.' }], more: 0 }, 'listed once; the stale result is not a finding');
  assert.equal(summary.newQuestions, 2); assert.equal(summary.waitingNow, 3);
  assert.equal(summary.since, at(2));
});

test('newly flagged ideas are listed, older ones only counted; stopped work shows while it is still stopped', () => {
  const { map, cursor } = fixture();
  map.nodes.push(node('old', { stale: true, reviewCauses: [{ sourceId: 'root', kind: 'premise-revised', at: at(1) }] }));
  map.nodes.push(node('new', { stale: true, reviewCauses: [{ sourceId: 'root', kind: 'answer-changed', at: at(7) }] }));
  map.nodes.push(node('legacy', { stale: true }));
  map.nodes.push(node('halted', { status: 'interrupted' }), node('retried', { status: 'queued' }));
  map.history.push({ at: at(8), type: 'failed', nodeId: 'halted', detail: 'No sources.' }, { at: at(8), type: 'interrupted', nodeId: 'retried', detail: 'Server restarted.' });
  map.nodes.push(node('fresh', { status: 'suggested', createdAt: at(9) }), node('earlier', { status: 'suggested', createdAt: at(1) }));
  const summary = sinceLastVisit(map, cursor);
  assert.deepEqual(summary.flagged.items.map(n => n.id), ['new']); assert.equal(summary.staleNow, 3, 'legacy stale ideas count in the total');
  assert.deepEqual(summary.stopped.items.map(n => n.id), ['halted'], 'work retried since is not listed');
  assert.equal(summary.newDirections, 1);
});

test('a replaced map file falls back to times, and long lists are capped', () => {
  const { map, cursor } = fixture();
  map.history = [{ at: at(0), type: 'created', nodeId: 'root' }]; // A shorter log from Git.
  for (let i = 0; i < 10; i++) { map.nodes.push(node(`n${i}`)); deliver(map, `n${i}`, 10 + i); }
  const summary = sinceLastVisit(map, cursor);
  assert.equal(summary.newFindings.items.length, 8); assert.equal(summary.newFindings.more, 2);
  const shifted = { ...cursor, lastEventAt: 'something else' };
  assert.equal(sinceLastVisit(map, shifted).newFindings.items.length + sinceLastVisit(map, shifted).newFindings.more, 10);
});

test('the card offers a button per idea and filter, and a way to dismiss it', () => {
  const { map, cursor } = fixture();
  map.nodes.push(node('sync', { status: 'awaiting-answer', title: 'Sync <fast>' }));
  deliver(map, 'sync', 5, { questions: ['Who?'] });
  map.nodes.push(node('flag', { stale: true, reviewCauses: [{ at: at(6) }] }));
  const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = sinceVisitHtml(sinceLastVisit(map, cursor), { esc, when: '27 Nov, 10:02' });
  assert.match(html, /Since you were last here/); assert.match(html, /27 Nov, 10:02/);
  assert.match(html, /data-focus-node="sync">New finding: Sync &lt;fast>/);
  assert.match(html, /data-since-filter="answer">Show questions/);
  assert.match(html, /data-since-filter="stale">Review flagged/);
  assert.match(html, /data-since-dismiss/);
});
