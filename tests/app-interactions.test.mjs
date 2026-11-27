import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as questionHelpers from '../skills/explore/assets/questions.js';
import { openMapChange, unreadableLabel, outsideChangeNote, versionLabel, undoTarget, restoreSummary, optionsHtml, appendSuggestion, questionMenuHtml, questionSequence, reviewQueue, reviewStepHtml, restartPreviewHtml, importanceHtml, nodeMenuHtml, nodeReference, questionHelpHtml, questionResearchHtml, researchSuggestion, questionTidyHtml, tidyArrived } from '../skills/explore/assets/workspace-view.js';

const app = await readFile(new URL('../skills/explore/assets/app.js', import.meta.url), 'utf8');
const viewHelpers = { tidyArrived, openMapChange, unreadableLabel, outsideChangeNote, versionLabel, undoTarget, restoreSummary, optionsHtml, appendSuggestion, ...questionHelpers };
function between(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'The actual UI callback boundaries must remain available.');
  return app.slice(from, to);
}
const callbacks = between('function agentListening(', '\nfunction connectionView(') + '\n' +
  between('function detailFocusKey(', '\nfunction act(') + '\n' +
  between("$('#detail').addEventListener('submit'", "\n$('#zoom-in')");

// Execute the real callbacks with DOM/API boundaries replaced. This verifies control
// replacement decisions, not browser-native undo or IME behavior itself.
function harness({ question = false } = {}) {
  const node = id => ({ id, kind: 'research', title: id, summary: 'Saved premise', body: 'Saved premise',
    status: 'suggested', reviewState: 'unreviewed', questions: [], sources: [] });
  const state = { map: { id: 'map-a' }, selected: 'node-a', historyStep: null, helpSeen: new Set(),
    visibleMap: { nodes: [node('node-a'), node('node-b')], edges: [], jobs: [] },
    editors: {}, drafts: { 'node-a-title': 'Submitted title', 'node-a-branch': 'Submitted body' }, bridge: {} };
  const document = { activeElement: null };
  let writes = 0, submit, complete, markup = '';
  const fields = new Map(), controlSpecs = [];
  let controls = [];
  const field = (key, value, name) => ({ owner: detail, dataset: { draft: key }, value, name,
    readOnly: false, selectionStart: 2, selectionEnd: 2,
    focus() { document.activeElement = this; }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } });
  const control = spec => ({ owner: detail, dataset: {}, ...spec,
    getAttribute(name) { return this[name] ?? null; },
    closest(selector) { return selector === 'form' ? this.form : this.editor; },
    focus() { document.activeElement = this; } });
  const detail = { dataset: { nodeId: 'node-a', history: 'false' }, scrollTop: 0,
    contains: element => !!element && element.owner === detail,
    querySelectorAll: selector => selector === '[data-draft]' ? [...fields.values()] : selector === 'button, a[href], summary' ? controls : [],
    addEventListener: (event, callback) => { if (event === 'submit') submit = callback; },
    focus() { document.activeElement = this; },
    set innerHTML(value) {
      writes++; markup = value; document.activeElement = null;
      for (const [key, previous] of fields) fields.set(key, field(key, state.drafts[key] ?? '', previous.name));
      controls = controlSpecs.map(control);
    } };
  const focusDraft = (key, value) => {
    state.drafts[key] = value;
    if (!fields.has(key)) fields.set(key, field(key, value));
    const current = fields.get(key); current.value = value; current.focus();
    return current;
  };
  fields.set('node-a-title', field('node-a-title', 'Submitted title', 'title'));
  fields.set('node-a-branch', field('node-a-branch', 'Submitted body', 'body'));
  focusDraft('node-a-title', 'Submitted title');
  const pending = new Promise(resolve => { complete = resolve; });
  const context = vm.createContext({ state, document, $: () => detail,
    glyphs: { research: 'x' }, esc: String, prose: String, presentation: () => ({ label: 'Unexplored' }), ...questionHelpers, questionHelpHtml, questionResearchHtml, researchSuggestion, questionTidyHtml, nodeMenuHtml, nodeReference, optionsHtml, appendSuggestion, questionMenuHtml, questionSequence, reviewQueue, reviewStepHtml, restartPreviewHtml, importanceHtml,
    act: () => pending, toast: () => {}, FormData: class {
      constructor(form) { this.entries = form.querySelectorAll().map(field => [field.name, field.value]); }
      [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
    } });
  vm.runInContext(callbacks, context);
  const button = { disabled: false };
  const submittedFields = question ? [field('question-a', 'Submitted answer', 'answer')] : [...fields.values()];
  if (question) { fields.set('question-a', submittedFields[0]); focusDraft('question-a', 'Submitted answer'); }
  const form = { id: 'suggest-form', dataset: { nodeId: 'node-a' },
    querySelectorAll: () => submittedFields };
  if (question) { form.id = ''; form.dataset.question = 'question-a'; }
  const focusControl = spec => { controlSpecs.push(spec); const current = control(spec); controls.push(current); current.focus(); return current; };
  return { state, document, detail, button, complete, focusDraft, focusControl, render: context.renderDetail,
    clearControls: () => { controlSpecs.length = 0; }, markup: () => markup,
    writes: () => writes, submit: () => submit({ preventDefault() {}, target: form, submitter: button }) };
}

test('polling preserves an active draft control and renders deferred detail after focus leaves', () => {
  const h = harness(), field = h.document.activeElement;
  h.render();
  assert.equal(h.writes(), 0);
  assert.equal(h.document.activeElement, field);
  assert.equal(h.state.detailDeferred, true);
  h.document.activeElement = null;
  h.render();
  assert.equal(h.writes(), 1);
  assert.equal(h.state.detailDeferred, false);
});

test('selection and history changes bypass draft rendering deferral', () => {
  for (const change of [h => { h.state.selected = 'node-b'; }, h => { h.state.historyStep = 0; }]) {
    const h = harness();
    change(h); h.render();
    assert.equal(h.writes(), 1);
    assert.equal(h.state.detailDeferred, false);
    assert.equal(h.detail.dataset.history, String(h.state.historyStep !== null));
  }
});

test('a successful submission clears its drafts and forces detail cleanup on the same node', async () => {
  const h = harness(), saving = h.submit();
  assert.equal(h.button.disabled, true);
  h.complete(true); await saving;
  assert.equal(h.state.drafts['node-a-title'], undefined);
  assert.equal(h.state.drafts['node-a-branch'], undefined);
  assert.equal(h.writes(), 1);
  assert.equal(h.button.disabled, false);
});

test('a pending submission cannot replace the active draft after node or map navigation', async () => {
  for (const differentMap of [false, true]) {
    const h = harness(), saving = h.submit();
    // Keeping the same selected ID across maps independently exercises the map guard.
    if (differentMap) h.state.map = { id: 'map-b' };
    else h.state.selected = 'node-b';
    h.detail.dataset.nodeId = h.state.selected;
    const key = `${h.state.selected}-revision`, field = h.focusDraft(key, 'New unsaved draft');
    h.complete(true); await saving;
    assert.equal(h.writes(), 0);
    assert.equal(h.document.activeElement, field);
    assert.equal(h.state.drafts[key], 'New unsaved draft');
    assert.equal(h.button.disabled, false);
  }
});

test('a pending submission can finish after navigation to the welcome screen', async () => {
  const h = harness(), saving = h.submit();
  h.state.map = null; h.state.visibleMap = null; h.state.selected = null;
  h.document.activeElement = null;
  h.complete(true); await saving;
  assert.equal(h.writes(), 0);
  assert.equal(h.state.drafts['node-a-title'], undefined);
  assert.equal(h.button.disabled, false);
});

test('failed submissions keep the active draft and do not force rendering', async () => {
  const h = harness(), field = h.document.activeElement, saving = h.submit();
  h.complete(false); await saving;
  assert.equal(h.writes(), 0);
  assert.equal(h.document.activeElement, field);
  assert.equal(h.state.drafts['node-a-title'], 'Submitted title');
  assert.equal(h.button.disabled, false);
});

test('edits made while a save is pending remain in their original focused control', async () => {
  const h = harness(), saving = h.submit();
  const current = h.focusDraft('node-a-title', 'A newer direction');
  h.complete(true); await saving;
  assert.equal(h.state.drafts['node-a-title'], 'A newer direction');
  assert.equal(h.state.drafts['node-a-branch'], undefined);
  assert.equal(h.document.activeElement, current);
  assert.equal(h.writes(), 0);
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /value="A newer direction"/);
});

test('finishing one form does not replace an active draft in another form on the same node', async () => {
  const h = harness(), saving = h.submit();
  const current = h.focusDraft('node-a-revision', 'A newly changed premise');
  h.complete(true); await saving;
  assert.equal(h.state.drafts['node-a-title'], undefined);
  assert.equal(h.state.drafts['node-a-revision'], 'A newly changed premise');
  assert.equal(h.document.activeElement, current);
  assert.equal(h.writes(), 0);
});

test('an answer cannot be edited while saving and becomes editable again on failure', async () => {
  const h = harness({ question: true }), current = h.document.activeElement, saving = h.submit();
  assert.equal(current.readOnly, true);
  h.complete(false); await saving;
  assert.equal(current.readOnly, false);
  assert.equal(h.state.drafts['question-a'], 'Submitted answer');
});

test('refresh restores keyboard focus to the same detail action, submit button, summary, or source', () => {
  const specs = [
    { tagName: 'BUTTON', dataset: { explore: 'node-a' } },
    { tagName: 'BUTTON', form: { id: 'suggest-form', dataset: {} } },
    { tagName: 'SUMMARY', editor: { dataset: { editor: 'suggest' } } },
    { tagName: 'A', href: 'https://example.test/evidence' },
  ];
  for (const spec of specs) {
    const h = harness(); h.render();
    const before = h.focusControl(spec);
    h.render();
    assert.equal(h.writes(), 1);
    assert.notEqual(h.document.activeElement, before, 'The refreshed DOM uses a new control.');
    assert.equal(h.document.activeElement?.tagName, spec.tagName);
    assert.deepEqual(h.document.activeElement?.dataset, spec.dataset || {});
    assert.equal(h.state.detailDeferred, false);
  }
});

test('a removed detail action returns keyboard focus to its panel, not an unrelated action', () => {
  const h = harness();
  h.focusControl({ tagName: 'BUTTON', dataset: { accept: 'node-a' } });
  h.clearControls(); h.render();
  assert.equal(h.document.activeElement, h.detail);
  assert.equal(h.detail.tabIndex, -1);
});

test('superseded questions stay readable without an answer control', () => {
  const h = harness();
  h.state.visibleMap.nodes[0].status = 'interrupted';
  h.state.visibleMap.nodes[0].questions = [{ id: 'old-question', text: 'The earlier question', answer: null, supersededAt: '2026-10-29T12:00:00Z' }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /The earlier question/);
  assert.match(h.markup(), /Superseded by a changed premise; no answer is needed/);
  assert.doesNotMatch(h.markup(), /data-question="old-question"|data-draft="old-question"/);
  h.state.visibleMap.nodes[0].questions[0].answer = 'The original user answer';
  h.render();
  assert.match(h.markup(), /Answer from an earlier premise/);
  assert.match(h.markup(), /The original user answer/);
  assert.doesNotMatch(h.markup(), /data-question="old-question"|data-draft="old-question"/);
});

test('the inspector says who answered and who accepted, and nothing for unattributed records', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'explored'; node.completed = true; node.reviewState = 'accepted'; node.acceptedBy = { name: 'Ana' };
  node.questions = [{ id: 'q-1', text: 'Who decides?', answer: 'The owner.', answeredAt: '2026-11-03T10:00:00Z', answeredBy: { name: 'Ana' } },
    { id: 'q-2', text: 'When?', answer: 'Soon.', answeredAt: '2026-11-04T10:00:00Z' }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /Answered by Ana · /);
  assert.equal(h.markup().match(/Answered by/g).length, 1);
  assert.match(h.markup(), /Accepted by Ana/);
  node.acceptedBy = 'user'; h.render();
  assert.doesNotMatch(h.markup(), /Accepted by/);
});

test('the inspector reports the branch investigation, not later helper work on the same idea', () => {
  const h = harness();
  h.state.visibleMap.nodes[0].status = 'interrupted';
  h.state.visibleMap.jobs = [
    { id: 'job-a', nodeId: 'node-a', status: 'failed', error: 'The investigation could not reach its sources.' },
    { id: 'job-b', type: 'question-help', nodeId: 'node-a', status: 'failed', error: 'Help was not available.' },
    { id: 'job-c', type: 'map-check', nodeId: null, status: 'queued' },
  ];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /could not reach its sources/);
  assert.doesNotMatch(h.markup(), /Help was not available/);
});

test('queued branches promise pickup only when a listener covers their map', () => {
  const cases = [
    [{ listening: true }, true],
    [{ listening: true, scopes: [{ mapId: 'map-b', listening: true }] }, false],
    [{ listening: true, scopes: [{ mapId: 'map-a', listening: true }] }, true],
    [{ listening: true, scopes: [{ mapId: null, listening: true }] }, true],
    [{ listening: false, scopes: [{ mapId: 'map-a', listening: true }] }, false],
  ];
  for (const [bridge, connected] of cases) {
    const h = harness(); h.state.bridge = bridge;
    h.state.visibleMap.nodes[0].status = 'queued';
    h.document.activeElement = null; h.render();
    assert.equal(h.markup().includes('Your agent will pick up this branch next.'), connected);
    assert.equal(h.markup().includes('Saved in the queue. Connect your agent to start this investigation.'), !connected);
  }
});

test('agent coverage changes refresh queued guidance even without a map revision', async () => {
  for (const [before, after, expectedRenders] of [[false, true, 1], [true, false, 1], [false, false, 0]]) {
    const bridge = covered => ({ listening: true, scopes: [{ mapId: covered ? 'map-a' : 'map-b', listening: true }] });
    const state = { map: { id: 'map-a', revision: 2 }, bridge: bridge(before) };
    let renders = 0;
    const context = vm.createContext({ state, document: { hidden: false }, openVersion: 0, gesture: null, ...viewHelpers, alerts: { notice() {} },
      api: async () => ({ maps: [{ id: 'map-a', revision: 2 }], bridge: bridge(after) }),
      renderRail() {}, connectionView() {}, renderDetail() { renders++; } });
    vm.runInContext(between('function agentListening(', '\nfunction connectionView(') + '\n' + between('function refresh(', '\nfunction layout('), context);
    await context.refresh();
    assert.equal(renders, expectedRenders);
  }
});

function refreshHarness({ listed, fetched, mutateDuringFetch = false }) {
  const state = { map: { id: 'map-a', revision: 5, fingerprint: 'f1', title: 'Shown' }, bridge: {}, mutations: 0, outsideSeen: {} };
  const events = { renders: 0, toasts: [], welcome: 0, noticed: [] };
  const context = vm.createContext({ state, document: { hidden: false }, openVersion: 0, gesture: null, ...viewHelpers, alerts: { notice: (before, after) => events.noticed.push([before.title, after.title]) },
    api: async route => {
      if (route === '/maps') return { maps: listed ? [listed] : [], bridge: {} };
      if (mutateDuringFetch) state.mutations++;
      return fetched;
    },
    renderRail() {}, connectionView() {}, renderDetail() {}, renderMap() { events.renders++; },
    toast(message) { events.toasts.push(message); }, showWelcome() { events.welcome++; state.map = null; } });
  vm.runInContext(between('function agentListening(', '\nfunction connectionView(') + '\n' + between('function refresh(', '\nfunction layout('), context);
  return { state, events, refresh: context.refresh };
}

test('a pull with the same or an older revision replaces the shown map and says so once', async () => {
  for (const revision of [5, 3]) {
    const pulled = { id: 'map-a', revision, fingerprint: 'f2', title: 'Pulled', outsideChange: { at: 't1', preserved: null } };
    const h = refreshHarness({ listed: { id: 'map-a', revision, fingerprint: 'f2' }, fetched: pulled });
    await h.refresh();
    assert.equal(h.state.map.title, 'Pulled', `revision ${revision}`);
    assert.equal(h.events.renders, 1);
    assert.deepEqual(h.events.toasts, ['Updated from a change outside Explore, for example a pull.']);
    await h.refresh();
    assert.equal(h.events.toasts.length, 1, 'the note appears once');
  }
});

test('a fetched map never replaces a save made in this tab meanwhile', async () => {
  const h = refreshHarness({ listed: { id: 'map-a', revision: 5, fingerprint: 'f2' }, fetched: { id: 'map-a', revision: 5, fingerprint: 'f2', title: 'Older' }, mutateDuringFetch: true });
  await h.refresh();
  assert.equal(h.state.map.title, 'Shown'); assert.equal(h.events.renders, 0);
});

test('a removed or unreadable open map is explained instead of reported as a lost connection', async () => {
  let h = refreshHarness({ listed: null });
  await h.refresh();
  assert.equal(h.events.welcome, 1); assert.match(h.events.toasts[0], /no longer in the workspace/);
  h = refreshHarness({ listed: { id: 'map-a', unreadable: true, problem: 'conflict-markers' } });
  await h.refresh();
  assert.equal(h.events.welcome, 1); assert.match(h.events.toasts[0], /unresolved Git conflict/);
});

function createHarness() {
  const requests = [], opened = [], messages = [];
  let submit, resets = 0, refreshes = 0;
  const button = { disabled: false }, error = { textContent: '' };
  const idea = { value: 'Submitted idea', focus() {} }, title = { value: 'Submitted title' };
  const dialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
  const form = { querySelector: () => button, reset() { resets++; idea.value = ''; title.value = ''; },
    addEventListener(event, callback) { if (event === 'submit') submit = callback; } };
  const elements = { '#create-form': form, '#create-dialog': dialog, '#create-error': error, '#idea': idea, '#title': title };
  const context = vm.createContext({ $: selector => elements[selector], openVersion: 0,
    api: async () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    refresh: async () => { refreshes++; }, openMap: async id => { opened.push(id); context.openVersion++; },
    toast: message => messages.push(message), FormData: class {
      constructor() { this.values = { idea: idea.value, title: title.value }; }
      get(key) { return this.values[key]; }
    } });
  vm.runInContext('let createVersion = 0;\n' + between('function showCreate(', '\nfunction showWelcome(') + '\n' +
    between("$('#create-form').addEventListener('submit'", "\n$('#open-example')"), context);
  context.showCreate();
  return { dialog, idea, title, error, button, requests, opened, messages, open: context.showCreate,
    resets: () => resets, refreshes: () => refreshes, navigate: () => { context.openVersion++; },
    submit: () => submit({ preventDefault() {}, target: form, submitter: button }) };
}

test('creating an unchanged exploration closes the dialog and opens the saved map', async () => {
  const h = createHarness(), saving = h.submit();
  h.requests[0].resolve({ id: 'created-a', title: 'Submitted title' }); await saving;
  assert.equal(h.dialog.open, false);
  assert.equal(h.resets(), 1);
  assert.deepEqual(h.opened, ['created-a']);
  assert.equal(h.refreshes(), 1);
  assert.equal(h.button.disabled, false);
});

test('a delayed creation preserves an edited or reopened dialog without changing navigation', async () => {
  for (const change of [h => { h.idea.value = 'Newer idea'; }, h => { h.dialog.close(); h.open(); }, h => { h.dialog.close(); h.open(); h.idea.value = 'Newer idea'; }]) {
    const h = createHarness(), saving = h.submit();
    change(h); const newerIdea = h.idea.value;
    h.requests[0].resolve({ id: 'created-a', title: 'Submitted title' }); await saving;
    assert.equal(h.dialog.open, true);
    assert.equal(h.idea.value, newerIdea);
    assert.equal(h.resets(), 0);
    assert.deepEqual(h.opened, []);
    assert.equal(h.refreshes(), 1, 'The saved exploration still refreshes the map list.');
    assert.equal(h.button.disabled, false);
    assert.match(h.messages.at(-1), /saved/);
  }
});

test('closing creation or navigating while it saves prevents a later navigation takeover', async () => {
  for (const change of [h => h.dialog.close(), h => h.navigate()]) {
    const h = createHarness(), saving = h.submit();
    change(h);
    h.requests[0].resolve({ id: 'created-a', title: 'Submitted title' }); await saving;
    assert.deepEqual(h.opened, []);
    assert.equal(h.resets(), 0);
    assert.equal(h.refreshes(), 1);
  }
});

test('an older creation cannot enable a newer pending submission', async () => {
  const h = createHarness(), earlier = h.submit();
  h.dialog.close(); h.open(); h.idea.value = 'Newer idea';
  assert.equal(h.button.disabled, false);
  const newer = h.submit();
  h.requests[0].resolve({ id: 'created-a', title: 'Submitted title' }); await earlier;
  assert.equal(h.button.disabled, true);
  assert.equal(h.dialog.open, true);
  h.requests[1].resolve({ id: 'created-b', title: 'Newer title' }); await newer;
  assert.deepEqual(h.opened, ['created-b']);
  assert.equal(h.button.disabled, false);
});

test('creation errors attach only to the unchanged submitted dialog', async () => {
  for (const newerDraft of [false, true]) {
    const h = createHarness(), saving = h.submit();
    if (newerDraft) { h.dialog.close(); h.open(); h.idea.value = 'Newer idea'; }
    h.requests[0].reject(new Error('Disk unavailable')); await saving;
    assert.equal(h.error.textContent, newerDraft ? '' : 'Disk unavailable');
    assert.equal(h.dialog.open, true);
    assert.equal(h.resets(), 0);
    assert.equal(h.button.disabled, false);
    if (newerDraft) assert.match(h.messages.at(-1), /Disk unavailable/);
  }
});

test('a map list that was requested before another map opened never closes the new map', async () => {
  const state = { map: { id: 'map-a', revision: 5, fingerprint: 'f1' }, bridge: {}, mutations: 0, outsideSeen: {} };
  const events = { welcome: 0, toasts: [] };
  const context = vm.createContext({ state, document: { hidden: false }, openVersion: 0, gesture: null, ...viewHelpers, alerts: { notice() {} },
    api: async () => {
      // While this list is in flight the user creates and opens a new map.
      context.openVersion++; state.map = { id: 'map-new', revision: 1, fingerprint: 'f9' };
      return { maps: [{ id: 'map-a', revision: 5, fingerprint: 'f1' }], bridge: {} };
    },
    renderRail() {}, connectionView() {}, renderDetail() {}, renderMap() {},
    toast(message) { events.toasts.push(message); }, showWelcome() { events.welcome++; } });
  vm.runInContext(between('function agentListening(', '\nfunction connectionView(') + '\n' + between('function refresh(', '\nfunction layout('), context);
  await context.refresh();
  assert.equal(events.welcome, 0); assert.deepEqual(events.toasts, []);
});

test('after an edit is refused because of a pull, the pull is not announced again later', async () => {
  const state = { map: { id: 'map-a', revision: 5, fingerprint: 'f1' }, historyStep: null, mutations: 0, outsideSeen: {} };
  const toasts = [];
  const context = vm.createContext({ state, actionTail: Promise.resolve(), ...viewHelpers, alerts: { notice() {} },
    api: async route => {
      if (route.endsWith('/action')) throw new Error('This map changed outside Explore, for example after a pull.');
      return { id: 'map-a', revision: 5, fingerprint: 'f2', outsideChange: { at: 't1', preserved: null } };
    },
    renderMap() {}, connectionView() {}, toast(message) { toasts.push(message); } });
  vm.runInContext(between('function act(', '\nlet createVersion'), context);
  assert.equal(await context.act('node-a', 'suggest', { title: 'Mine' }), false);
  assert.equal(state.map.fingerprint, 'f2');
  assert.equal(state.outsideSeen['map-a'], 't1');
  assert.equal(toasts.length, 1);
});

test('the versions panel offers undo in plain words, then a clear summary before restoring', () => {
  const panel = { hidden: true, innerHTML: '' }, toggle = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { map: { id: 'map-a' }, versionsOpen: true, contributor: 'Ana', versionChoice: null, versionPreview: null,
    versions: { versions: [{ id: 'v3', at: '2026-11-27T10:03:00Z', labels: ['result'] }, { id: 'v2', at: '2026-11-27T10:02:00Z', labels: ['answered'], author: 'Ana <b>' }, { id: 'v1', at: '2026-11-27T10:01:00Z', labels: ['activated'] }], earlierMissing: false } };
  state.contributor = 'Ana <b>';
  const context = vm.createContext({ state, esc, ...viewHelpers, alerts: { notice() {} }, $: selector => selector === '#versions-panel' ? panel : toggle });
  vm.runInContext(between('function renderVersionsPanel(', '\nasync function loadVersions('), context);
  context.renderVersionsPanel();
  assert.equal(panel.hidden, false); assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.match(panel.innerHTML, /Undo last change: Answer saved/);
  assert.match(panel.innerHTML, /data-version="v3"/); assert.match(panel.innerHTML, /Agent result/);
  assert.match(panel.innerHTML, /Ana &lt;b&gt;/); assert.doesNotMatch(panel.innerHTML, /Ana <b>/, 'names are literal text');
  assert.doesNotMatch(panel.innerHTML, /\banswered\b|\bactivated\b/, 'internal event names never show');
  state.versionChoice = { version: state.versions.versions[2], counts: { nodesAdded: 0, nodesRemoved: 1, nodesChanged: 1, linksAdded: 0, linksRemoved: 1 }, reopened: [],
    undo: { target: state.versions.versions[2], undoing: state.versions.versions[1], alsoUndone: [state.versions.versions[0]] } };
  context.renderVersionsPanel();
  assert.match(panel.innerHTML, /Undo “Answer saved”/);
  assert.match(panel.innerHTML, /removes 1 idea/); assert.match(panel.innerHTML, /also undoes a newer change/);
  assert.match(panel.innerHTML, /data-version-restore>Undo</);
  state.versionChoice = { ...state.versionChoice, undo: null };
  context.renderVersionsPanel();
  assert.match(panel.innerHTML, /Restore this version/); assert.match(panel.innerHTML, /Name this version/);
  state.versionsOpen = false; context.renderVersionsPanel();
  assert.equal(panel.hidden, true);
});

test('answers show how sure they are, open questions can wait, and waiting ones collapse', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [
    { id: 'q-decided', text: 'Who decides?', answer: 'The owner.', answerState: 'decided' },
    { id: 'q-old', text: 'Older one?', answer: 'Before certainty existed.' },
    { id: 'q-open', text: 'What budget?', answer: null },
    { id: 'q-later', text: 'Which venue?', answer: null, deferredAt: '2026-11-27T10:00:00Z' },
  ];
  h.document.activeElement = null; h.render();
  const markup = h.markup();
  assert.match(markup, /data-certainty="q-decided"[^>]*>.*<option value="decided" selected>Decided<\/option>/s);
  assert.match(markup, /data-certainty="q-old"[^>]*title="Certainty not recorded"/);
  assert.match(markup, /data-answer-later="q-open"/);
  assert.doesNotMatch(markup, /data-answer-later="q-later"/);
  assert.match(markup, /<details class="saved-for-later"><summary>Saved for later \(1\)<\/summary>.*data-question="q-later"/s);
  node.status = 'explored'; node.completed = true; h.render();
  assert.doesNotMatch(h.markup(), /data-answer-later/);
  assert.match(h.markup(), /data-certainty="q-decided"/, 'certainty can still be set on a finished branch');
});

test('an open question offers each option’s suggested answer as a starting point', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.options = [{ id: 'hands-on', title: 'Hands-on', description: 'd', fit: 'f', pros: [], cons: [], suggestedAnswer: 'I would start hands-on.' },
    { id: 'talk', title: 'Discussion', description: 'd', fit: 'f', pros: [], cons: [] }];
  node.recommendation = { optionId: null, missing: 'Budget.' };
  node.questions = [{ id: 'q-format', text: 'Which format?', answer: null }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /Start from a suggested answer/);
  assert.match(h.markup(), /data-suggest-answer="hands-on" data-question-id="q-format"/);
  assert.doesNotMatch(h.markup(), /data-suggest-answer="talk"/, 'only options with a draft are offered');
  assert.match(h.markup(), /No recommendation yet/);
});

test('each question has one ⋯ menu; dismissed ones collapse and a regenerating one shows its placeholder', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [
    { id: 'q-open', text: 'Budget?', answer: null },
    { id: 'q-done', text: 'Audience?', answer: 'Everyone.', answerState: 'decided', rating: 'good' },
    { id: 'q-gone', text: 'Leading one?', answer: null, dismissedAt: 't', ratingReason: 'Leading.' },
    { id: 'q-new', text: 'Vague one?', answer: null, dismissedAt: 't', replacedBy: 'pending' },
  ];
  h.document.activeElement = null; h.render();
  const markup = h.markup();
  assert.equal(markup.match(/aria-label="More for this question">/g).length, 2, 'the open and the answered question each have one menu');
  assert.match(markup, /data-menu="q-open"/); assert.match(markup, />Dismiss</, 'a regeneration is still pending, so dismissing does not continue the branch yet');
  assert.doesNotMatch(markup, /class="text-button" data-answer-later/, 'Answer later lives in the menu now');
  assert.match(markup, /You rated this a good question/);
  assert.match(markup, /<summary>Dismissed \(1\)<\/summary>.*Leading one\?.*data-q-restore/s);
  assert.match(markup, /Getting a new question…/); assert.match(markup, /Queued for your agent/);
});

test('questions come one at a time with a counter, earlier answers collapse, and Show all lists the batch', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [
    { id: 'q1', text: 'One?', answer: 'Done.', jobId: 'job-2' },
    { id: 'q2', text: 'Two?', answer: null, jobId: 'job-2' },
    { id: 'q3', text: 'Three?', answer: null, jobId: 'job-2' },
  ];
  h.document.activeElement = null; h.render();
  let markup = h.markup();
  assert.match(markup, /aria-live="polite"[^>]*>Question 2 of 3</);
  assert.match(markup, /data-question="q2"/); assert.doesNotMatch(markup, /data-question="q3"/, 'only the current question');
  assert.match(markup, /<summary>Your answers \(1\)<\/summary>/);
  assert.match(markup, /data-show-all-questions/); assert.match(markup, />Save</); assert.doesNotMatch(markup, /Save answer &amp; continue|Save answer & continue/);
  h.state.showAllQuestions = true; h.render();
  markup = h.markup();
  assert.match(markup, /data-question="q2"/); assert.match(markup, /data-question="q3"/); assert.match(markup, /data-show-one-question/);
  h.state.showAllQuestions = false; h.state.pendingAnswers = { q2: 'Saving…' }; h.render();
  assert.match(h.markup(), /Question 3 of 3/, 'a saved answer shows the next question before the server replies');
  assert.match(h.markup(), /data-question="q3"/);
});

test('a saved answer can be changed in place, and on a finished branch it explores beside the original', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [{ id: 'q-a', text: 'Budget?', answer: 'Forty pounds.', answerState: 'tentative', previousAnswers: [{ answer: 'Ten pounds.', replacedAt: '2026-11-20T10:00:00Z' }] }, { id: 'q-b', text: 'When?', answer: null }];
  h.document.activeElement = null; h.render();
  let markup = h.markup();
  assert.match(markup, /data-q-change[^>]*data-question-id="q-a"/);
  assert.match(markup, /data-change-for="q-a"[^>]*hidden/);
  assert.match(markup, /data-save-change="change"[^>]*>Save</); assert.match(markup, /data-save-wording[^>]*>Save without re-running</);
  assert.match(markup, /Earlier answer/);
  node.questions[0].answeredBy = { name: 'Ana' }; node.questions[0].answeredAt = '2026-11-01T10:00:00Z'; node.questions[0].changedAt = '2026-11-20T10:00:00Z'; h.render();
  assert.match(h.markup(), /Answered by Ana · (20 Nov|Nov 20)/, 'the date is when the current answer was given');
  node.status = 'explored'; node.completed = true; node.questions = [node.questions[0]]; h.render();
  markup = h.markup();
  assert.match(markup, /data-save-change="fork"[^>]*>Explore beside the original</);
  assert.doesNotMatch(markup, /data-save-wording/);
});

test('a flagged finding offers Review this, and reviewing shows the step at the top of the inspector', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'explored'; node.completed = true; node.stale = true;
  node.reviewCauses = [{ sourceId: 'node-b', kind: 'premise-revised', at: '2026-11-27T10:00:00Z' }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /data-review-start="node-a"[^>]*>Review this</);
  h.state.map = { ...h.state.visibleMap, rootId: 'node-a', history: [] }; h.state.reviewing = {};
  h.render();
  assert.match(h.markup(), /^<section class="review-step"/);
  assert.match(h.markup(), /Item 1 of 1/); assert.match(h.markup(), /premise was revised/);
  assert.doesNotMatch(h.markup(), />Review this</, 'no second entry point while reviewing');
});

test('resolving a flag re-renders without ending the review, so the next flagged finding can follow', () => {
  const h = harness();
  const [first, second] = h.state.visibleMap.nodes;
  for (const node of [first, second]) { node.status = 'explored'; node.completed = true; node.stale = true; }
  h.state.map = { ...h.state.visibleMap, rootId: 'node-a', edges: [{ from: 'node-a', to: 'node-b' }], history: [] };
  h.state.reviewing = {}; h.document.activeElement = null;
  h.render();
  assert.match(h.markup(), /Item 1 of 2/);
  // The save re-renders the selected node after its flag is gone, before the walk-through moves on.
  first.stale = false; h.render();
  assert.ok(h.state.reviewing, 'review mode survives the re-render of a resolved finding');
  assert.doesNotMatch(h.markup(), /review-step/);
});

test('an open question shows its importance and a Why? link; an answered one keeps a quieter label', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [{ id: 'q-a', text: 'Offline for days?', answer: null, importance: 'high', why: 'Decides the sync design.' }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /<summary><span>High importance<\/span> · <span class="why-link">Why\?<\/span><\/summary><p>Decides the sync design\.<\/p>/);
  node.questions[0].answer = 'Yes.'; node.status = 'queued'; h.render();
  assert.match(h.markup(), /<small class="certainty-label">High importance<\/small>/);
  assert.doesNotMatch(h.markup(), /question-why/);
});

test('a finished branch offers Restart from this answer, and its preview keeps the change editor open', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'explored'; node.completed = true;
  node.questions = [{ id: 'q-a', text: 'Budget?', answer: 'Forty pounds.' }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /data-save-change="fork"[^>]*>Explore beside the original</);
  assert.match(h.markup(), /data-restart-preview[^>]*data-question-id="q-a"[^>]*>Restart from this answer</);
  assert.match(h.markup(), /data-change-for="q-a" hidden/);
  h.state.restartPreview = { nodeId: 'node-a', questionId: 'q-a', answer: 'Ten pounds.', preview: { deleteCount: 1, deleted: [{ id: 'node-b', title: 'node-b' }], nextOffset: null,
    superseded: [], flagged: [], linksRemoved: 1, checkpointName: 'Before restarting node-a, 2026-11-27' } };
  h.render();
  assert.doesNotMatch(h.markup(), /data-change-for="q-a" hidden/);
  assert.match(h.markup(), /Delete 1 idea and restart/);
  node.status = 'queued'; node.completed = false; h.render();
  assert.doesNotMatch(h.markup(), /Delete 1 idea and restart/, 'a branch that is no longer finished shows no restart preview');
  assert.match(h.markup(), /data-change-for="q-a" hidden/);
});

test('every idea has a ⋯ menu with Copy link, and a clipboard failure shows the link to copy by hand', () => {
  const h = harness();
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /data-menu="node-a"[^>]*aria-label="More for this idea"/);
  assert.match(h.markup(), /data-copy-link="node-a">Copy link</);
  h.state.linkFallbackFor = 'node-a'; h.render();
  assert.match(h.markup(), /<input id="link-fallback" readonly value="Explore idea map-a\/node-a: "node-a" \(ideas\/map-a\/nodes\/node-a\.md\)">/, 'built from today\'s title');
});

test('help from the agent shows under the question and never touches the answer or its draft', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [{ id: 'q-a', text: 'What counts as offline?', answer: null }];
  h.state.drafts['q-a'] = 'My half-typed answer';
  h.state.visibleMap.jobs = [{ id: 'job-help0001', type: 'question-help', nodeId: 'node-a', subjectId: 'q-a', status: 'completed', stale: false, result: { help: 'It means no signal at all.' } }];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /Help from your agent, not an answer<\/summary><p class="question-help-text">It means no signal at all\.<\/p>/);
  assert.match(h.markup(), /data-draft="q-a" required>My half-typed answer<\/textarea>/);
  assert.equal(h.state.drafts['q-a'], 'My half-typed answer');
});

test('research shows under an open or answered question with copy buttons, and never fills the answer', () => {
  const h = harness();
  const node = h.state.visibleMap.nodes[0];
  node.status = 'awaiting-answer';
  node.questions = [{ id: 'q-a', text: 'Which sync model?', answer: null }, { id: 'q-b', text: 'Who edits?', answer: 'Only me.', answerState: 'tentative' }];
  h.state.drafts['q-a'] = 'My half-typed answer';
  const research = (id, subjectId) => ({ id, type: 'question-research', nodeId: 'node-a', subjectId, status: 'completed', stale: false,
    result: { options: [{ id: 'crdt', title: 'Merge automatically', description: 'd', fit: 'f', pros: [], cons: [], suggestedAnswer: 'Merge it.' }], optionsLimit: 'Only one fits.', recommendation: { optionId: 'crdt', rationale: 'r', mainTradeoff: 't' }, sources: [] } });
  h.state.visibleMap.jobs = [research('job-r1', 'q-a'), research('job-r2', 'q-b')];
  h.document.activeElement = null; h.render();
  assert.match(h.markup(), /Research from your agent, not your answer/);
  assert.match(h.markup(), /data-copy-answer="crdt" data-research-job="job-r1" data-question-id="q-a">Copy to my answer/);
  assert.match(h.markup(), /data-copy-answer="crdt" data-research-job="job-r2" data-question-id="q-b">Copy to my answer/, 'answered questions of an unfinished branch show their research');
  assert.match(h.markup(), /data-q-research data-question-id="q-b"/);
  assert.match(h.markup(), /data-draft="q-a" required>My half-typed answer<\/textarea>/);
  assert.equal(node.questions[0].answer, null);
  node.status = 'explored'; node.completed = true; h.render();
  assert.doesNotMatch(h.markup(), /data-q-research data-question-id="q-b"/, 'a finished branch offers no research');
});

test('each changed snapshot of the open map reaches the alerts with the one shown before it', async () => {
  const pulled = { id: 'map-a', revision: 6, fingerprint: 'f2', title: 'Changed', outsideChange: null };
  const h = refreshHarness({ listed: { id: 'map-a', revision: 6, fingerprint: 'f2' }, fetched: pulled });
  await h.refresh();
  assert.deepEqual(h.events.noticed, [['Shown', 'Changed']]);
});
