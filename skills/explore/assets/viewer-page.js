// The read-only viewer's own script (I4). It is inlined into the exported file and allowed there by its hash.
// Map text reaches the page only through textContent; nothing is fetched. viewerModel is pure, for tests.
(function () {
  'use strict';
  function viewerModel(data) {
    const nodes = data.nodes, order = nodes.map(node => node.id), byId = new Map(nodes.map(node => [node.id, node]));
    const searchable = node => [node.title, node.premise, node.summary, node.findings, ...(node.questions || []).flatMap(question => [question.text, question.answer])]
      .filter(Boolean).join('\n').toLowerCase();
    return {
      node: id => byId.get(id) || null,
      // Ideas whose title, premise, findings, questions or answers contain the query, in the file's order.
      search(query) { const needle = String(query).trim().toLowerCase(); return order.filter(id => !needle || searchable(byId.get(id)).includes(needle)); },
      neighbours(id) {
        const index = order.indexOf(id), node = byId.get(id);
        return { parent: node ? node.parentId : null, children: nodes.filter(other => other.parentId === id).map(other => other.id), previous: index > 0 ? order[index - 1] : null, next: index >= 0 && index < order.length - 1 ? order[index + 1] : null };
      },
    };
  }
  globalThis.viewerModel = viewerModel;
  if (typeof document === 'undefined') return;

  const data = JSON.parse(document.getElementById('viewer-data').textContent), model = viewerModel(data);
  // An element with text, a class, a click handler or attributes; empty children are skipped.
  const el = (tag, options, ...children) => {
    const element = document.createElement(tag), settings = options || {};
    for (const key of Object.keys(settings)) {
      const value = settings[key];
      if (key === 'text') element.textContent = value;
      else if (key === 'className') element.className = value;
      else if (key === 'onclick') element.addEventListener('click', value);
      else element.setAttribute(key, value);
    }
    element.append(...children.filter(Boolean));
    return element;
  };
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = (tag, attributes) => { const element = document.createElementNS(svgNs, tag); for (const key of Object.keys(attributes)) element.setAttribute(key, String(attributes[key])); return element; };
  const reviewClass = node => (node.review ? node.review.replace(/ /g, '-') : '');
  const count = data.nodes.length;
  const search = el('input', { type: 'search', id: 'viewer-search', 'aria-label': 'Search these ideas', placeholder: 'Search titles, findings and answers' });
  const status = el('p', { className: 'search-status', role: 'status' });
  const list = el('ul', { className: 'idea-list' }), detail = el('section', { className: 'detail', tabindex: '-1', 'aria-label': 'The chosen idea' });
  const buttons = new Map();

  function select(id, focus) {
    if (!model.node(id)) return;
    for (const [other, button] of buttons) { if (other === id) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); }
    renderDetail(model.node(id));
    for (const circle of document.querySelectorAll('.overview circle')) circle.classList.toggle('chosen', circle.getAttribute('data-id') === id);
    try { history.replaceState(null, '', '#' + encodeURIComponent(id)); } catch (error) { /* Some browsers cannot change a local file's address. */ }
    if (focus) detail.focus();
  }
  const jump = (label, id) => el('button', { type: 'button', className: 'link', onclick: () => select(id, true) }, document.createTextNode(label));
  const section = (title, ...children) => el('div', { className: 'part' }, el('h3', { text: title }), ...children);
  function renderDetail(node) {
    const around = model.neighbours(node.id);
    const parts = [
      el('p', { className: 'kind', text: node.kind }),
      el('p', { className: 'badges' }, ...node.labels.map(label => el('span', { className: label === node.review ? `badge ${reviewClass(node)}` : 'badge', text: label }))),
      el('h2', { text: node.title }),
    ];
    if (node.premise) parts.push(section('Premise', el('p', { text: node.premise })));
    if (node.summary || node.findings) parts.push(section('Agent findings', node.summary ? el('p', { className: 'summary', text: node.summary }) : null, node.findings ? el('p', { className: 'findings', text: node.findings }) : null));
    if (node.sources && node.sources.length) parts.push(section('Sources', el('ul', null, ...node.sources.map(source => el('li', null,
      /^https?:\/\//i.test(source.url || '') ? el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: source.title || source.url }) : el('span', { text: `${source.title || ''} ${source.url || ''}`.trim() }),
      source.note ? el('p', { className: 'note', text: source.note }) : null)))));
    if (node.questions && node.questions.length) parts.push(section('Your answers', el('ul', null, ...node.questions.map(question => el('li', null,
      el('p', { className: 'question', text: question.text }),
      el('p', { className: question.status === 'answered' ? 'answer' : 'answer pending', text: question.status === 'answered' ? `${question.answer}${question.certainty ? ` (${question.certainty})` : ''}` : question.status === 'waiting' ? 'Waiting for an answer' : 'Saved for later' }))))));
    const related = [];
    if (around.parent) related.push(el('p', null, document.createTextNode('Part of: '), jump(model.node(around.parent).title, around.parent)));
    if (around.children.length) related.push(el('p', null, document.createTextNode('Below it: '), ...around.children.map(child => jump(model.node(child).title, child))));
    if (related.length) parts.push(el('div', { className: 'part related' }, ...related));
    const step = (label, id) => el('button', { type: 'button', className: 'step', ...(id ? { onclick: () => select(id, true) } : { disabled: '' }) }, document.createTextNode(label));
    parts.push(el('div', { className: 'steps' }, step('Previous', around.previous), step('Next', around.next)));
    detail.replaceChildren(...parts);
  }

  // The same layout as the app: each chosen idea at its place, joined to a chosen parent. Shown for two or more.
  function overview() {
    const placed = data.nodes.filter(node => node.position);
    if (placed.length < 2) return null;
    const xs = placed.map(node => node.position.x), ys = placed.map(node => node.position.y), pad = 30;
    const left = Math.min(...xs) - pad, top = Math.min(...ys) - pad, width = Math.max(...xs) - left + pad, height = Math.max(...ys) - top + pad;
    const picture = svg('svg', { viewBox: `${left} ${top} ${width} ${height}`, role: 'img', 'aria-label': 'Where these ideas sit on the map' });
    for (const node of placed) {
      const parent = node.parentId && model.node(node.parentId);
      if (parent && parent.position) picture.append(svg('line', { x1: parent.position.x, y1: parent.position.y, x2: node.position.x, y2: node.position.y }));
    }
    for (const node of placed) {
      const circle = svg('circle', { cx: node.position.x, cy: node.position.y, r: 9, 'data-id': node.id, class: reviewClass(node) });
      const label = document.createElementNS(svgNs, 'title'); label.textContent = node.title; circle.append(label);
      circle.addEventListener('click', () => select(node.id, true));
      picture.append(circle);
    }
    return el('figure', { className: 'overview' }, picture);
  }

  for (const node of data.nodes) {
    const button = el('button', { type: 'button', onclick: () => select(node.id, false) }, el('strong', { text: node.title }), el('small', { text: node.labels.join(' · ') }));
    buttons.set(node.id, button);
    list.append(el('li', { 'data-id': node.id }, button));
  }
  function filter() {
    const shown = new Set(model.search(search.value));
    for (const item of list.children) item.hidden = !shown.has(item.getAttribute('data-id'));
    status.textContent = search.value.trim() ? `${shown.size} of ${count} ideas match.` : `${count} ${count === 1 ? 'idea' : 'ideas'}.`;
  }
  search.addEventListener('input', filter);
  document.getElementById('viewer').append(...[
    el('header', null, el('h1', { text: data.heading }), el('p', { className: 'intro', text: 'A read-only copy from Explore. Findings are the agent’s and are settled only when accepted; answers are yours.' }), search, status),
    overview(),
    el('main', { className: 'layout' }, el('nav', { 'aria-label': 'Ideas' }, list), detail)].filter(Boolean));
  filter();
  const fromAddress = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch (error) { return ''; } };
  window.addEventListener('hashchange', () => { if (model.node(fromAddress())) select(fromAddress(), true); });
  select(model.node(fromAddress()) ? fromAddress() : data.nodes[0].id, false);
})();
