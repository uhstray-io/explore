import { branchIds } from './graph.js';

// Choosing ideas for a read-only viewer file (I4). Nothing is chosen at first; each chosen idea says whether its
// answers and its findings and sources go in. The preview is what the file will hold, and Download needs a preview
// of this exact selection at the map's current revision.
export const selectionKey = picked => JSON.stringify(Object.keys(picked).sort().map(id => [id, picked[id].answers, picked[id].findings]));
export const previewCurrent = (preview, { revision, picked }) => !!preview && preview.revision === revision && preview.key === selectionKey(picked);

// The preview as plain text: every piece of map text the file will hold, idea by idea.
export function previewText(data) {
  return data.nodes.map(node => [`${node.title} — ${node.state}`,
    ...(node.premise ? [`  Premise: ${node.premise}`] : []), ...(node.summary ? [`  Agent findings: ${node.summary}`] : []),
    ...(node.findings && node.findings !== node.summary ? [`  ${node.findings}`] : []),
    ...(node.sources || []).map(source => `  Source: ${[source.title, source.url, source.note].filter(Boolean).join(' — ')}`),
    ...(node.questions || []).map(question => `  Question: ${question.text} — ${question.status === 'answered' ? `Answer: ${question.answer}` : question.status === 'waiting' ? 'waiting for an answer' : 'saved for later'}`),
  ].join('\n')).join('\n\n');
}

export function viewerPicker({ api, map, onChange }) {
  const $ = selector => document.querySelector(selector), box = $('#viewer-pick'), tree = $('#viewer-tree'), shown = $('#viewer-preview-text'), status = $('#export-status');
  let picked = {}, preview = null, builtFor = null;
  const clear = () => { preview = null; shown.hidden = true; shown.textContent = ''; onChange(); };
  // One row per idea, indented under its parent; the part boxes follow the idea's own box.
  function build() {
    const open = map(); if (!open) return;
    const depth = new Map(), byId = new Map(open.nodes.map(node => [node.id, node]));
    const depthOf = node => { if (!depth.has(node.id)) depth.set(node.id, byId.has(node.parentId) ? depthOf(byId.get(node.parentId)) + 1 : 0); return depth.get(node.id); };
    const parents = new Set(open.nodes.map(node => node.parentId));
    picked = Object.fromEntries(Object.entries(picked).filter(([id]) => byId.has(id)));
    tree.replaceChildren(...open.nodes.map(node => {
      const row = document.createElement('div'); row.className = 'viewer-row'; row.style.setProperty('--depth', String(Math.min(depthOf(node), 8)));
      const box = (attributes, text) => { const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; for (const key of Object.keys(attributes)) input.dataset[key] = attributes[key]; label.append(input, ` ${text}`); return label; };
      const title = box({ viewerPick: node.id }, node.title); title.className = 'viewer-pick';
      const parts = document.createElement('span'); parts.className = 'viewer-parts';
      parts.append(box({ viewerPart: 'answers', id: node.id }, 'Answers'), box({ viewerPart: 'findings', id: node.id }, 'Findings and sources'));
      row.append(title, parts);
      if (parents.has(node.id)) { const branch = document.createElement('button'); branch.type = 'button'; branch.className = 'text-button'; branch.dataset.viewerBranch = node.id; branch.textContent = 'Select this branch'; row.append(branch); }
      return row;
    }));
    builtFor = open.revision; sync();
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
    const key = selectionKey(picked);
    try {
      const reply = await api(`/maps/${open.id}/viewer`, { expectedRevision: open.revision, nodes: Object.keys(picked).map(id => ({ id, ...picked[id] })) });
      if (selectionKey(picked) !== key) return; // The selection changed while this was made.
      preview = { revision: reply.revision, key, html: reply.html, filename: reply.filename };
      shown.textContent = previewText(reply.data); shown.hidden = false;
      status.textContent = `This is everything the file will hold: ${reply.count} ${reply.count === 1 ? 'idea' : 'ideas'}. Download it, or change the selection.`;
    } catch (error) { status.textContent = error.message; }
    onChange();
  });
  return {
    show(visible) { box.hidden = !visible; if (visible && builtFor !== map()?.revision) build(); },
    ready: () => previewCurrent(preview, { revision: map()?.revision, picked }),
    // The map moved on: the preview no longer describes it, and the list may have new ideas.
    mapChanged() {
      if (preview && preview.revision !== map()?.revision) { clear(); status.textContent = 'The map changed, so preview again before downloading.'; }
      if (!box.hidden && builtFor !== map()?.revision) build();
    },
    download(save) {
      if (!previewCurrent(preview, { revision: map()?.revision, picked })) { status.textContent = 'Preview the file first: the selection or the map changed.'; return; }
      save(preview.html, 'text/html;charset=utf-8', preview.filename);
      status.textContent = `Downloaded ${preview.filename}. It opens in any browser, offline.`;
    },
  };
}
