// Restore one branch (E2) from the version preview's inspector: preview exactly what changes, then confirm.
// Nothing is written until Confirm, and Confirm stays disabled while anything blocks the restore.
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const changeWords = { changed: 'changed back', 're-added': 'brought back', removed: 'removed' };

export function branchRestoreHtml(preview, { esc }) {
  const { counts, conflicts } = preview, titles = list => list.map(item => esc(item.title)).join(', ');
  const lines = [
    counts.changed && `${count(counts.changed, 'idea')} changed back to this version`,
    counts.readded && `${count(counts.readded, 'idea')} deleted since brought back`,
    counts.removed && `${count(counts.removed, 'idea')} added since this version removed`,
    (counts.linksAdded || counts.linksRemoved) && `${count(counts.linksAdded, 'connection')} added, ${counts.linksRemoved} removed`,
  ].filter(Boolean);
  return `<section class="branch-restore" aria-label="Restore this branch"><h3>Restore “${esc(preview.node.title)}” and everything below it</h3>`
    + (conflicts.length ? `<div class="state-note warning" role="alert">${conflicts.map(entry => `<p>${esc(entry.message)}${entry.nodes.length ? ` <small>${titles(entry.nodes)}</small>` : ''}</p>`).join('')}</div>` : '')
    + `<ul class="branch-restore-counts">${lines.map(line => `<li>${line}</li>`).join('') || '<li>Nothing in this branch changes.</li>'}</ul>`
    + (preview.nodes.length ? `<ul class="branch-restore-list">${preview.nodes.map(item => `<li><strong>${esc(item.title)}</strong> <small>${changeWords[item.change]}</small></li>`).join('')}</ul>` : '')
    + (preview.nextOffset !== null ? `<button type="button" class="text-button" data-branch-more="${preview.nextOffset}">Show more</button>` : '')
    + (preview.reopened.length ? `<p class="form-note">Finished, now unfinished again: ${titles(preview.reopened)}.</p>` : '')
    + (preview.flaggedInside.length ? `<p class="form-note">Flagged for review, because what they relied on changed since: ${titles(preview.flaggedInside)}.</p>` : '')
    + (preview.flagged.length ? `<p class="form-note">Outside the branch, flagged for review: ${titles(preview.flagged)}.</p>` : '')
    + '<p class="form-note">The rest of the map stays as it is now. No research starts, and you can undo this from Versions.</p>'
    + `<div class="version-actions"><button type="button" class="primary" data-branch-confirm${conflicts.length ? ' disabled' : ''}>Restore this branch</button><button type="button" class="secondary" data-branch-cancel>Cancel</button></div></section>`;
}

// The panel in the page. `version()` is the version being previewed ({ id }), `nodeId` the idea selected in it.
export function branchRestorePanel({ api, act, esc, mapId, version, returnLive, toast, rerender, afterRestore }) {
  let shown = null; // { mapId, versionId, nodeId, preview }
  const current = nodeId => shown && shown.mapId === mapId() && shown.versionId === version()?.id && shown.nodeId === nodeId ? shown : null;
  async function load(nodeId, offset = 0) {
    const map = mapId(), versionId = version()?.id; if (!map || !versionId) return;
    try {
      const preview = await api(`/maps/${map}/versions/${encodeURIComponent(versionId)}/branch?${new URLSearchParams({ node: nodeId, offset: String(offset) })}`);
      const earlier = current(nodeId)?.preview;
      // A later page joins the list only when the plan is the same; otherwise the new preview starts again.
      if (offset && earlier?.hash === preview.hash) preview.nodes = [...earlier.nodes, ...preview.nodes];
      shown = { mapId: map, versionId, nodeId, preview };
      rerender();
    } catch (error) { toast(error.message); }
  }
  document.querySelector('#detail').addEventListener('click', async event => {
    const button = event.target.closest('[data-branch-preview], [data-branch-more], [data-branch-cancel], [data-branch-confirm]'); if (!button) return;
    if (button.dataset.branchPreview) return load(button.dataset.branchPreview);
    const open = shown; if (!open) return;
    if ('branchMore' in button.dataset) return load(open.nodeId, Number(button.dataset.branchMore));
    shown = null;
    if ('branchCancel' in button.dataset) return rerender();
    const { preview } = open;
    returnLive();
    if (await act(null, 'restore-branch', { nodeId: preview.node.id, version: preview.version.id, previewHash: preview.hash, expectedRevision: preview.revision })) toast('Branch restored. You can undo this from Versions.');
    afterRestore();
  });
  return {
    // The inspector's part for `nodeId` while a version is previewed.
    html(nodeId) {
      const open = current(nodeId);
      return open ? branchRestoreHtml(open.preview, { esc })
        : `<div class="branch-restore"><button type="button" class="secondary" data-branch-preview="${esc(nodeId)}">Restore this branch…</button><p class="form-note">Brings back this idea and everything below it as they were in this version. The rest of the map stays as it is now.</p></div>`;
    },
  };
}
