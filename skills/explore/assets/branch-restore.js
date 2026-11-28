// Restore one branch (E2) from the version preview's inspector: preview exactly what changes, then confirm.
// Nothing is written until Confirm, and Confirm stays disabled while anything blocks the restore.
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const changeWords = { changed: 'changed back', 're-added': 'brought back', removed: 'removed' };

export function branchRestoreHtml(preview, { esc }) {
  const { counts, conflicts } = preview;
  // The first titles, and how many more the list leaves out.
  const titles = (list, total = list.length) => `${list.map(item => esc(item.title)).join(', ')}${total > list.length ? ` and ${total - list.length} more` : ''}`;
  const lines = [
    counts.changed && `${count(counts.changed, 'idea')} changed back to this version`,
    counts.readded && `${count(counts.readded, 'idea')} deleted since brought back`,
    counts.removed && `${count(counts.removed, 'idea')} added since this version removed`,
    (counts.linksAdded || counts.linksRemoved) && `${count(counts.linksAdded, 'connection')} added, ${counts.linksRemoved} removed`,
  ].filter(Boolean);
  return `<section class="branch-restore" tabindex="-1" role="group" aria-label="Preview of restoring this branch"><h3>Restore “${esc(preview.node.title)}” and everything below it</h3>`
    + (conflicts.length ? `<div class="state-note warning">${conflicts.map(entry => `<p>${esc(entry.message)}${entry.nodes.length ? ` <small>${titles(entry.nodes)}</small>` : ''}</p>`).join('')}</div>` : '')
    + `<ul class="branch-restore-counts">${lines.map(line => `<li>${line}</li>`).join('') || '<li>Nothing in this branch changes.</li>'}</ul>`
    + (preview.nodes.length ? `<ul class="branch-restore-list">${preview.nodes.map(item => `<li><strong>${esc(item.title)}</strong> <small>${changeWords[item.change]}</small></li>`).join('')}</ul>` : '')
    + (preview.nextOffset !== null ? `<button type="button" class="text-button" data-branch-more="${preview.nextOffset}">Show more</button>` : '')
    + (counts.reopened ? `<p class="form-note">Finished, now unfinished again: ${titles(preview.reopened, counts.reopened)}.</p>` : '')
    + (counts.flaggedInside ? `<p class="form-note">Flagged for review, because what they relied on changed since: ${titles(preview.flaggedInside, counts.flaggedInside)}.</p>` : '')
    + (counts.affected ? `<p class="form-note">Outside the branch, ${count(counts.affected, 'idea')} ${counts.affected === 1 ? 'depends' : 'depend'} on what changes: ${titles(preview.affected, counts.affected)}. ${counts.flagged ? `${count(counts.flagged, 'finding')} will be flagged for review` : 'None has findings to flag'}${counts.questionsSetAside ? `, and ${count(counts.questionsSetAside, 'open question')} set aside` : ''}.</p>` : '')
    + '<p class="form-note">The rest of the map stays as it is now. No research starts, and you can undo this from Versions.</p>'
    + `<div class="version-actions"><button type="button" class="primary" data-branch-confirm${conflicts.length ? ' disabled' : ''}>Restore this branch</button><button type="button" class="secondary" data-branch-cancel>Cancel</button></div></section>`;
}

// The panel in the page. `version()` is the previewed version ({ id }); `reopen(id)` previews it again after a
// refused restore, so the user is back where they were.
export function branchRestorePanel({ api, act, esc, mapId, version, returnLive, reopen, toast, rerender, afterRestore }) {
  let shown = null; // { mapId, versionId, nodeId, preview }
  const current = nodeId => shown && shown.mapId === mapId() && shown.versionId === version()?.id && shown.nodeId === nodeId ? shown : null;
  async function load(nodeId, offset = 0) {
    const map = mapId(), versionId = version()?.id; if (!map || !versionId) return;
    const route = start => `/maps/${map}/versions/${encodeURIComponent(versionId)}/branch?${new URLSearchParams({ node: nodeId, offset: String(start) })}`;
    try {
      let preview = await api(route(offset));
      const earlier = current(nodeId)?.preview;
      // A later page joins the list only when the plan is the same; otherwise the preview starts again from the top.
      if (offset && earlier?.hash === preview.hash) preview = { ...preview, nodes: [...earlier.nodes, ...preview.nodes] };
      else if (offset) { preview = await api(route(0)); toast('This branch changed. The preview is updated.'); }
      shown = { mapId: map, versionId, nodeId, preview };
    } catch (error) { toast(error.message); return; }
    rerender();
    document.querySelector('#detail .branch-restore')?.focus();
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
    if (await act(null, 'restore-branch', { nodeId: preview.node.id, version: preview.version.id, previewHash: preview.hash, expectedRevision: preview.revision })) {
      toast('Branch restored. You can undo this from Versions.'); afterRestore();
    } else reopen(preview.version.id);
  });
  return {
    // The inspector's part for `nodeId` while a version is previewed.
    html(nodeId) {
      const open = current(nodeId);
      return open ? branchRestoreHtml(open.preview, { esc })
        : `<div class="branch-restore"><button type="button" class="secondary" data-branch-preview="${esc(nodeId)}">Preview restoring this branch…</button><p class="form-note">Shows what would change if this idea and everything below it came back as they were in this version. The rest of the map stays as it is now.</p></div>`;
    },
  };
}
