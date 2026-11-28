import { workLabels } from './graph.js';
import { plural } from './workspace-view.js';

// The Usage dialog (J1): statistics across saved maps, from what the maps already hold. Every number says what it
// is out of; failure reasons, which are free text and may hold the user's words, stay folded until opened.
const number = value => value === null || value === undefined ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);
const seconds = value => value === null ? 'unknown' : value < 90 ? `${Math.round(value)} s` : `${(value / 60).toFixed(1)} min`;
const kindWords = { idea: 'Idea', question: 'Question', research: 'Research', decision: 'Decision', risk: 'Risk' };
const jobWords = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted', queued: 'Queued', running: 'Running', other: 'Other' };

export function usageHtml(stats, { esc }) {
  const { maps, structure, questions, answerStates, feedback, jobs, activity, perMap } = stats;
  // A row with a count, what it is out of, and a bar for its share.
  const share = (label, count, total) => `<tr><th scope="row">${esc(label)}</th><td>${count} of ${total}</td><td class="usage-share"><span class="usage-bar" aria-hidden="true"><span style="width:${total ? Math.round(count / total * 100) : 0}%"></span></span></td></tr>`;
  const table = (caption, rows) => rows.length ? `<table class="usage-table"><caption>${esc(caption)}</caption><tbody>${rows.join('')}</tbody></table>` : '';
  const counted = (entries, words, total) => Object.entries(entries).sort((a, b) => b[1] - a[1]).map(([key, count]) => share(words?.[key] ?? (key === 'other' ? 'Other' : key), count, total));
  const notes = [maps.archivedLeftOut ? `${plural(maps.archivedLeftOut, 'archived map')} left out.` : '',
    ...[['Left out because they cannot be read', maps.excluded.filter(entry => entry.problem !== 'unexpected-shape')], ['Left out because they hold data that cannot be counted', maps.excluded.filter(entry => entry.problem === 'unexpected-shape')]]
      .map(([words, list]) => (list.length ? `${words}: ${list.map(entry => esc(entry.id)).join(', ')}.` : '')),
    maps.excludedMore ? `And ${plural(maps.excludedMore, 'more map')} left out.` : ''].filter(Boolean).join(' ');
  const parts = [`<p class="form-note">From ${plural(maps.counted, 'saved map')}. Nothing here is sent anywhere or changes a map.${notes ? ` ${notes}` : ''}</p>`];
  if (!maps.counted) return parts.join('');
  parts.push('<h3 class="section-label">Structure</h3>',
    `<p class="usage-facts">${plural(structure.nodes, 'idea')} · per map: mean ${number(structure.nodesPerMap.mean)}, median ${number(structure.nodesPerMap.median)}, most ${number(structure.nodesPerMap.max)}<br>`
    + `Depth below the first idea: deepest ${number(structure.depth.max)}, mean ${number(structure.depth.mean)}<br>`
    + `${plural(structure.branching.parents, 'idea')} with ideas below ${structure.branching.parents === 1 ? 'it' : 'them'}: mean ${number(structure.branching.mean)}, most ${number(structure.branching.max)} each</p>`,
    table('By kind', counted(structure.kinds, kindWords, structure.nodes)), table('By work', counted(structure.work, workLabels, structure.nodes)),
    table('By review', [share('Accepted', structure.review.accepted, structure.nodes), share('Not yet reviewed', structure.review.unreviewed, structure.nodes), share('Needs review', structure.review.needsReview, structure.nodes), share('No longer relevant', structure.review.cleared, structure.nodes)]));
  parts.push('<h3 class="section-label">Questions and answers</h3>',
    table(`${plural(questions.total, 'question')}`, [share('Answered', questions.answered, questions.total), share('Waiting for you', questions.waiting, questions.total), share('Saved for later', questions.later, questions.total), share('Set aside by a changed premise', questions.superseded, questions.total), share('Dismissed', questions.dismissed, questions.total)]),
    `<p class="usage-facts">${questions.answered} of ${plural(questions.total, 'question')} answered.</p>`,
    table(`How sure, of ${plural(answerStates.answered, 'answer')}`, [share('Decided', answerStates.decided, answerStates.answered), share('Tentative', answerStates.tentative, answerStates.answered), share('Assumption', answerStates.assumption, answerStates.answered), share('Tentative (not recorded)', answerStates.tentativeNotRecorded, answerStates.answered)]),
    table(`Your feedback, of ${plural(questions.total, 'question')}`, [share('Rated good', feedback.good, questions.total), share('Rated bad', feedback.bad, questions.total), share('Dismissed', feedback.dismissed, questions.total), share('Asked again', feedback.regenerated, questions.total)]));
  const done = jobs.byStatus.completed || 0, explored = jobs.completed.investigations;
  parts.push('<h3 class="section-label">Agent work</h3>',
    table(`${plural(jobs.total, 'job')}`, counted(jobs.byStatus, jobWords, jobs.total)),
    table(`Completed explorations, of ${explored}`, [share('Asked you questions', jobs.completed.askedQuestions, explored), share('Finished the branch', jobs.completed.finishedBranch, explored), share('Result out of date', jobs.completed.stale, explored)]),
    jobs.completed.helpers ? `<p class="usage-facts">${jobs.completed.helpers} of ${plural(done, 'completed job')} helped with a question or an answer rather than exploring a branch.</p>` : '',
    `<p class="usage-facts">Work packets: median ${number(jobs.packet.median === null ? null : Math.round(jobs.packet.median))} characters, largest ${number(jobs.packet.max)} (${jobs.packet.measured} measured)<br>`
    + `Run time, of ${plural(done, 'completed job')}: median ${seconds(jobs.runTime.medianSeconds)} (${jobs.runTime.known} timed, ${jobs.runTime.unknown} time unknown)</p>`,
    jobs.workers.top.length ? table('By worker', [...jobs.workers.top.map(worker => share(worker.name, worker.count, jobs.total)), ...(jobs.workers.more ? [`<tr><th scope="row">${plural(jobs.workers.more, 'other worker')}</th><td colspan="2">not listed</td></tr>`] : []), ...(jobs.workers.unnamed ? [share('No worker named', jobs.workers.unnamed, jobs.total)] : [])]) : '',
    jobs.failures.count ? `<details class="usage-failures"><summary>${plural(jobs.failures.count, 'failure')} · the ${plural(jobs.failures.recent.length, 'most recent failure reason', 'most recent failure reasons')}</summary><ul>${jobs.failures.recent.map(failure => `<li><strong>${esc(failure.mapTitle)}</strong>${failure.at ? ` · ${esc(failure.at.slice(0, 10))}` : ''}: ${esc(failure.reason)}</li>`).join('')}</ul></details>` : '');
  parts.push('<h3 class="section-label">Activity by week</h3>',
    activity.weeks.length ? `<table class="usage-table"><thead><tr><th>Week of</th><th>Answers</th><th>Completed jobs</th></tr></thead><tbody>${activity.weeks.map(week => `<tr><td>${esc(week.week)}</td><td>${week.answers}</td><td>${week.completed}</td></tr>`).join('')}</tbody></table>` : '<p class="form-note">No dated answers or finished jobs yet.</p>',
    activity.earlierWeeks ? `<p class="form-note">The last ${activity.weeks.length} active weeks; ${plural(activity.earlierWeeks, 'earlier week')} not shown.</p>` : '',
    activity.unknownAnswers || activity.unknownCompleted ? `<p class="form-note">Without a date: ${plural(activity.unknownAnswers, 'answer')}, ${plural(activity.unknownCompleted, 'completed job')}.</p>` : '');
  parts.push('<h3 class="section-label">Maps</h3>',
    `<table class="usage-table usage-maps"><thead><tr><th>Map</th><th>Ideas</th><th>Depth (deepest, mean)</th><th>Answered</th><th>Jobs done</th><th>Failed</th></tr></thead><tbody>${perMap.rows.map(row => `<tr><td><button type="button" class="text-button" data-usage-map="${esc(row.id)}">${esc(row.title)}</button></td><td>${row.nodes}</td><td>${row.depth}, ${number(row.meanDepth)}</td><td>${row.answered} of ${row.questions}</td><td>${row.completed}</td><td>${row.failed}</td></tr>`).join('')}</tbody></table>`,
    perMap.more ? `<p class="form-note">And ${plural(perMap.more, 'more map')}; the totals above count them.</p>` : '');
  return parts.join('');
}

// The dialog in the page: opens from the rail, reloads when archived maps are included, and opens a map from its row.
export function usageDialog({ api, esc, openMap }) {
  const $ = selector => document.querySelector(selector), dialog = $('#usage-dialog'), body = $('#usage-body'), archived = $('#usage-archived'), status = $('#usage-status');
  let request = 0;
  async function load() {
    const mine = ++request; body.setAttribute('aria-busy', 'true'); status.textContent = 'Counting…';
    try {
      const stats = await api(`/stats?archived=${archived.checked ? 'include' : 'exclude'}`);
      if (mine !== request) return; // A newer load replaced this one.
      body.innerHTML = usageHtml(stats, { esc }); status.textContent = `Counted ${plural(stats.maps.counted, 'map')}.`;
    } catch (error) { if (mine === request) { body.innerHTML = ''; status.textContent = error.message; } }
    finally { if (mine === request) body.removeAttribute('aria-busy'); }
  }
  archived.addEventListener('change', load);
  body.addEventListener('click', event => {
    const row = event.target.closest('[data-usage-map]'); if (!row) return;
    dialog.close(); openMap(row.dataset.usageMap);
  });
  return () => { body.innerHTML = ''; dialog.showModal(); load(); };
}
