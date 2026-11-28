import { branchIds, treeOrder } from './graph.js';

// Choosing ideas for a read-only viewer file (I4). Nothing is chosen at first; each chosen idea says whether its
// answers and its findings and sources go in. The preview is what the file will hold, and Download needs a preview
// of this exact selection, of this map, at its current revision.
export const selectionKey = picked => JSON.stringify(Object.keys(picked).sort().map(id => [id, picked[id].answers, picked[id].findings]));
export const previewCurrent = (preview, { mapId, revision, picked }) => !!preview && preview.mapId === mapId && preview.revision === revision && preview.key === selectionKey(picked);

// The preview as plain text: every piece of map text the file will hold, in its order.
export function previewText(data) {
  return [data.heading, ...data.nodes.map(node => [`${node.title} — ${node.kind} · ${node.labels.join(' · ')}`,
    ...(node.premise ? [`  Premise: ${node.premise}`] : []), ...(node.summary ? [`  Agent findings: ${node.summary}`] : []), ...(node.findings ? [`  ${node.findings}`] : []),
    ...(node.sources || []).map(source => `  Source: ${[source.title, source.url, source.note].filter(Boolean).join(' — ')}`),
    ...(node.questions || []).map(question => `  Question: ${question.text} — ${question.status === 'answered' ? `Answer: ${question.answer}${question.certainty ? ` (${question.certainty})` : ''}` : question.status === 'waiting' ? 'waiting for an answer' : 'saved for later'}`),
  ].join('\n'))].join('\n\n');
}

export function viewerPicker({ api, map, onChange }) {
  const $ = selector => document.querySelector(selector), box = $('#viewer-pick'), tree = $('#viewer-tree'), shown = $('#viewer-preview-text'), status = $('#export-status');
  let picked = {}, preview = null, builtFor = null;
  const mapKey = () => (map() ? `${map().id}@${map().revision}` : null);
  const clear = () => { preview = null; shown.hidden = true; shown.textContent = ''; onChange(); };
  const checkbox = (attributes, label, name) => {
    const wrap = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.setAttribute('aria-label', name); for (const key of Object.keys(attributes)) input.dataset[key] = attributes[key];
    wrap.append(input, ` ${label}`); return wrap;
  };
  // One row per idea in tree order, indented under its parent. A new map starts with nothing chosen; a newer
  // revision of the same map keeps the choices for ideas that still exist, and keeps focus where it was.
  function build() {
    const open = map(); if (!open) return;
    if (builtFor?.split('@')[0] !== open.id) picked = {};
    const ids = new Set(open.nodes.map(node => node.id)), parents = new Set(open.nodes.map(node => node.parentId));
    picked = Object.fromEntries(Object.entries(picked).filter(([id]) => ids.has(id)));
    const active = document.activeElement, focusKey = tree.contains(active) ? JSON.stringify(active.dataset) : null;
    tree.replaceChildren(...treeOrder(open).map(({ node, depth }) => {
      const row = document.createElement('div'); row.className = 'viewer-row'; row.style.setProperty('--depth', String(Math.min(depth, 8)));
      const title = checkbox({ viewerPick: node.id }, node.title, `Include ${node.title}`); title.className = 'viewer-pick';
      const parts = document.createElement('span'); parts.className = 'viewer-parts';
      parts.append(checkbox({ viewerPart: 'answers', id: node.id }, 'Answers', `Include answers for ${node.title}`), checkbox({ viewerPart: 'findings', id: node.id }, 'Findings and sources', `Include findings and sources for ${node.title}`));
      row.append(title, parts);
      if (parents.has(node.id)) {
        const branch = document.createElement('button'); branch.type = 'button'; branch.className = 'text-button'; branch.dataset.viewerBranch = node.id;
        branch.textContent = 'Select this branch'; branch.setAttribute('aria-label', `Select ${node.title} and everything below it`); row.append(branch);
      }
      return row;
    }));
    builtFor = mapKey(); sync();
    if (focusKey) [...tree.querySelectorAll('input, button')].find(control => JSON.stringify(control.dataset) === focusKey)?.focus();
  }
  function sync() {
    for (const input of tree.querySelectorAll('[data-viewer-pick]')) input.checked = !!picked[input.dataset.viewerPick];
    for (const input of tree.querySelectorAll('[data-viewer-part]')) { const choice = picked[input.dataset.id]; input.disabled = !choice; input.checked = choice ? choice[input.dataset.viewerPart] : false; }
    $('#viewer-preview').disabled = !Object.keys(picked).length;
  }
  tree.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.viewerPick) { if (input.checked) picked[input.dataset.viewerPick] = { answers: true, findings: true }; else delete picked[input.dataset.viewerPick]; }
    else if (input.dataset.viewerPart && picked[input.dataset.id]) picked[input.dataset.id][input.dataset.viewerPart] = input.checked;
    sync(); clear();
  });
  tree.addEventListener('click', event => {
    const button = event.target.closest('[data-viewer-branch]'); if (!button) return;
    for (const id of branchIds(map(), button.dataset.viewerBranch)) picked[id] ??= { answers: true, findings: true };
    sync(); clear();
  });
  $('#viewer-preview').addEventListener('click', async () => {
    const open = map(); if (!open) return;
    const key = selectionKey(picked), asked = mapKey();
    try {
      const reply = await api(`/maps/${open.id}/viewer`, { expectedRevision: open.revision, nodes: Object.keys(picked).map(id => ({ id, ...picked[id] })) });
      // The selection or the map changed while this was made: it describes neither any more.
      if (selectionKey(picked) !== key || mapKey() !== asked) { status.textContent = 'The selection or the map changed meanwhile. Preview again.'; return; }
      preview = { mapId: reply.mapId, revision: reply.revision, key, html: reply.html, filename: reply.filename };
      shown.textContent = previewText(reply.data); shown.hidden = false;
      status.textContent = `This is everything the file will hold: ${reply.count} ${reply.count === 1 ? 'idea' : 'ideas'}. Download it, or change the selection.`;
    } catch (error) { status.textContent = error.message; }
    finally { onChange(); }
  });
  return {
    show(visible) { box.hidden = !visible; if (visible && builtFor !== mapKey()) build(); },
    ready: () => previewCurrent(preview, { mapId: map()?.id, revision: map()?.revision, picked }),
    // The map moved on, or another map opened: the preview no longer describes it, and the list may differ.
    mapChanged() {
      if (preview && !previewCurrent(preview, { mapId: map()?.id, revision: map()?.revision, picked })) { clear(); status.textContent = 'The map changed, so preview again before downloading.'; }
      if (!box.hidden && builtFor !== mapKey()) build();
    },
    download(save) {
      if (!previewCurrent(preview, { mapId: map()?.id, revision: map()?.revision, picked })) { status.textContent = 'Preview the file first: the selection or the map changed.'; return; }
      save(preview.html, 'text/html;charset=utf-8', preview.filename);
      status.textContent = `Downloaded ${preview.filename}. It opens in any browser, offline.`;
    },
  };
}
