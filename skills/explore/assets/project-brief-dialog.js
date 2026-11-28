// The Project brief dialog (G2), opened from the workspace tools: choose files, ask the agent, review the draft
// (remove, rewrite a fact as your own statement, add one), approve it, and see when its files change. It also keeps
// the files' last known state for the questions a fact prompted.
import { projectBriefHtml, projectBriefOf, PROJECT_BRIEF } from './project-brief.js';
import { controlKey, cssQuote } from './dialog-focus.js';

export function projectBriefDialog({ map, act, api, esc, toast, live, listening }) {
  const $ = selector => document.querySelector(selector), dialog = $('#project-brief-dialog'), body = $('#project-brief-body');
  const state = { editing: null, errors: [], paths: null, status: null, checked: null };
  let written = null;
  const render = () => {
    const shown = map(); if (!shown) return;
    const page = projectBriefHtml({ map: shown, esc, listening: listening(), live: live(), status: state.status, editing: state.editing, errors: state.errors, paths: state.paths });
    if (page === written) return;
    const active = document.activeElement, kept = active && body.contains?.(active) ? controlKey(active) : null;
    body.innerHTML = written = page;
    if (kept) body.querySelector(kept)?.focus();
  };
  const focus = (...selectors) => (selectors.map(selector => body.querySelector(selector)).find(Boolean) ?? $('#project-brief-title'))?.focus();
  // How the brief's files stand: asked when the map opens, when the dialog opens, after each new revision, and on Check files.
  const check = async ({ force = false } = {}) => {
    const shown = map();
    if (!shown || !shown.projectBrief) { state.status = null; state.checked = null; return; }
    const key = `${shown.id}@${shown.revision}`;
    if (!force && state.checked === key) return;
    state.checked = key;
    try { const answer = await api(`/maps/${shown.id}/project-brief`); if (state.checked === key) { state.status = answer.status; render(); } }
    catch { state.checked = null; }
  };
  const brief = () => projectBriefOf(map());
  // Saves the draft with these items kept and these statements: the one action every edit goes through.
  const update = (change, done) => {
    const { draft, approved, statements } = brief(), base = draft ?? approved;
    const keep = { facts: base.facts.map(fact => fact.id), inferences: base.inferences.map(item => item.id), unknowns: base.unknowns.map((item, i) => i), ...change.keep };
    return act(null, 'update-project-brief', { keep, statements: change.statements ?? statements.map(({ id, text }) => ({ id, text })) }).then(ok => { if (ok) done?.(); render(); return ok; });
  };
  $('#project-brief-open').addEventListener('click', () => { Object.assign(state, { editing: null, errors: [], paths: null }); written = null; render(); dialog.showModal(); focus('#project-brief-draft', '#project-brief-approved', '#project-brief-paths'); check({ force: true }); });
  body.addEventListener('input', event => { if (event.target.id === 'project-brief-paths') state.paths = event.target.value; });
  body.addEventListener('click', async event => {
    const target = event.target.closest('button'); if (!target || !live()) return;
    const data = target.dataset;
    if ('briefCheck' in data) { await check({ force: true }); focus('#project-brief-files', '[data-brief-check]'); return; }
    if ('briefAsk' in data || 'briefRefresh' in data) {
      const files = 'briefRefresh' in data ? (brief().approved?.files ?? []).map(file => file.path) : String(state.paths ?? body.querySelector('#project-brief-paths')?.value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      target.disabled = true; state.errors = [];
      const ok = await act(null, 'request-map-job', { jobType: PROJECT_BRIEF, options: { files } }, { onError: (message, error) => { state.errors = error?.errors ?? [{ path: 'Files', message }]; } });
      target.disabled = false;
      if (ok) { state.paths = null; toast(listening() ? 'Your agent will write the brief next.' : 'Queued. Connect your agent to write the brief.'); }
      render(); focus(ok ? '#project-brief-status' : '#project-brief-errors', '#project-brief-paths'); return;
    }
    if (data.projectBriefStop) { if (await act(null, 'cancel-job', { jobId: data.projectBriefStop })) toast('Stopped.'); render(); focus('#project-brief-paths'); return; }
    if (data.briefRemove) {
      const [kind, id] = data.briefRemove.split(':'), base = brief().draft;
      if (kind === 'statements') { await update({ statements: brief().statements.filter(item => item.id !== id).map(({ id: keep, text }) => ({ id: keep, text })) }); focus('#project-brief-draft'); return; }
      const list = kind === 'unknowns' ? base.unknowns.map((item, i) => i).filter(i => String(i) !== id) : base[kind].map(item => item.id).filter(entry => entry !== id);
      await update({ keep: { [kind]: list } }); focus('#project-brief-draft'); return;
    }
    if (data.briefEdit) { state.editing = data.briefEdit; render(); focus('[data-brief-text]'); return; }
    if ('briefCancel' in data) { const id = state.editing; state.editing = null; render(); focus(`[data-brief-edit="${cssQuote(id)}"]`, '#project-brief-draft'); return; }
    if (data.briefSave) {
      const id = data.briefSave, text = body.querySelector('[data-brief-text]')?.value ?? '', current = brief(), isStatement = current.statements.some(item => item.id === id);
      const statements = current.statements.map(item => ({ id: item.id, text: item.id === id ? text : item.text }));
      // A rewritten fact becomes the user's statement, with no file; the fact itself goes.
      await update(isStatement ? { statements } : { keep: { facts: current.draft.facts.map(fact => fact.id).filter(fact => fact !== id) }, statements: [...statements, { text }] }, () => { state.editing = null; });
      focus('#project-brief-draft'); return;
    }
    if ('briefAdd' in data) {
      const field = body.querySelector('#brief-statement'), text = field?.value ?? '';
      await update({ statements: [...brief().statements.map(({ id, text: kept }) => ({ id, text: kept })), { text }] }); focus('#brief-statement'); return;
    }
    if ('briefStartEdit' in data) { if (await update({})) toast('The approved brief is copied into a draft. It stays in use until you approve the draft.'); focus('#project-brief-draft'); return; }
    if ('briefApprove' in data) { if (await act(null, 'approve-project-brief', {})) toast('Approved. Investigations receive this brief from now on.'); render(); focus('#project-brief-approved'); return; }
    if ('briefDiscard' in data) { if (await act(null, 'cancel-project-brief', {})) toast('Draft discarded.'); render(); focus('#project-brief-approved', '#project-brief-paths'); return; }
    if ('briefClear' in data) { if (await act(null, 'clear-project-brief', {})) toast('Brief cleared.'); state.status = null; render(); focus('#project-brief-paths'); }
  });
  return {
    // A poll never redraws away a statement or paths being typed.
    mapChanged() { check(); if (dialog.open && !body.contains?.(document.activeElement?.closest?.('textarea') ?? null)) render(); },
    status: () => state.status,
  };
}
