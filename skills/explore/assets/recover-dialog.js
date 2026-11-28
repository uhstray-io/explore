import { versionLabel, unreadableReason as reason } from './workspace-view.js';
import { exportAs } from './export-formats.js';

// Recovery (J2): a map's saved versions, each checked by the live map's rules, with a read-only preview and
// "Copy as a new map". The map's own folder is never changed, even when its map.json cannot be opened.
const when = at => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function recoverHtml({ problem, versions, unusable = [] }, { esc }) {
  const intro = `<p class="form-note">${problem ? `This map’s file cannot be opened: ${esc(reason(problem))}. ` : ''}Its saved versions are below. Preview one, or copy it out as a new, separate map. This map’s own files are never changed.</p>`;
  if (!versions.length && !unusable.length) return `${intro}<p class="form-note">This map has no saved versions to recover from. Earlier ones may be in Git history.</p>`;
  const item = version => `<li><strong>${esc(versionLabel(version))} · revision ${esc(version.revision)}</strong><small>${esc([when(version.at), version.author, version.name ? 'named' : ''].filter(Boolean).join(' · '))}</small>`
    + (version.problem ? `<small class="recover-problem">Cannot be used: ${esc(reason(version.problem))}</small>`
      : `<span class="recover-actions"><button type="button" class="secondary" data-recover-preview="${esc(version.id)}">Preview</button><button type="button" class="secondary" data-recover-copy="${esc(version.id)}">Copy as a new map</button></span>`) + '</li>';
  const broken = entry => `<li><strong>A damaged version file</strong><small class="recover-problem">Cannot be used: ${esc(reason(entry.problem))}</small></li>`;
  return `${intro}<ul class="recover-list">${versions.map(item).join('')}${unusable.map(broken).join('')}</ul><div class="recover-preview" hidden></div>`;
}

// The dialog in the page. `openMap(id)` opens the copy; `refresh()` brings it into the rail.
export function recoverDialog({ api, esc, openMap, refresh }) {
  const $ = selector => document.querySelector(selector), dialog = $('#recover-dialog'), body = $('#recover-body'), status = $('#recover-status');
  let current = null;
  async function open({ id, title, problem }) {
    current = id; status.textContent = ''; $('#recover-title').textContent = `Recover a version of ${title || id}`;
    body.innerHTML = '<p class="form-note">Loading versions…</p>'; dialog.showModal();
    try { const list = await api(`/maps/${id}/versions`); if (current === id) body.innerHTML = recoverHtml({ problem, ...list }, { esc }); }
    catch (error) { if (current === id) body.innerHTML = `<p class="form-note">${esc(error.message)}</p>`; }
  }
  body.addEventListener('click', async event => {
    const button = event.target.closest('[data-recover-preview], [data-recover-copy], [data-recover-open]'); if (!button || !current) return;
    const mapId = current;
    if (button.dataset.recoverOpen) { dialog.close(); openMap(button.dataset.recoverOpen); return; }
    if (button.dataset.recoverPreview) {
      // Read-only: a picture of the version, made like an SVG export, and nothing that can act.
      status.textContent = '';
      try {
        const preview = await api(`/maps/${mapId}/versions/${encodeURIComponent(button.dataset.recoverPreview)}`), box = body.querySelector('.recover-preview');
        if (current !== mapId || !box) return; // Another map's recovery opened meanwhile.
        box.innerHTML = `<p class="form-note">${esc(versionLabel(preview.version))}, revision ${esc(preview.version.revision)}: ${preview.map.nodes.length} ${preview.map.nodes.length === 1 ? 'idea' : 'ideas'}, read-only.</p>${exportAs(preview.map, 'svg').text}`;
        box.hidden = false; box.scrollIntoView({ block: 'nearest' });
      } catch (error) { status.textContent = error.message; }
      return;
    }
    button.disabled = true;
    try {
      const { recovered } = await api('/recover-copy', { mapId, version: button.dataset.recoverCopy });
      await refresh();
      if (current !== mapId) return;
      status.innerHTML = `Copied as a new map. <button type="button" class="text-button" data-recover-open="${esc(recovered)}">Open the copy</button>`;
      status.querySelector('[data-recover-open]').focus(); // The Copy button is disabled; keep the keyboard nearby.
    } catch (error) { status.textContent = error.message; }
    button.disabled = false;
  });
  status.addEventListener('click', event => { const button = event.target.closest('[data-recover-open]'); if (button) { dialog.close(); openMap(button.dataset.recoverOpen); } });
  return open;
}
