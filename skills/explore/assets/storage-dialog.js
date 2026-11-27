// The Storage dialog (J5): what each map and its history take, and a cleanup of old unnamed versions that is
// always previewed first. Nothing is removed until the user confirms the listed versions.
const kilobytes = bytes => bytes === null ? 'unknown' : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export function storageDialog({ api, esc, titleOf }) {
  const $ = selector => document.querySelector(selector), dialog = $('#storage-dialog'), status = $('#storage-status');
  let preview = null;
  async function load() {
    const report = await api('/storage');
    $('#storage-list').innerHTML = `<table class="storage-table"><thead><tr><th>Map</th><th>Map file</th><th>Markdown</th><th>History</th></tr></thead><tbody>${report.maps.map(map => `<tr><td>${esc(titleOf(map.id))}</td><td>${kilobytes(map.mapBytes)}</td><td>${kilobytes(map.markdownBytes)}</td><td>${kilobytes(map.versions.bytes)} · ${map.versions.count ?? '?'} versions${map.versions.named ? `, ${map.versions.named} named` : ''}</td></tr>`).join('')}</tbody></table><p class="form-note">All maps: ${kilobytes(report.totals.bytes)}. In .explore/: ${report.runtime.claims.count ?? '?'} claim files (${kilobytes(report.runtime.claims.bytes)}) and a usage log of ${kilobytes(report.runtime.usageLogBytes)}, which this never removes.</p>`;
  }
  $('#storage-preview').addEventListener('click', async () => {
    try {
      preview = await api('/storage/preview', { keepNewest: Number($('#storage-keep').value) });
      $('#storage-candidates').innerHTML = preview.candidates.length
        ? `<p>${preview.candidates.length} older versions, ${kilobytes(preview.bytes)} in all:</p><ul class="storage-candidates">${preview.candidates.map(c => `<li>${esc(titleOf(c.mapId))} · revision ${c.revision} · ${esc(new Date(c.at).toLocaleString())} · ${kilobytes(c.bytes)}</li>`).join('')}</ul><p class="form-note">Removed versions leave this folder and Explore stops listing them; copies already committed stay in Git history.</p><button type="button" id="storage-clean" class="primary">Remove these versions</button>`
        : '<p class="form-note">Nothing to remove: every version is within what you keep.</p>';
      status.textContent = '';
    } catch (error) { status.textContent = error.message; }
  });
  $('#storage-candidates').addEventListener('click', async event => {
    if (!event.target.closest('#storage-clean') || !preview) return;
    try {
      const { outcomes } = await api('/storage/clean', { previewId: preview.id }); preview = null;
      const removed = outcomes.filter(o => o.outcome === 'removed').length, skipped = outcomes.filter(o => o.outcome !== 'removed');
      status.textContent = `Removed ${removed} versions.${skipped.length ? ` Kept ${skipped.length}: ${[...new Set(skipped.map(o => o.reason))].join(' ')}` : ''}`;
      $('#storage-candidates').innerHTML = ''; await load();
    } catch (error) { status.textContent = error.message; preview = null; $('#storage-candidates').innerHTML = ''; }
  });
  return async function show() { status.textContent = ''; preview = null; $('#storage-candidates').innerHTML = ''; dialog.showModal(); try { await load(); } catch (error) { status.textContent = error.message; } };
}
