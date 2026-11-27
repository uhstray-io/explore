import { constellationLayout, connectionPath, presentation, overviewView, focusedView } from './graph.js';
import { growthTimeline, mapAtGrowthStep } from './history.js';
import { answerStates, answerStateLabels, isOpen, isBlocking, effectiveAnswerState, certaintyText, answeredSince, importanceLabel } from './questions.js';
import { mapOverview, visibleSelection, briefFilename, briefPreview, historyStepLabel, starterIdeas, openMapChange, unreadableLabel, outsideChangeNote, versionLabel, undoTarget, restoreSummary, optionsHtml, appendSuggestion, answerChoices, checkAnswersHtml, questionMenuHtml, menuFocusIndex, questionSequence, reviewQueue, reviewStepHtml, restartPreviewHtml, importanceHtml } from './workspace-view.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { token: '', map: null, visibleMap: null, maps: [], selected: null, bridge: {}, scale: 1, x: 0, y: 0, positions: {}, drafts: {}, editors: {}, refreshing: false, filter: null, historyStep: null, historySource: null, brief: null, mutations: 0, outsideSeen: {} };
const glyphs = { idea: '✳', research: '◇', question: '?', decision: '✓', risk: '△' };
let toastTimer, gesture, suppressClick = false, openVersion = 0, actionTail = Promise.resolve();
const accents = ['var(--teal)', 'var(--blue)', 'var(--orange)'];
function navigation(open) { document.body.classList.toggle('rail-open', open); $('#map-navigation').inert = !open; $('#maps-toggle').setAttribute('aria-expanded', String(open)); }
$('#maps-toggle').onclick = () => navigation(!document.body.classList.contains('rail-open'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { navigation(false); closeOverview(); }
  if (event.key === '/' && state.map && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) { event.preventDefault(); $('#find-node').focus(); }
});
const themeQuery = new URL(location.href).searchParams.get('theme');
let dark = (themeQuery || localStorage.getItem('explore-theme') || 'light') === 'dark';
function theme() { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme-toggle').setAttribute('aria-pressed', String(dark)); localStorage.setItem('explore-theme', dark ? 'dark' : 'light'); }
$('#theme-toggle').onclick = () => { dark = !dark; theme(); }; theme();
// Legacy prototype links now open the real workspace; theme is a preference, not a route.
const currentUrl = new URL(location.href); currentUrl.searchParams.delete('variant'); currentUrl.searchParams.delete('theme'); history.replaceState(null, '', currentUrl);
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 6500); }
async function api(route, body) {
  const response = await fetch(`/api${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The request could not be saved.'); return data;
}
function prose(value) {
  return String(value || '').split(/\n\s*\n/).map(block => {
    if (/^#{1,4} /.test(block)) return `<h3>${esc(block.replace(/^#{1,4} /, ''))}</h3>`;
    if (/^[-*] /.test(block)) return `<ul>${block.split('\n').map(line => `<li>${esc(line.replace(/^[-*] /, ''))}</li>`).join('')}</ul>`;
    return `<p>${esc(block)}</p>`;
  }).join('');
}
function agentListening(mapId = state.map?.id) {
  return Boolean(state.bridge.listening && (!mapId || !Array.isArray(state.bridge.scopes) || state.bridge.scopes.some(scope => scope.listening && (scope.mapId === null || scope.mapId === mapId))));
}
function connectionView(offline = false) {
  const connected = agentListening() && !offline;
  $('#bridge-status').classList.toggle('connected', connected);
  $('#bridge-status span').textContent = offline ? 'Server disconnected' : connected ? 'Agent is listening' : state.bridge.listening ? 'Agent on another map' : 'Connect your agent';
  const hint = $('#empty-hint');
  hint.classList.toggle('hidden', !state.map || state.historyStep !== null || connected || !state.map.jobs.some(j => j.status === 'queued' && !j.unsupported));
  hint.textContent = 'Queued safely. Use the agent button above to continue.';
}
function renderRail() {
  const html = state.maps.length ? state.maps.map(m => m.unreadable ? `<button class="map-link unreadable" data-map="${m.id}"><span class="map-icon" aria-hidden="true">⌘</span><span><strong>${esc(m.id)}</strong><small>${esc(unreadableLabel(m.problem))}</small></span></button>` : `<button class="map-link ${state.map?.id === m.id ? 'current' : ''}" data-map="${m.id}" ${state.map?.id === m.id ? 'aria-current="page"' : ''}><span class="map-icon" aria-hidden="true">⌘</span><span><strong>${esc(m.title)}</strong><small>${m.demo ? 'Example map' : `${m.count} ${m.count === 1 ? 'idea' : 'ideas'}`}${m.pending ? ` · ${m.pending} queued` : ''}</small></span></button>`).join('') : '<p class="empty-list">Your ideas will find a home here.</p>';
  if ($('#map-list').innerHTML !== html) $('#map-list').innerHTML = html;
}
async function refresh() {
  if (state.refreshing || state.mutating || gesture || document.hidden) return;
  state.refreshing = true;
  const version = openVersion;
  const previouslyListening = agentListening();
  try {
    const data = await api('/maps'); state.maps = data.maps; state.bridge = data.bridge; renderRail(); connectionView();
    // A list requested before another map opened says nothing about the map open now.
    const current = version === openVersion ? state.map : null;
    const listed = current && data.maps.find(m => m.id === current.id), change = openMapChange(listed, current);
    if (change === 'removed' || change === 'unreadable') {
      toast(change === 'removed' ? 'This map is no longer in the workspace, for example after a branch switch.' : `${unreadableLabel(listed.problem)}. It opens again once its file is fixed.`);
      showWelcome();
    } else if (change === 'changed') {
      // A pull can bring an older revision, so only a save made meanwhile in this tab outranks the fetched map.
      const mapId = state.map.id, mutations = state.mutations, map = await api(`/maps/${mapId}`);
      if (version === openVersion && state.map?.id === mapId && !state.mutating && !gesture && mutations === state.mutations) {
        state.map = map; renderMap();
        const note = outsideChangeNote(map.outsideChange, state.outsideSeen[mapId]);
        state.outsideSeen[mapId] = map.outsideChange?.at; if (note) toast(note);
      }
    }
    if ((state.detailDeferred || previouslyListening !== agentListening()) && version === openVersion && state.map) renderDetail();
  } catch { connectionView(true); }
  finally { state.refreshing = false; }
}
async function openMap(id) {
  const version = ++openVersion;
  try {
    const map = await api(`/maps/${id}`); if (version !== openVersion) return;
    state.outsideSeen[id] = map.outsideChange?.at; // Only changes that arrive while the map is open are announced.
    state.map = map; state.selected = state.map.rootId; state.historyStep = null; state.historySource = null; state.filter = null; state.versionPreview = null; state.versionChoice = null; state.versions = null; state.reviewing = null; state.restartPreview = null; navigation(false);
    $('#find-node').value = ''; $('#node-results').hidden = true;
    localStorage.setItem('explore-map', id); location.hash = id;
    renderMap(true); renderRail();
  } catch (error) { toast(error.message); }
}
function layout() {
  const source = state.historySource || state.map;
  const key = JSON.stringify([source.id, source.nodes.map(n => [n.id, n.parentId])]);
  if (state.graphKey !== key) {
    state.graphKey = key;
    state.baseGraph = constellationLayout({ ...source, view: null });
  }
  state.positions = { ...state.baseGraph.positions }; state.domains = state.baseGraph.domains;
  for (const node of source.nodes) {
    const saved = source.view?.positions?.[node.id];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) state.positions[node.id] = { ...saved };
  }
}
function renderEdges() {
  const nodes = new Map(state.visibleMap.nodes.map(node => [node.id, node]));
  $('#edges').innerHTML = state.visibleMap.edges.map(e => {
    const a = state.positions[e.from], b = state.positions[e.to]; if (!a || !b) return '';
    const target = nodes.get(e.to);
    return `<path class="edge ${e.type === 'contains' ? '' : 'semantic'} ${presentation(target).lit ? 'lit' : ''}" style="--accent:${accents[state.domains[e.to] % accents.length]}" d="${connectionPath(a, b)}"><title>${esc(e.type.replaceAll('_', ' '))}</title></path>`;
  }).join('');
}
function renderMap(fit = false, preserveView = false) {
  if (!state.map || gesture) return;
  const historic = state.historyStep !== null;
  state.timeline = growthTimeline(state.historySource || state.map);
  state.visibleMap = historic ? mapAtGrowthStep(state.historySource, state.historyStep) : state.map;
  state.selected = visibleSelection(state.visibleMap, state.selected);
  const topologyChanged = state.layoutMap !== state.map.id || state.layoutCount !== state.map.nodes.length;
  state.layoutMap = state.map.id; state.layoutCount = state.map.nodes.length;
  $('#welcome').classList.add('hidden'); $('#workspace').classList.remove('hidden');
  $('#map-title').textContent = state.map.title; $('#canvas-title').textContent = state.map.title;
  const overview = mapOverview(state.visibleMap);
  $('#canvas-subtitle').textContent = `${overview.total} ${overview.total === 1 ? 'idea' : 'ideas'} · ${overview.explored} explored · ${overview.accepted} accepted${overview.running ? ` · ${overview.running} researching` : ''}${state.map.demo ? ' · Example map' : ''}`;
  $('#saved-state').textContent = historic ? (state.versionPreview ? 'Saved version, read-only' : 'Read-only history') : 'Saved in this repo';
  $('#workspace').classList.toggle('history-mode', historic);
  $('#canvas').setAttribute('aria-label', historic ? 'Map growth history. Read-only. Drag the background to pan; select an idea to view today’s findings.' : 'Constellation. Drag a node to move it or the background to pan. Focus a node and use Alt plus arrow keys to move it.');
  $('#canvas-instruction').textContent = historic ? 'Read-only history · pan or zoom to inspect · return to live to arrange ideas' : 'Drag nodes to arrange · Alt + arrow keys moves a focused node · / finds an idea';
  $('#focus-selected').disabled = !state.selected;
  layout();
  const focusedNode = document.activeElement?.dataset.node;
  $('#nodes').innerHTML = state.visibleMap.nodes.map(n => {
    const pos = state.positions[n.id];
    const root = n.id === state.map.rootId, status = presentation(n), major = root || n.parentId === state.map.rootId;
    return `<button class="node ${n.kind} ${n.status} ${root ? 'root' : ''} ${major ? 'major' : ''} ${status.lit ? 'lit' : ''} ${n.stale ? 'stale' : ''} ${n.reviewState === 'accepted' ? 'accepted' : ''} ${n.id === state.selected ? 'selected' : ''}" data-node="${n.id}" style="left:${pos.x}px;top:${pos.y}px;--accent:${accents[state.domains[n.id] % accents.length]}" aria-label="${esc(n.title)}, ${esc(status.label)}" aria-pressed="${n.id === state.selected}"><span class="node-symbol" aria-hidden="true">${glyphs[n.kind]}</span><span class="node-badge" aria-hidden="true">${n.stale ? '!' : n.status === 'awaiting-answer' ? '?' : n.reviewState === 'accepted' ? '✓' : ''}</span><span class="node-tooltip">${esc(n.title)} · ${esc(status.label)}</span>${major ? `<span class="node-caption">${esc(n.title)}</span>` : ''}</button>`;
  }).join('');
  renderEdges();
  renderDetail(); renderOverview(); renderHistory(); renderVersionsPanel(); if (state.toolsOpen) renderTools();
  if (state.versionsOpen && !state.versionChoice && state.versions?.revision !== state.map.revision) loadVersions();
  if (focusedNode) $(`[data-node="${focusedNode}"]`)?.focus({ preventScroll: true });
  if (!$('#node-results').hidden) searchNodes();
  connectionView();
  if (!preserveView && !historic && (fit || (topologyChanged && state.overview))) requestAnimationFrame(() => { if (fit) centerSelected(); else fitMap(); });
  else transform();
}
function transform() { $('#world').style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`; $('#world').style.setProperty('--graph-scale', state.scale); $('#zoom-value').textContent = `${state.scale < .1 ? (state.scale * 100).toFixed(1) : Math.round(state.scale * 100)}%`; }
function viewport() { return { width: $('#canvas').clientWidth, height: $('#canvas').clientHeight }; }
function fitMap() {
  if (!state.map) return;
  state.overview = true;
  Object.assign(state, overviewView(visiblePositions(), viewport()));
  transform();
}
function zoom(factor, cx = $('#canvas').clientWidth / 2, cy = $('#canvas').clientHeight / 2) {
  state.overview = false;
  const minimum = Math.min(.05, overviewView(visiblePositions(), viewport()).scale);
  const next = Math.max(minimum, Math.min(3, state.scale * factor)); const ratio = next / state.scale;
  state.x = cx - (cx - state.x) * ratio; state.y = cy - (cy - state.y) * ratio; state.scale = next; transform();
}
function selectNode(nodeId) {
  state.selected = visibleSelection(state.visibleMap, nodeId);
  for (const card of document.querySelectorAll('.node')) { card.classList.toggle('selected', card.dataset.node === nodeId); card.setAttribute('aria-pressed', String(card.dataset.node === nodeId)); }
  $('#focus-selected').disabled = !state.selected; renderDetail();
}
function focusNode(nodeId) {
  if (!state.positions[nodeId] || !state.visibleMap.nodes.some(node => node.id === nodeId)) return;
  selectNode(nodeId);
  centerSelected();
  $('#node-results').hidden = true;
  closeOverview();
  $(`[data-node="${nodeId}"]`)?.focus({ preventScroll: true });
}
function centerSelected() {
  const node = state.visibleMap?.nodes.find(n => n.id === state.selected);
  if (!node) return;
  const neighbors = state.visibleMap.nodes.filter(n => n.parentId === node.id || n.id === node.parentId).map(n => state.positions[n.id]);
  state.overview = false;
  Object.assign(state, focusedView(state.positions[node.id], viewport(), 1, neighbors)); transform();
}
function searchNodes() {
  if (!state.map) return;
  const focusedIdea = $('#node-results').contains(document.activeElement) ? document.activeElement.dataset.focusNode : null;
  const query = $('#find-node').value.trim().toLowerCase();
  const matches = state.visibleMap.nodes.filter(node => `${node.title} ${node.summary || ''}`.toLowerCase().includes(query));
  $('#node-results').innerHTML = `<p role="status">${matches.length ? `${matches.length} ${matches.length === 1 ? 'idea' : 'ideas'}${matches.length > 12 ? ' · showing 12, type more to narrow' : ''}` : 'No matching ideas'}</p>` + matches.slice(0, 12).map(node => `<button type="button" data-focus-node="${node.id}"><strong>${esc(node.title)}</strong><small>${esc(presentation(node).label)}</small></button>`).join('');
  $('#node-results').hidden = false;
  if (focusedIdea) ([...$('#node-results').querySelectorAll('[data-focus-node]')].find(button => button.dataset.focusNode === focusedIdea) || $('#find-node')).focus({ preventScroll: true });
}
$('#find-node').addEventListener('input', searchNodes);
$('#find-node').addEventListener('focus', searchNodes);
$('#find-node').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); $('#node-results').hidden = true; }
  if (event.key === 'ArrowDown') { event.preventDefault(); $('#node-results button')?.focus(); }
  if (event.key === 'Enter') { event.preventDefault(); const id = $('#node-results button')?.dataset.focusNode; if (id && !$('#node-results').hidden) focusNode(id); }
});
$('#node-finder').addEventListener('focusout', event => { if (!event.currentTarget.contains(event.relatedTarget)) $('#node-results').hidden = true; });
$('#node-finder').addEventListener('keydown', event => { if (event.key === 'Escape') { $('#find-node').focus(); $('#node-results').hidden = true; } });
$('#focus-selected').addEventListener('click', () => focusNode(state.selected));

function visiblePositions() {
  return Object.fromEntries((state.visibleMap?.nodes || []).filter(node => state.positions[node.id]).map(node => [node.id, state.positions[node.id]]));
}
function closeOverview() {
  if (!state.filter) return;
  state.filter = null; renderOverview();
}
function renderOverview() {
  if (!state.visibleMap) return;
  const overview = mapOverview(state.visibleMap), focusedFilter = document.activeElement?.dataset.filter;
  const focusedIdea = $('#overview-list').contains(document.activeElement) ? document.activeElement.dataset.focusNode : null;
  const html = overview.groups.map(group => `<button type="button" data-filter="${group.id}" aria-expanded="${state.filter === group.id}" aria-controls="overview-panel"><span>${group.label}</span><strong>${group.nodes.length}</strong></button>`).join('');
  if ($('#overview-filters').innerHTML !== html) $('#overview-filters').innerHTML = html;
  if (focusedFilter) $(`[data-filter="${focusedFilter}"]`)?.focus({ preventScroll: true });
  const group = overview.groups.find(item => item.id === state.filter);
  $('#overview-panel').hidden = !group;
  for (const card of document.querySelectorAll('.node')) card.classList.toggle('filter-muted', Boolean(group) && !group.nodes.some(node => node.id === card.dataset.node));
  if (!group) return;
  $('#overview-title').textContent = `${group.label} (${group.nodes.length})`;
  $('#overview-explanation').textContent = state.historyStep === null ? 'Choose an idea to inspect it. Opening this list never starts work.' : 'Today’s state of ideas visible at this growth step.';
  const list = group.nodes.length ? group.nodes.map(node => `<button type="button" class="overview-idea" data-focus-node="${node.id}"><strong>${esc(node.title)}</strong><small>${esc(presentation(node).label)}${group.note?.(node) ?? ''}</small>${node.summary ? `<span>${esc(node.summary)}</span>` : ''}</button>`).join('') : `<p class="overview-empty">${esc(group.empty)}</p>`;
  // Flagged findings can be reviewed one at a time from here.
  const reviewAll = group.id === 'stale' && group.nodes.length && state.historyStep === null ? `<button type="button" class="secondary review-all" data-review-start="">Review flagged (${group.nodes.length})</button>` : '';
  if ($('#overview-list').innerHTML !== reviewAll + list) $('#overview-list').innerHTML = reviewAll + list;
  if (focusedIdea) ([...$('#overview-list').querySelectorAll('[data-focus-node]')].find(button => button.dataset.focusNode === focusedIdea) || $(`[data-filter="${state.filter}"]`))?.focus({ preventScroll: true });
}
$('#overview-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  state.filter = state.filter === button.dataset.filter ? null : button.dataset.filter;
  $('#node-results').hidden = true; renderOverview();
});
$('#overview-filters').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' && state.filter) { event.preventDefault(); $('#overview-list button')?.focus(); }
});
$('#close-overview').addEventListener('click', () => { const filter = state.filter; closeOverview(); $(`[data-filter="${filter}"]`)?.focus(); });
$('#overview-panel').addEventListener('keydown', event => {
  if (event.key === 'Escape') { const filter = state.filter; closeOverview(); $(`[data-filter="${filter}"]`)?.focus(); }
});

function renderHistory() {
  // A version preview reuses the read-only canvas but has its own panel.
  const historic = state.historyStep !== null && !state.versionPreview;
  $('#history-panel').hidden = !historic;
  $('#show-history').setAttribute('aria-expanded', String(historic));
  $('#show-history').disabled = !state.timeline.steps.length;
  $('#show-brief').textContent = historic ? 'Today’s brief' : 'Map brief';
  if (!historic) return;
  const step = state.timeline.steps[state.historyStep], total = state.timeline.steps.length;
  const label = historyStepLabel(step, total);
  $('#history-slider').max = String(Math.max(0, total - 1)); $('#history-slider').value = String(state.historyStep);
  $('#history-slider').disabled = total < 2;
  $('#history-slider').setAttribute('aria-valuetext', label);
  $('#history-description').textContent = label;
  $('#history-previous').disabled = state.historyStep <= 0;
  $('#history-next').disabled = state.historyStep >= total - 1;
  $('#history-date').textContent = step?.at ? new Date(step.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'The date of these additions was not recorded.';
  $('#history-note').textContent = `Shows when ideas and connections were added. Findings, status and layout are from today. Read-only.${state.timeline.incomplete ? ' Earlier maps may have incomplete dates; undated additions appear in their own step.' : ''}`;
  $('#history-updates').hidden = state.map.revision === state.historySource.revision;
}
function setGrowthStep(index) {
  if (!state.map || gesture || state.mutating) return;
  if (!state.historySource) state.historySource = structuredClone(state.map);
  const timeline = growthTimeline(state.historySource);
  if (!timeline.steps.length) { state.historySource = null; return; }
  state.historyStep = Math.min(timeline.latestStep, Math.max(0, Number(index)));
  renderMap(false, true);
}
function returnLive() {
  const fromVersion = !!state.versionPreview;
  state.historySource = null; state.historyStep = null; state.versionPreview = null; state.versionChoice = null;
  renderMap(false, true);
  $(fromVersion ? '#show-versions' : '#show-history').focus({ preventScroll: true });
}
$('#show-history').addEventListener('click', () => { if (state.historyStep !== null) returnLive(); else setGrowthStep(state.timeline.latestStep); });
$('#return-live').addEventListener('click', returnLive);
$('#history-slider').addEventListener('input', event => setGrowthStep(event.target.value));
$('#history-previous').addEventListener('click', () => setGrowthStep(state.historyStep - 1));
$('#history-next').addEventListener('click', () => setGrowthStep(state.historyStep + 1));

// Version history: one panel to undo, preview and restore. A preview shows the saved version on the
// read-only canvas; nothing changes until the user restores.
function renderVersionsPanel() {
  const panel = $('#versions-panel'), open = !!state.versionsOpen && !!state.map;
  panel.hidden = !open; $('#show-versions').setAttribute('aria-expanded', String(open));
  if (!open) return;
  const data = state.versions, choice = state.versionChoice;
  const when = at => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const heading = `<div class="history-heading"><strong>Versions</strong><button class="secondary" data-version-close>${state.versionPreview ? 'Return to live' : 'Close'}</button></div>`;
  if (choice) {
    const undoing = choice.undo, also = undoing?.alsoUndone.length || 0;
    const shown = undoing ? undoing.undoing : choice.version; // An undo names the change it undoes.
    panel.innerHTML = `${heading}<p class="history-description" role="status">${esc(undoing ? `Undo “${versionLabel(shown)}”` : versionLabel(shown))} · ${esc(when(shown.at))}${shown.author ? ` · ${esc(shown.author)}` : ''}</p>
      <p class="version-summary">${esc(restoreSummary(choice, { undo: !!undoing }))}${also ? ` This also undoes ${also === 1 ? 'a newer change' : `${also} newer changes`} saved after yours.` : ''}</p>
      <div class="version-actions"><button class="primary" data-version-restore>${undoing ? 'Undo' : 'Restore this version'}</button><button class="secondary" data-version-back>Back to the list</button></div>
      ${undoing ? '' : `<details class="version-name"><summary>${choice.version.name ? 'Rename this version' : 'Name this version'}</summary><form data-version-name><label class="visually-hidden" for="version-name">Version name</label><input id="version-name" name="name" maxlength="120" required value="${esc(choice.version.name || '')}" placeholder="For example: Before the workshop"><button class="secondary">Save name</button>${choice.version.name ? '<button type="button" class="text-button" data-version-unname>Remove name</button>' : ''}</form></details>`}`;
    return;
  }
  if (!data) { panel.innerHTML = `${heading}<p class="history-description">Loading versions…</p>`; return; }
  const undo = undoTarget(data.versions, state.contributor);
  panel.innerHTML = `${heading}${undo ? `<button class="secondary version-undo" data-version-undo>Undo last change: ${esc(versionLabel(undo.undoing))}</button>` : ''}
    ${data.versions.length ? `<ul class="version-list">${data.versions.map(version => `<li><button data-version="${esc(version.id)}"><strong>${esc(versionLabel(version))}</strong><small>${esc([version.author, when(version.at)].filter(Boolean).join(' · '))}${version.name ? ' · named' : ''}</small></button></li>`).join('')}</ul>` : '<p class="history-description">No versions yet. Each change you save is kept here.</p>'}
    ${data.failed ? '<p class="version-note">Versions could not be loaded. Close and open the panel to try again.</p>' : ''}${data.earlierMissing ? '<p class="version-note">Earlier versions were not recorded or were tidied away. Committed ones remain in Git history.</p>' : ''}`;
}
async function loadVersions() {
  if (!state.map || state.versionsLoading) return;
  const mapId = state.map.id, revision = state.map.revision;
  state.versionsLoading = true;
  try { const data = await api(`/maps/${mapId}/versions`); if (state.map?.id === mapId) { state.versions = { ...data, revision }; renderVersionsPanel(); } }
  catch (error) { toast(error.message); if (state.map?.id === mapId) { state.versions = { versions: [], earlierMissing: false, revision, failed: true }; renderVersionsPanel(); } }
  finally { state.versionsLoading = false; }
}
async function previewVersion(id, undo = null) {
  const mapId = state.map?.id; if (!mapId || gesture || state.mutating) return;
  try {
    const preview = await api(`/maps/${mapId}/versions/${encodeURIComponent(id)}`);
    if (state.map?.id !== mapId) return;
    state.versionChoice = { ...preview, undo }; state.versionPreview = preview;
    state.historySource = preview.map; state.historyStep = Math.max(0, growthTimeline(preview.map).latestStep);
    renderMap(false, true);
  } catch (error) { toast(error.message); }
}
async function restoreChosen() {
  const choice = state.versionChoice; if (!choice) return;
  returnLive();
  if (await act(null, 'restore-version', { version: choice.version.id, expectedRevision: choice.revision, ...(choice.undo ? { undo: true } : {}) })) toast(choice.undo ? 'Undone. Versions keeps the change you undid.' : 'Restored. You can undo this from Versions.');
  state.versions = null; loadVersions();
}
$('#show-versions').addEventListener('click', () => {
  state.versionsOpen = !state.versionsOpen;
  if (!state.versionsOpen && state.versionPreview) returnLive();
  state.versionChoice = null; renderVersionsPanel();
  if (state.versionsOpen) loadVersions();
});
$('#versions-panel').addEventListener('click', event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.version) previewVersion(button.dataset.version);
  else if ('versionUndo' in button.dataset) { const undo = undoTarget(state.versions?.versions || [], state.contributor); if (undo) previewVersion(undo.target.id, undo); }
  else if ('versionRestore' in button.dataset) restoreChosen();
  else if ('versionBack' in button.dataset) { returnLive(); renderVersionsPanel(); }
  else if ('versionClose' in button.dataset) { state.versionsOpen = false; returnLive(); }
  else if ('versionUnname' in button.dataset) nameChosen(null);
});
// Map tools: Check answers. Nothing runs until the user clicks, and every point waits to be kept or dismissed.
function showTools() {
  if (!state.map) return;
  const choices = answerChoices(state.map);
  $('#tools-choices').innerHTML = choices.length ? choices.map(group => `<fieldset class="tools-group"><legend>${esc(group.title)}</legend>${group.answers.map(answer => `<label class="tools-choice"><input type="checkbox" data-choice-node="${esc(group.nodeId)}" data-choice-question="${esc(answer.questionId)}"> ${esc(answer.question)}</label>`).join('')}</fieldset>`).join('') : '<p class="form-note">No saved answers yet.</p>';
  $('#tools-choose').open = false;
  state.toolsOpen = true; state.toolsPreview = null; state.toolsPreviewRevision = null;
  $('#tools-dialog').showModal();
  renderTools();
}
async function renderTools() {
  if (!state.toolsOpen || !state.map) return;
  const mapId = state.map.id, revision = state.map.revision;
  if (state.toolsPreviewRevision !== revision) {
    state.toolsPreviewRevision = revision;
    try { const preview = await api(`/maps/${mapId}/job-preview?type=check-answers`); if (state.map?.id === mapId) state.toolsPreview = preview; } catch { state.toolsPreview = null; }
  }
  if (state.map?.id === mapId && state.toolsOpen) $('#tools-body').innerHTML = checkAnswersHtml({ map: state.map, preview: state.toolsPreview, listening: agentListening(), esc });
}
$('#show-tools').addEventListener('click', showTools);
$('#tools-dialog').addEventListener('close', () => { state.toolsOpen = false; });
$('#tools-dialog').addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if ('checkAnswers' in button.dataset) {
    const selection = [...document.querySelectorAll('#tools-choices input:checked')].map(box => ({ nodeId: box.dataset.choiceNode, questionId: box.dataset.choiceQuestion }));
    button.disabled = true;
    if (await act(null, 'request-map-job', { jobType: 'check-answers', ...(selection.length ? { selection } : {}) })) toast(agentListening() ? 'Check queued. Your agent will pick it up next.' : 'Check queued. Connect your agent to run it.');
    button.disabled = false; renderTools();
  } else if (button.dataset.cancelJob) { if (await act(null, 'cancel-job', { jobId: button.dataset.cancelJob })) toast('Check stopped.'); renderTools(); }
  else if (button.dataset.reviewItem) { if (await act(null, 'review-proposal', { proposalId: button.dataset.proposal, itemId: button.dataset.reviewItem, decision: button.dataset.decision })) renderTools(); }
  else if (button.dataset.select) $('#tools-dialog').close(); // The page's own handler then focuses that idea.
});
// Loads the restart preview, or its next page of ideas to delete. If the branch changed meanwhile, the
// preview starts again from the first page so it always matches what would be deleted.
async function loadRestartPreview({ nodeId, questionId }, offset = 0) {
  const mapId = state.map?.id; if (!mapId) return;
  const earlier = state.restartPreview?.nodeId === nodeId && state.restartPreview.questionId === questionId ? state.restartPreview : null;
  try {
    const route = start => `/maps/${mapId}/restart-preview?node=${encodeURIComponent(nodeId)}&question=${encodeURIComponent(questionId)}&offset=${start}`;
    let preview = await api(route(offset));
    if (offset && earlier && preview.hash === earlier.preview.hash) preview = { ...preview, deleted: [...earlier.preview.deleted, ...preview.deleted] };
    else if (offset) { preview = await api(route(0)); toast('This branch changed. The preview is updated.'); }
    if (state.map?.id !== mapId) return;
    state.restartPreview = { nodeId, questionId, preview, expanded: Boolean(offset) };
  } catch (error) { toast(error.message); state.restartPreview = null; }
  renderDetail(true);
  document.querySelector('#detail .restart-preview')?.focus();
}
// After a flag is resolved, move to the next flagged finding, or finish when none are left.
function advanceReview(nodeId, position, message) {
  toast(message);
  if (!state.reviewing) return;
  const queue = reviewQueue(state.map).filter(id => id !== nodeId);
  if (!queue.length) { state.reviewing = null; renderDetail(true); toast('All flagged findings are reviewed.'); return; }
  focusNode(queue[Math.min(Math.max(0, position), queue.length - 1)]); renderDetail(true);
}
// The question menu opens on its button, moves with the arrow keys, and closes with Escape back to its button.
function openQuestionMenu(toggle) {
  const menu = document.getElementById(toggle.getAttribute('aria-controls')); if (!menu) return;
  menu.hidden = false; toggle.setAttribute('aria-expanded', 'true');
  menu.querySelector('[role="menuitem"]')?.focus();
}
function closeQuestionMenus(returnFocus = false) {
  for (const menu of document.querySelectorAll('.question-menu:not([hidden])')) {
    menu.hidden = true;
    const toggle = document.querySelector(`[aria-controls="${menu.id}"]`);
    toggle?.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle?.focus();
  }
}
document.addEventListener('keydown', event => {
  const menu = event.target.closest?.('.question-menu');
  if (menu) {
    const items = [...menu.querySelectorAll('[role="menuitem"]')], index = items.indexOf(event.target);
    if (event.key === 'Escape') { event.preventDefault(); closeQuestionMenus(true); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[menuFocusIndex(Math.max(0, index), event.key, items.length)]?.focus(); }
    else if (event.key === 'Tab') closeQuestionMenus();
    return;
  }
  const row = event.target.closest?.('[data-reason-for]');
  if (row && event.key === 'Escape') { row.hidden = true; document.querySelector(`[data-question-menu="${row.dataset.reasonFor}"]`)?.focus(); }
  if (row && event.key === 'Enter') { event.preventDefault(); row.querySelector('[data-send-reason]')?.click(); }
});
// Changing how sure an answer is saves at once; it never re-runs research.
$('#detail').addEventListener('change', event => {
  const select = event.target.closest('[data-certainty]');
  if (select) act(select.dataset.nodeId, 'set-answer-state', { questionId: select.dataset.certainty, answerState: select.value });
});
$('#versions-panel').addEventListener('submit', event => { event.preventDefault(); nameChosen(new FormData(event.target).get('name')); });
async function nameChosen(name) {
  const choice = state.versionChoice; if (!choice) return;
  const mapId = state.map.id;
  try {
    await api(`/maps/${mapId}/action`, { type: name === null ? 'unname-version' : 'name-version', version: choice.version.id, ...(name === null ? {} : { name }), expectedRevision: state.map.revision, expectedFingerprint: state.map.fingerprint ?? undefined });
    toast(name === null ? 'Name removed.' : 'Version named. Named versions are always kept.');
    choice.version = { ...choice.version, name: name === null ? undefined : String(name).trim() };
    state.versions = null; renderVersionsPanel(); loadVersions();
  } catch (error) { toast(error.message); }
}

let briefVersion = 0;
async function showBrief(nodeId = null) {
  if (!state.map) return;
  const mapId = state.map.id, version = ++briefVersion;
  state.brief = null; state.briefScope = nodeId;
  $('#brief-title').textContent = nodeId ? 'Branch brief' : 'Map brief';
  $('#brief-description').textContent = 'Extracted from your latest saved map. Includes recorded findings, decisions, open questions and next directions.';
  $('#brief-content').textContent = ''; $('#brief-status').textContent = 'Preparing your brief…';
  $('#copy-brief').disabled = true; $('#download-brief').disabled = true; $('#retry-brief').hidden = true; $('#brief-copy-fallback').hidden = true;
  if (!$('#brief-dialog').open) $('#brief-dialog').showModal();
  try {
    const brief = await api(`/maps/${mapId}/brief${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ''}`);
    if (version !== briefVersion) return;
    state.brief = brief;
    $('#brief-description').textContent = `${brief.title}. Extracted from your latest saved ${nodeId ? 'branch and its descendants' : 'map'}.`;
    $('#brief-content').innerHTML = briefPreview(brief);
    $('#brief-status').textContent = `Saved revision ${brief.revision}. This brief summarizes recorded material; it does not run new research.`;
    $('#copy-brief').disabled = false; $('#download-brief').disabled = false;
  } catch (error) {
    if (version !== briefVersion) return;
    $('#brief-status').textContent = `Could not prepare the brief. ${error.message}`; $('#retry-brief').hidden = false;
  }
}
$('#show-brief').addEventListener('click', () => showBrief());
$('#retry-brief').addEventListener('click', () => showBrief(state.briefScope));
$('#copy-brief').addEventListener('click', async () => {
  if (!state.brief) return;
  try { await navigator.clipboard.writeText(state.brief.markdown); $('#brief-status').textContent = 'Brief copied. Paste it into a document or your agent.'; }
  catch { const field = $('#brief-copy-fallback'); field.value = state.brief.markdown; field.hidden = false; field.focus(); field.select(); $('#brief-status').textContent = 'Copy the selected brief text below.'; }
});
$('#download-brief').addEventListener('click', () => {
  if (!state.brief) return;
  const url = URL.createObjectURL(new Blob([state.brief.markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = briefFilename(state.brief.title); document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); $('#brief-status').textContent = 'Brief downloaded as Markdown.';
});

function detailFocusKey(element) {
  const form = element.closest('form'), editor = element.closest('details[data-editor]');
  return JSON.stringify([element.tagName, element.getAttribute('href'),
    ...['explore', 'cancel', 'accept', 'branchBrief', 'select'].map(key => element.dataset[key] || null),
    form?.dataset.question || form?.id || null, editor?.dataset.editor || null]);
}
function renderDetail(force = false) {
  const detail = $('#detail'), previousNode = detail.dataset.nodeId;
  const historic = state.historyStep !== null;
  const active = detail.contains(document.activeElement) ? document.activeElement : null;
  // Keep the DOM control itself: copying its value/caret loses native undo and IME composition.
  if (!force && previousNode === state.selected && detail.dataset.history === String(historic) && active?.dataset.draft) {
    state.detailDeferred = true;
    return;
  }
  state.detailDeferred = false;
  detail.dataset.history = String(historic);
  for (const editor of detail.querySelectorAll('details[data-editor]')) state.editors[`${previousNode}:${editor.dataset.editor}`] = editor.open;
  const focus = active ? active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : { control: detailFocusKey(active) } : null;
  const scroll = previousNode === state.selected ? detail.scrollTop : 0;
  detail.dataset.nodeId = state.selected || '';
  const n = state.visibleMap.nodes.find(n => n.id === state.selected);
  if (!n) { detail.innerHTML = `<div class="detail-empty"><span>◇</span>${historic ? 'Select an idea visible at this growth step to read today’s findings.' : 'Select an idea to look closer.'}</div>`; return; }
  const completed = n.completed || n.status === 'explored';
  const pending = ['suggested', 'queued', 'running', 'awaiting-answer', 'interrupted'].includes(n.status);
  const job = state.visibleMap.jobs.filter(j => j.nodeId === n.id && (!j.type || j.type === 'investigate')).at(-1);
  const related = state.visibleMap.edges.filter(e => e.type !== 'contains' && (e.from === n.id || e.to === n.id));
  const nearby = state.visibleMap.nodes.filter(node => node.id === n.parentId || node.parentId === n.id);
  // Answered questions show how sure the answer is; open ones can wait; waiting ones collapse together.
  const answeredBy = q => q.answeredBy?.name ? `<small class="answered-by">Answered by ${esc(q.answeredBy.name)}${answeredSince(q) ? ` · ${esc(new Date(answeredSince(q)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}` : ''}</small>` : '';
  const certainty = q => {
    if (!q.answer) return '';
    if (q.supersededAt || historic) return `<small class="certainty-label">${esc(certaintyText(q))}</small>`;
    const current = effectiveAnswerState(q);
    return `<label class="certainty"><span class="visually-hidden">How sure is this answer?</span><select data-certainty="${q.id}" data-node-id="${n.id}"${current.recorded ? '' : ' title="Certainty not recorded"'}>${answerStates.map(value => `<option value="${value}"${value === current.state ? ' selected' : ''}>${answerStateLabels[value]}</option>`).join('')}</select></label>`;
  };
  // Options with a suggested answer can start the user's draft; nothing is saved until they press Save.
  const suggestions = q => { const drafts = (n.options || []).filter(option => option.suggestedAnswer); return drafts.length ? `<div class="suggested-answers"><span>Start from a suggested answer:</span>${drafts.map(option => `<button type="button" class="text-button" data-suggest-answer="${esc(option.id)}" data-question-id="${q.id}">${esc(option.title)}</button>`).join('')}</div>` : ''; };
  const questionForm = (q, waiting) => `<form class="question-box" data-question="${q.id}" data-node-id="${n.id}"><div class="question-label">${waiting ? 'Saved for later' : 'A question for you'}</div><p id="question-label-${q.id}">${esc(q.text)}</p>${importanceHtml(q, { esc })}${waiting ? '' : questionMenuHtml(q, { nodeId: n.id, kind: 'open', lastBlocking: blockingCount === 1, esc })}<textarea name="answer" aria-labelledby="question-label-${q.id}" placeholder="What do you think?" maxlength="12000" data-draft="${q.id}" required>${esc(state.drafts[q.id] ?? '')}</textarea>${suggestions(q)}<div class="question-actions"><button type="submit" class="primary">Save</button></div></form>`;
  // An answer being saved already counts as answered here, so the next question shows at once.
  const questions = state.pendingAnswers ? n.questions.map(q => !q.answer && state.pendingAnswers[q.id] !== undefined ? { ...q, answer: state.pendingAnswers[q.id], answerState: 'tentative' } : q) : n.questions;
  const live = !completed && !historic, blockingCount = questions.filter(isBlocking).length;
  // Change answer: on an unfinished branch the branch continues from the new answer; on a finished one it
  // becomes a new branch beside the original, started straight away. Nothing is promised in the background.
  const restarting = q => completed && state.restartPreview?.nodeId === n.id && state.restartPreview.questionId === q.id;
  const changeEditor = q => `<div class="change-answer" data-change-for="${q.id}"${restarting(q) ? '' : ' hidden'}><label class="visually-hidden" for="change-${q.id}">Your changed answer</label><textarea id="change-${q.id}" rows="3" maxlength="12000" data-draft="change-${q.id}">${esc(state.drafts[`change-${q.id}`] ?? q.answer)}</textarea>${completed
    ? `<p class="form-note">This branch is finished. Exploring beside the original keeps its findings and starts a new branch from your answer. Restarting deletes the ideas below it, after saving a checkpoint.</p><div class="question-actions"><button type="button" class="primary" data-save-change="fork" data-question-id="${q.id}" data-node-id="${n.id}">Explore beside the original</button><button type="button" class="text-button" data-restart-preview data-question-id="${q.id}" data-node-id="${n.id}">Restart from this answer</button></div>${restarting(q) ? restartPreviewHtml(state.restartPreview.preview, { esc, expanded: state.restartPreview.expanded }) : ''}`
    : `<p class="form-note">Findings that relied on this answer will be flagged for review, and your agent will continue from the new answer.</p><div class="question-actions"><button type="button" class="primary" data-save-change="change" data-question-id="${q.id}" data-node-id="${n.id}">Save</button><button type="button" class="text-button" data-save-wording data-question-id="${q.id}" data-node-id="${n.id}">Save without re-running</button></div>`}</div>`;
  // A question being regenerated shows where its replacement will appear; it never promises background work.
  const pendingBox = q => `<div class="question-box pending-question"><div class="question-label">Getting a new question…</div><p>${esc(q.text)}</p><p class="form-note">${agentListening() ? 'Your agent is writing a better question.' : 'Queued for your agent.'}</p></div>`;
  const dismissed = questions.filter(q => q.dismissedAt && q.replacedBy !== 'pending');
  const canRestore = q => live && n.status === 'awaiting-answer' && !q.replacedBy;
  const importance = q => importanceLabel(q.importance) ? `<small class="certainty-label">${importanceLabel(q.importance)}</small>` : '';
  const record = q => `<div class="answer"><strong>${esc(q.text)}</strong>${importance(q)}${q.answer ? `${q.supersededAt ? '<em>Answer from an earlier premise.</em><br>' : ''}${esc(q.answer)}${certainty(q)}${answeredBy(q)}${(q.previousAnswers || []).map(p => `<small class="certainty-label">Earlier answer: ${esc(p.answer)}</small>`).join('')}${!historic && !q.supersededAt ? questionMenuHtml(q, { nodeId: n.id, kind: 'answered', esc }) + changeEditor(q) : ''}` : q.supersededAt ? 'Superseded by a changed premise; no answer is needed.' : historic ? 'Unanswered. Return to live to continue this question.' : q.deferredAt ? 'Saved for later. Add a new direction to explore it.' : 'Unanswered historical question. Add a new direction to investigate it.'}</div>`;
  const waiting = live ? questions.filter(q => isOpen(q) && q.deferredAt) : [];
  const listHtml = questions.filter(q => !waiting.includes(q) && !dismissed.includes(q)).map(q => live && q.replacedBy === 'pending' && !q.supersededAt ? pendingBox(q) : live && isBlocking(q) ? questionForm(q, false) : record(q)).join('');
  // One question at a time: a counter, the current question, earlier answers collapsed, and Show all.
  const sequence = live ? questionSequence({ questions }) : null;
  const oneAtATime = sequence?.current && sequence.total > 1 && !state.showAllQuestions;
  const yours = questions.filter(q => q.answer && !q.supersededAt);
  const questionHtml = (oneAtATime
    ? questions.filter(q => q.supersededAt).map(record).join('')
      + (yours.length ? `<details class="saved-for-later your-answers"><summary>Your answers (${yours.length})</summary>${yours.map(record).join('')}</details>` : '')
      + `<p class="question-counter" aria-live="polite">Question ${sequence.index} of ${sequence.total}</p>${questionForm(sequence.current, false)}`
      + questions.filter(q => q.replacedBy === 'pending' && !q.supersededAt).map(pendingBox).join('')
      + '<button type="button" class="text-button show-questions" data-show-all-questions>Show all</button>'
    : listHtml
      + (sequence?.current && sequence.total > 1 ? '<button type="button" class="text-button show-questions" data-show-one-question>Show one at a time</button>' : '')
      + (sequence && !sequence.current && sequence.total > 1 && ['queued', 'running'].includes(n.status) ? '<p class="state-note">That’s all for now. Your agent will continue this branch.</p>' : ''))
    + (waiting.length ? `<details class="saved-for-later"><summary>Saved for later (${waiting.length})</summary>${waiting.map(q => questionForm(q, true)).join('')}</details>` : '')
    + (dismissed.length ? `<details class="saved-for-later dismissed-questions"><summary>Dismissed (${dismissed.length})</summary>${dismissed.map(q => `<div class="answer"><strong>${esc(q.text)}</strong>${q.ratingReason ? `<small class="certainty-label">${esc(q.ratingReason)}</small>` : ''}${q.replacedBy ? '<small class="certainty-label">Replaced by a new question.</small>' : ''}${canRestore(q) ? `<button type="button" class="text-button" data-q-restore data-question-id="${q.id}" data-node-id="${n.id}">Restore</button>` : ''}</div>`).join('')}</details>` : '');
  // Reviewing flagged findings: one step at a time, at the top of the inspector.
  let reviewHtml = '';
  if (state.reviewing && !historic) {
    const queue = reviewQueue(state.map), index = queue.indexOf(n.id);
    // A resolved finding re-renders before the walk-through moves on; leaving is up to Done or an empty queue.
    if (index >= 0) reviewHtml = reviewStepHtml({ map: state.map, nodeId: n.id, index, total: queue.length, esc });
  }
  $('#detail').innerHTML = `${reviewHtml}<div class="detail-kind"><span class="kind-tag"><b aria-hidden="true">${glyphs[n.kind]}</b>${n.kind.charAt(0).toUpperCase() + n.kind.slice(1)}</span><span class="status-label ${pending ? 'pending' : ''}">${esc(presentation(n).label)}</span></div><h2>${esc(n.title)}</h2><p class="detail-summary">${esc(n.summary)}</p>${n.acceptedBy?.name ? `<p class="accepted-by">Accepted by ${esc(n.acceptedBy.name)}</p>` : ''}${optionsHtml(n, esc)}
    ${historic ? `<p class="state-note history-detail-note">${state.versionPreview ? `A saved version from ${esc(new Date(state.versionPreview.version.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}, read-only. These are the findings and status as they were then.` : 'Read-only growth history. These are today’s findings and status, not a past version of the research.'}</p>` : ''}
    ${n.stale ? `<p class="state-note warning">An earlier premise changed. These findings need another look before you rely on them.${!historic && !reviewHtml ? ` <button type="button" class="text-button" data-review-start="${n.id}">Review this</button>` : ''}</p>` : ''}
    ${completed && !historic ? '<p class="state-note">This branch is complete. Add a new direction to keep exploring; these findings stay here.</p>' : ''}
    ${n.status === 'suggested' && !historic ? '<p class="state-note">A possible direction. Nothing runs until you choose to explore it.</p>' : ''}
    ${n.status === 'queued' && !historic ? `<p class="state-note">${agentListening() ? 'Your agent will pick up this branch next.' : 'Saved in the queue. Connect your agent to start this investigation.'}</p>` : ''}
    ${n.status === 'running' && !historic ? '<p class="state-note">Your agent is exploring this direction. New questions and findings will appear here.</p>' : ''}
    ${job?.error ? `<p class="state-note warning">${esc(job.error)}</p>` : ''}
    ${!historic ? `<div class="detail-actions">${!completed && ['suggested', 'interrupted'].includes(n.status) ? `<button class="primary" data-explore="${n.id}">${n.status === 'suggested' ? 'Explore this branch' : 'Retry exploration'}</button>` : ''}${!completed && ['queued', 'running'].includes(n.status) ? `<button class="secondary" data-cancel="${n.id}">Stop exploration</button>` : ''}${n.status === 'explored' && n.reviewState !== 'accepted' && !n.stale ? `<button class="secondary" data-accept="${n.id}">Accept finding</button>` : ''}<button class="secondary" data-branch-brief="${n.id}">Branch brief</button></div>` : ''}
    ${questionHtml}
    ${nearby.length ? `<h3 class="section-label">Nearby ideas</h3>${nearby.slice(0, 12).map(node => `<button class="relationship" data-select="${node.id}">${node.id === n.parentId ? 'Back to parent' : esc(presentation(node).label)}<strong>${esc(node.title)}</strong></button>`).join('')}${nearby.length > 12 ? '<p class="form-note">More directions are available through Find an idea.</p>' : ''}` : ''}
    ${n.body && n.body !== n.summary ? `<h3 class="section-label">${n.status === 'suggested' ? 'What to explore' : 'Notes & findings'}</h3><div class="prose">${prose(n.body)}</div>` : ''}
    ${job?.stale && job.result ? `<h3 class="section-label">Result from the earlier premise</h3><div class="prose">${prose(job.result.body)}</div>` : ''}
    ${n.sources.length ? `<h3 class="section-label">Sources & evidence</h3>${n.sources.map(s => `<a class="evidence-link" href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)} <span aria-hidden="true">↗</span><small>${esc(s.note)}</small></a>`).join('')}` : ''}
    ${related.length ? `<h3 class="section-label">Connected thinking</h3>${related.map(e => { const target = state.visibleMap.nodes.find(node => node.id === (e.from === n.id ? e.to : e.from)); return target ? `<button class="relationship" data-select="${target.id}">${esc(e.type.replaceAll('_', ' '))}<strong>${esc(target.title)}</strong></button>` : ''; }).join('')}` : ''}
    ${!historic ? `<details data-editor="suggest"><summary>Add a direction</summary><form id="suggest-form" data-node-id="${n.id}"><label for="branch-title">What's worth exploring?</label><input id="branch-title" name="title" maxlength="100" data-draft="${n.id}-title" value="${esc(state.drafts[`${n.id}-title`] ?? '')}" required><label for="branch-body">A little context</label><textarea id="branch-body" name="body" rows="3" maxlength="4000" data-draft="${n.id}-branch">${esc(state.drafts[`${n.id}-branch`] ?? '')}</textarea><button type="submit" class="secondary">Add suggested branch</button></form></details>
    <details data-editor="revise"><summary>${completed ? 'Explore a changed premise' : 'Revise this premise'}</summary><form id="revise-form" data-completed="${completed}" data-node-id="${n.id}"><label for="revised-body">What changed?</label><textarea id="revised-body" name="body" rows="5" maxlength="16000" required data-draft="${n.id}-revision">${esc(state.drafts[`${n.id}-revision`] ?? n.prompt ?? n.body)}</textarea><p class="form-note">${completed ? 'Creates a new branch and starts exploring it. Affected findings are flagged for review; the original is preserved.' : "Dependent findings will be marked for review. Research won't restart automatically."}</p><button type="submit" class="secondary">${completed ? 'Add changed-premise branch' : 'Save revised premise'}</button></form></details>` : ''}
    ${job?.contextCharacters ? `<p class="run-note">Last investigation used ${job.contextCharacters.toLocaleString()} characters of map context. Only relevant context is sent.</p>` : ''}`;
  for (const editor of detail.querySelectorAll('details[data-editor]')) editor.open = Boolean(state.editors[`${n.id}:${editor.dataset.editor}`]);
  if (focus && previousNode === n.id) {
    const control = focus.key ? [...detail.querySelectorAll('[data-draft]')].find(item => item.dataset.draft === focus.key)
      : [...detail.querySelectorAll('button, a[href], summary')].find(item => !item.disabled && detailFocusKey(item) === focus.control);
    if (control) { control.focus({ preventScroll: true }); if (focus.key && focus.start !== null) control.setSelectionRange(focus.start, focus.end); }
    else { detail.tabIndex = -1; detail.focus({ preventScroll: true }); }
  }
  detail.scrollTop = scroll;
}
function act(nodeId, type, extra = {}) {
  if (!state.map || state.historyStep !== null) return Promise.resolve(false);
  const mapId = state.map.id;
  const execute = async () => {
    if (state.map?.id !== mapId || state.historyStep !== null) return false;
    state.mutating = true;
    try {
      const result = await api(`/maps/${mapId}/action`, { nodeId, type, expectedRevision: state.map.revision, expectedFingerprint: state.map.fingerprint ?? undefined, ...extra });
      state.mutations++;
      if (state.map?.id === mapId) { state.map = result; renderMap(); }
      return true;
    } catch (error) {
      toast(error.message);
      // Reload acknowledged coordinates after a conflict instead of displaying an unsaved move.
      try {
        const current = await api(`/maps/${mapId}`);
        // The refusal already explained any pull, so it is not announced again later.
        state.outsideSeen[mapId] = current.outsideChange?.at;
        if (state.map?.id === mapId) { state.map = current; renderMap(); }
      } catch { connectionView(true); }
      return false;
    } finally { state.mutating = false; }
  };
  const result = actionTail.then(execute); actionTail = result.catch(() => {}); return result;
}
let createVersion = 0;
function showCreate() {
  createVersion++;
  $('#create-error').textContent = '';
  $('#create-form').querySelector('button[type="submit"]').disabled = false;
  $('#create-dialog').showModal(); $('#idea').focus();
}
function showWelcome() {
  openVersion++; state.map = null; state.visibleMap = null; state.selected = null; state.historyStep = null; state.historySource = null; state.filter = null; state.versionPreview = null; state.versionChoice = null; state.versions = null; state.versionsOpen = false; state.reviewing = null; state.restartPreview = null; localStorage.removeItem('explore-map'); navigation(false);
  $('#welcome').classList.remove('hidden'); $('#workspace').classList.add('hidden'); $('#map-title').textContent = 'A place to think'; renderRail();
}
$('.brand').addEventListener('click', event => { event.preventDefault(); showWelcome(); location.hash = ''; });
$('#new-map').addEventListener('click', showCreate); $('#start-exploration').addEventListener('click', showCreate);
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
function showHelp() {
  const session = state.session || {};
  const target = state.map ? `Continue only map ${state.map.id} (${state.map.title}). Pick up activated branches for this map only.` : 'Ask me which saved map to continue, then pick up its activated branches.';
  $('#agent-prompt').value = `Use the Explore skill at ${session.skillPath || 'skills/explore/SKILL.md'} to continue the workspace ${session.workspacePath || session.workspace || ''}. The local app is running. ${target} Use the command bridge, keep context focused, and send findings and questions back to the map.`;
  $('#agent-copy-status').textContent = ''; $('#help-dialog').showModal();
}
$('#bridge-status').addEventListener('click', showHelp);
$('#copy-prompt').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#agent-prompt').value); $('#agent-copy-status').textContent = 'Prompt copied. Paste it into your coding agent.'; } catch { $('#agent-prompt').focus(); $('#agent-prompt').select(); $('#agent-copy-status').textContent = 'Copy the selected prompt above.'; } });
$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, button = event.submitter || form.querySelector('button[type="submit"]');
  button.disabled = true; $('#create-error').textContent = '';
  const version = createVersion, navigationVersion = openVersion, dialog = $('#create-dialog');
  const data = new FormData(form), submittedIdea = data.get('idea'), submittedTitle = data.get('title');
  const idea = submittedIdea.trim(), title = submittedTitle.trim() || idea.split(/\s+/).slice(0, 7).join(' ').slice(0, 100);
  const currentDraft = () => version === createVersion && navigationVersion === openVersion && dialog.open && $('#idea').value === submittedIdea && $('#title').value === submittedTitle;
  try {
    const map = await api('/maps', { title, idea });
    await refresh();
    const follow = currentDraft();
    if (follow) { dialog.close(); form.reset(); await openMap(map.id); }
    toast(follow ? 'Your idea is saved. Its first exploration is queued.' : `“${map.title}” is saved in Maps. Its first exploration is queued.`);
  } catch (error) {
    if (currentDraft()) $('#create-error').textContent = error.message;
    else toast(`Could not save “${title}”: ${error.message}`);
  } finally {
    if (version === createVersion) button.disabled = false;
  }
});
$('#open-example').addEventListener('click', async event => {
  event.target.disabled = true;
  try { const existing = state.maps.find(m => m.demo); const map = existing || await api('/demo', {}); await refresh(); await openMap(map.id); }
  catch (error) { toast(error.message); } finally { event.target.disabled = false; }
});
document.addEventListener('click', async event => {
  if (suppressClick) { suppressClick = false; return; }
  const map = event.target.closest('[data-map]'); if (map) return openMap(map.dataset.map);
  if (!event.target.closest('#node-finder')) $('#node-results').hidden = true;
  const focus = event.target.closest('[data-focus-node]'); if (focus) return focusNode(focus.dataset.focusNode);
  const select = event.target.closest('[data-select]'); if (select) return focusNode(select.dataset.select);
  const example = event.target.closest('[data-example]');
  if (example) { const starter = starterIdeas[example.dataset.example]; if (starter) { $('#idea').value = starter.idea; $('#title').value = starter.title; $('#idea').focus(); } return; }
  const brief = event.target.closest('[data-branch-brief]'); if (brief) return showBrief(brief.dataset.branchBrief);
  const suggested = event.target.closest('[data-suggest-answer]');
  if (suggested) {
    const option = state.map?.nodes.find(node => node.id === state.selected)?.options?.find(item => item.id === suggested.dataset.suggestAnswer);
    const field = document.querySelector(`[data-draft="${suggested.dataset.questionId}"]`);
    if (option?.suggestedAnswer && field) { field.value = appendSuggestion(field.value, option.suggestedAnswer); state.drafts[suggested.dataset.questionId] = field.value; field.focus(); }
    return;
  }
  if (event.target.closest('[data-show-all-questions]')) { state.showAllQuestions = true; renderDetail(true); return; }
  if (event.target.closest('[data-show-one-question]')) { state.showAllQuestions = false; renderDetail(true); document.querySelector('#detail form.question-box textarea')?.focus(); return; }
  const changeOpen = event.target.closest('[data-q-change]');
  if (changeOpen) { closeQuestionMenus(); const editor = document.querySelector(`[data-change-for="${changeOpen.dataset.questionId}"]`); if (editor) { editor.hidden = false; editor.querySelector('textarea').focus(); } return; }
  const changeSave = event.target.closest('[data-save-change], [data-save-wording]');
  if (changeSave) {
    const questionId = changeSave.dataset.questionId, field = document.querySelector(`#change-${questionId}`), answer = field?.value.trim();
    if (!answer) { field?.focus(); return; }
    changeSave.disabled = true;
    const fork = changeSave.dataset.saveChange === 'fork';
    const done = fork ? await act(changeSave.dataset.nodeId, 'fork-revision', { questionId, answer, start: true })
      : await act(changeSave.dataset.nodeId, 'change-answer', { questionId, answer, ...('saveWording' in changeSave.dataset ? { rerun: false } : {}) });
    if (done) { delete state.drafts[`change-${questionId}`]; toast(fork ? (agentListening() ? 'A new branch is exploring your changed answer.' : 'A new branch is queued for your changed answer. Connect your agent to explore it.') : 'saveWording' in changeSave.dataset ? 'Wording saved.' : 'Answer changed. Findings that relied on it are flagged for review.'); }
    changeSave.disabled = false; return;
  }
  // Restart from this answer: preview first; nothing is deleted until the user confirms.
  const restartOpen = event.target.closest('[data-restart-preview]');
  if (restartOpen) {
    const { questionId, nodeId } = restartOpen.dataset, field = document.querySelector(`#change-${questionId}`), answer = field?.value.trim();
    const saved = state.map?.nodes.find(node => node.id === nodeId)?.questions.find(q => q.id === questionId)?.answer;
    if (!answer || answer === saved) { toast('Change the answer first, then restart from it.'); field?.focus(); return; }
    restartOpen.disabled = true; await loadRestartPreview({ nodeId, questionId }); restartOpen.disabled = false; return;
  }
  const restartMore = event.target.closest('[data-restart-more]');
  if (restartMore && state.restartPreview) { await loadRestartPreview(state.restartPreview, Number(restartMore.dataset.restartMore)); return; }
  if (event.target.closest('[data-restart-cancel]')) {
    const questionId = state.restartPreview?.questionId; state.restartPreview = null; renderDetail(true);
    const editor = document.querySelector(`[data-change-for="${questionId}"]`); if (editor) { editor.hidden = false; editor.querySelector('textarea').focus(); }
    return;
  }
  const restartConfirm = event.target.closest('[data-restart-confirm]');
  if (restartConfirm && state.restartPreview) {
    const { nodeId, questionId, preview } = state.restartPreview, answer = document.querySelector(`#change-${questionId}`)?.value.trim();
    if (!answer) { document.querySelector(`#change-${questionId}`)?.focus(); return; }
    restartConfirm.disabled = true;
    if (await act(nodeId, 'restart-branch', { questionId, answer, previewHash: preview.hash })) {
      state.restartPreview = null; delete state.drafts[`change-${questionId}`]; renderDetail(true);
      toast(`Branch restarted. Its checkpoint is saved in Versions. ${agentListening() ? 'Your agent will explore it next.' : 'Connect your agent to explore it.'}`);
    } else if (state.restartPreview) await loadRestartPreview(state.restartPreview); // Show what would happen now.
    return;
  }
  // Review flagged findings.
  const reviewStart = event.target.closest('[data-review-start]');
  if (reviewStart) {
    const queue = reviewQueue(state.map), id = reviewStart.dataset.reviewStart || queue[0]; if (!id) return;
    state.reviewing = {}; state.filter = null; renderOverview(); focusNode(id); renderDetail(true); return;
  }
  const reviewMove = event.target.closest('[data-review-prev], [data-review-next]');
  if (reviewMove && state.reviewing) {
    const queue = reviewQueue(state.map), index = Math.max(0, Math.min(queue.length - 1, queue.indexOf(state.selected) + ('reviewNext' in reviewMove.dataset ? 1 : -1)));
    focusNode(queue[index]); renderDetail(true); return;
  }
  if (event.target.closest('[data-review-exit]')) { state.reviewing = null; renderDetail(true); return; }
  const resolve = event.target.closest('[data-resolve]');
  if (resolve) {
    const nodeId = resolve.dataset.nodeId, kind = resolve.dataset.resolve;
    if (kind === 'reexplore') { const box = document.querySelector(`[data-reexplore-for="${nodeId}"]`); if (box) { box.hidden = false; box.querySelector('textarea').focus(); } return; }
    const position = reviewQueue(state.map).indexOf(nodeId);
    if (await act(nodeId, kind === 'reaffirm' ? 'reaffirm' : 'clear-finding')) advanceReview(nodeId, position, kind === 'reaffirm' ? 'Marked as still holding.' : 'Marked as no longer relevant.');
    return;
  }
  const confirmReexplore = event.target.closest('[data-reexplore-confirm]');
  if (confirmReexplore) {
    const nodeId = confirmReexplore.dataset.reexploreConfirm, node = state.map.nodes.find(item => item.id === nodeId);
    const premise = node.prompt || node.body, body = document.querySelector(`#reexplore-${nodeId}`)?.value.trim() || premise;
    const position = reviewQueue(state.map).indexOf(nodeId);
    confirmReexplore.disabled = true;
    let done;
    if (node.completed) done = await act(nodeId, 'fork-revision', { body, resolveReview: true, start: true });
    else { done = body === premise ? true : await act(nodeId, 'revise', { body }); if (done) done = await act(nodeId, 'activate'); }
    confirmReexplore.disabled = false;
    if (done) advanceReview(nodeId, position, agentListening() ? 'Re-exploring. Your agent will pick it up next.' : 'Queued to re-explore. Connect your agent to run it.');
    return;
  }
  // The question ⋯ menu.
  const menuToggle = event.target.closest('[data-question-menu]');
  if (menuToggle) { const opening = menuToggle.getAttribute('aria-expanded') !== 'true'; closeQuestionMenus(); if (opening) openQuestionMenu(menuToggle); return; }
  if (!event.target.closest('.question-menu')) closeQuestionMenus();
  const rate = event.target.closest('[data-q-rate]');
  if (rate) { closeQuestionMenus(); if (await act(rate.dataset.nodeId, 'rate-question', { questionId: rate.dataset.questionId, rating: rate.dataset.qRate || null })) toast(rate.dataset.qRate ? 'Thanks. Your agent will ask more like this.' : 'Rating removed.'); return; }
  const reason = event.target.closest('[data-q-reason]');
  if (reason) { closeQuestionMenus(); const row = document.querySelector(`[data-reason-for="${reason.dataset.questionId}"]`); if (row) { row.hidden = false; row.dataset.action = reason.dataset.qReason; row.querySelector('button').textContent = reason.dataset.qReason === 'regenerate' ? 'Get a new question' : 'Send'; row.querySelector('input').focus(); } return; }
  const send = event.target.closest('[data-send-reason]');
  if (send) {
    const row = send.closest('[data-reason-for]'), text = row.querySelector('input').value.trim(), questionId = send.dataset.sendReason;
    send.disabled = true;
    const done = row.dataset.action === 'regenerate'
      ? await act(send.dataset.nodeId, 'regenerate-question', { questionId, ...(text ? { reason: text } : {}) })
      : await act(send.dataset.nodeId, 'rate-question', { questionId, rating: 'bad', ...(text ? { reason: text } : {}) });
    if (done) toast(row.dataset.action === 'regenerate' ? (agentListening() ? 'Your agent will write a better question.' : 'Queued. Connect your agent for a new question.') : 'Thanks. Your agent will ask fewer questions like this.');
    send.disabled = false; return;
  }
  const dismiss = event.target.closest('[data-q-dismiss]');
  if (dismiss) { closeQuestionMenus(); if (await act(dismiss.dataset.nodeId, 'dismiss-question', { questionId: dismiss.dataset.questionId })) toast(state.map?.nodes.find(node => node.id === dismiss.dataset.nodeId)?.questions.some(isBlocking) ? 'Dismissed.' : 'Dismissed. The branch continues without it.'); return; }
  const restore = event.target.closest('[data-q-restore]');
  if (restore) { if (await act(restore.dataset.nodeId, 'restore-question', { questionId: restore.dataset.questionId })) toast('The question is back.'); return; }
  const later = event.target.closest('[data-answer-later]');
  if (later) { closeQuestionMenus(); later.disabled = true; if (await act(later.dataset.nodeId, 'answer-later', { questionId: later.dataset.answerLater })) toast(state.map?.nodes.find(node => node.id === later.dataset.nodeId)?.questions.some(isBlocking) ? 'Saved for later.' : 'Saved for later. The branch continues without it.'); later.disabled = false; return; }
  for (const [attribute, action, message] of [['explore', 'activate', 'Exploration queued.'], ['cancel', 'cancel', 'Cancelled. An active agent may finish its current step.'], ['accept', 'accept', 'Finding accepted.']]) {
    const button = event.target.closest(`[data-${attribute}]`);
    if (button) { button.disabled = true; if (await act(button.dataset[attribute], action)) toast(message); button.disabled = false; return; }
  }
  const card = event.target.closest('.node'); if (card) focusNode(card.dataset.node);
});
$('#detail').addEventListener('input', event => { if (event.target.dataset.draft) state.drafts[event.target.dataset.draft] = event.target.value; });
$('#detail').addEventListener('submit', async event => {
  event.preventDefault(); if (state.historyStep !== null) return;
  const submittedMapId = state.map?.id;
  const form = event.target; const button = event.submitter; button.disabled = true;
  const data = Object.fromEntries(new FormData(form)); const node = form.dataset.nodeId;
  const fields = [...form.querySelectorAll('[data-draft]')];
  const submittedDrafts = new Map(fields.map(field => [field.dataset.draft, field.value]));
  // An answer is final once saved; do not allow a second, unsavable answer during the request.
  const answerFields = form.dataset.question ? fields.map(field => [field, field.readOnly]) : [];
  for (const [field] of answerFields) field.readOnly = true;
  try {
    let success = false;
    if (form.dataset.question) {
      // Show the next question at once; the answer stays local until the server confirms it, and a failure brings the question back.
      const questionId = form.dataset.question;
      state.pendingAnswers = { ...(state.pendingAnswers || {}), [questionId]: data.answer };
      if (!state.showAllQuestions) { renderDetail(true); document.querySelector?.('#detail form.question-box textarea')?.focus(); }
      try { success = await act(node, 'answer', { questionId, answer: data.answer }); }
      finally { delete state.pendingAnswers[questionId]; }
      if (!success) renderDetail(true);
    }
    if (form.id === 'suggest-form') success = await act(node, 'suggest', { title: data.title, body: data.body.trim() || data.title });
    if (form.id === 'revise-form') success = await act(node, form.dataset.completed === 'true' ? 'fork-revision' : 'revise', form.dataset.completed === 'true' ? { ...data, start: true } : data);
    if (success) {
      let newerDrafts = false;
      for (const [key, value] of submittedDrafts) {
        if (state.drafts[key] === value) delete state.drafts[key];
        else if (state.drafts[key] !== undefined) newerDrafts = true;
      }
      const active = $('#detail').contains(document.activeElement) ? document.activeElement : null;
      const preserveActiveDraft = active?.dataset.draft && (!submittedDrafts.has(active.dataset.draft) || active.value !== submittedDrafts.get(active.dataset.draft));
      if (state.visibleMap) renderDetail(state.map?.id === submittedMapId && state.selected === node && !preserveActiveDraft);
      toast(form.dataset.question ? (state.map?.nodes.find(item => item.id === node)?.questions.some(isBlocking) ? 'Answer saved.' : 'Answer saved. Your branch will continue.') : newerDrafts ? 'Saved the submitted version. Your newer edits are kept as a draft.' : 'Saved to your map.');
    }
  } finally {
    for (const [field, readOnly] of answerFields) field.readOnly = readOnly;
    button.disabled = false;
  }
});
$('#zoom-in').addEventListener('click', () => zoom(1.2)); $('#zoom-out').addEventListener('click', () => zoom(1 / 1.2)); $('#fit-map').addEventListener('click', fitMap);
$('#canvas').addEventListener('wheel', event => { event.preventDefault(); if (gesture) return; const rect = $('#canvas').getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.08 : 1 / 1.08, event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
$('#canvas').addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || gesture || state.mutating || !state.map) return;
  const node = event.target.closest('.node');
  if (node && state.historyStep !== null) return;
  gesture = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: state.x, y: state.y, scale: state.scale, nodeId: node?.dataset.node, position: node ? { ...state.positions[node.dataset.node] } : null, moved: false };
  $('#canvas').setPointerCapture(event.pointerId);
});
$('#canvas').addEventListener('pointermove', event => {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  const dx = event.clientX - gesture.clientX, dy = event.clientY - gesture.clientY;
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
  gesture.moved = true; $('#canvas').classList.add('dragging');
  if (gesture.nodeId) {
    const pos = { x: gesture.position.x + dx / gesture.scale, y: gesture.position.y + dy / gesture.scale }; state.positions[gesture.nodeId] = pos;
    const el = document.querySelector(`[data-node="${gesture.nodeId}"]`); el.style.left = `${pos.x}px`; el.style.top = `${pos.y}px`; renderEdges();
  } else { state.overview = false; state.x = gesture.x + dx; state.y = gesture.y + dy; transform(); }
});
async function finishGesture(event) {
  if (!gesture || event.pointerId !== gesture.pointer) return;
  const finished = gesture; gesture = null; $('#canvas').classList.remove('dragging');
  if ($('#canvas').hasPointerCapture(event.pointerId)) $('#canvas').releasePointerCapture(event.pointerId);
  if (finished.moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 100); }
  if (event.type !== 'pointerup') { renderMap(); return; }
  if (finished.nodeId) {
    if (finished.moved) {
      selectNode(finished.nodeId);
      $('#saved-state').textContent = 'Saving position…';
      await act(finished.nodeId, 'position', { ...state.positions[finished.nodeId] });
    } else {
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 100);
      focusNode(finished.nodeId);
    }
  }
}
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('#canvas').addEventListener(type, finishGesture);
$('#nodes').addEventListener('keydown', async event => {
  const node = event.target.closest('.node');
  if (!node || !event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault(); if (state.mutating || gesture || state.historyStep !== null) return;
  const id = node.dataset.node, pos = state.positions[id];
  const x = pos.x + (event.key === 'ArrowLeft' ? -24 : event.key === 'ArrowRight' ? 24 : 0);
  const y = pos.y + (event.key === 'ArrowUp' ? -24 : event.key === 'ArrowDown' ? 24 : 0);
  selectNode(id); await act(id, 'position', { x, y }); $(`[data-node="${id}"]`)?.focus();
});
window.addEventListener('resize', () => { if (state.map && state.historyStep === null) { if (state.overview) fitMap(); else centerSelected(); } });
window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== state.map?.id) openMap(id); else if (!id) showWelcome(); });
try {
  const session = await (await fetch('/api/session')).json(); state.token = session.token; state.session = session;
  $('#workspace-name').textContent = session.version ? `${session.workspace} · Explore ${session.version}` : session.workspace;
  // Contributions are attributed by Git name; say plainly when there is none.
  api('/contributor').then(person => { state.contributor = person.name; $('#contributor').textContent = person.name ? `You: ${person.name} (from Git)` : 'Answers aren’t attributed: Git has no user name.'; }).catch(() => {});
  await refresh();
  const saved = location.hash.slice(1) || localStorage.getItem('explore-map');
  if (saved && state.maps.some(m => m.id === saved)) await openMap(saved);
  setInterval(refresh, 2500);
} catch (error) { toast(`Cannot connect to the workspace: ${error.message}`); connectionView(true); }
