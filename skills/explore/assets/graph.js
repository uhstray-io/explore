export const workLabels = { suggested: 'Unexplored', queued: 'Queued', running: 'Researching', 'awaiting-answer': 'Needs your answer', explored: 'Explored', interrupted: 'Ready to retry' };

// What review says about an idea's findings, or '' when nothing has been decided.
export function reviewWord(node) {
  return node.stale ? 'needs review' : node.reviewState === 'accepted' ? 'accepted' : node.reviewState === 'cleared' ? 'no longer relevant' : '';
}
export function presentation(node) {
  const work = workLabels[node.status] || node.status;
  return { label: [work, reviewWord(node)].filter(Boolean).join(' · '), lit: node.status === 'explored' && !node.stale };
}
// Ideas in reading order: depth-first from the root with children in map order, then any not under the root: each
// idea whose parent is gone with its own children, then any left (a loop of parents). Each comes with its depth (0
// for the root, and for an idea outside its tree).
export function treeOrder(map) {
  const children = new Map(), out = [], seen = new Set();
  for (const node of map.nodes) { if (!children.has(node.parentId)) children.set(node.parentId, []); children.get(node.parentId).push(node); }
  // A stack rather than recursion, so a map thousands of ideas deep is still walked.
  const walk = start => {
    const stack = [[start, 0]];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (seen.has(node.id)) continue;
      seen.add(node.id); out.push({ node, depth });
      const below = children.get(node.id) ?? [];
      for (let index = below.length - 1; index >= 0; index--) stack.push([below[index], depth + 1]);
    }
  };
  const ids = new Set(map.nodes.map(node => node.id));
  for (const node of map.nodes) if (node.id === map.rootId) walk(node);
  for (const node of map.nodes) if (!ids.has(node.parentId)) walk(node);
  for (const node of map.nodes) walk(node);
  return out;
}
// The links along which a change spreads, by the idea it starts from: to its `contains` children, and from a
// prerequisite to each idea linked as depending on it. Each is { to, dependency }, sorted by `to`.
export function changeLinks(map) {
  const links = new Map(), add = (from, to, dependency) => { if (!links.has(from)) links.set(from, []); links.get(from).push({ to, dependency }); };
  for (const edge of map.edges ?? []) { if (edge.type === 'contains') add(edge.from, edge.to, false); else if (edge.type === 'depends_on') add(edge.to, edge.from, true); }
  for (const list of links.values()) list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  return links;
}
// The one walk a change takes from `starts`: breadth-first along changeLinks, nearest first with ties by ID, each idea
// once and never a start. Yields [id, { from, dependency }], the link the idea was first reached by. It passes through
// IDs missing from the map, which a Git merge or a hand edit can leave behind, so callers that show ideas drop those.
// `dependencies` false keeps to `contains` links. The Store's review flags and impact (D4) both walk this, so they agree.
export function* changeWalk(map, starts, { links = changeLinks(map), dependencies = true } = {}) {
  const queue = [...new Set(starts)], seen = new Set(queue);
  for (let at = 0; at < queue.length; at++) {
    for (const link of links.get(queue[at]) ?? []) {
      if (seen.has(link.to) || (link.dependency && !dependencies)) continue;
      seen.add(link.to); queue.push(link.to);
      yield [link.to, { from: queue[at], dependency: link.dependency }];
    }
  }
}
// What builds on these ideas: their `contains` descendants and, transitively, ideas linked as depending on them.
// Includes the ideas themselves.
export function downstreamOf(map, nodeIds) {
  const starts = [].concat(nodeIds), affected = new Set(starts);
  for (const [id] of changeWalk(map, starts)) affected.add(id);
  return affected;
}
// An idea and everything below it, by parent, as a Set of IDs. Empty when the idea is not in the map.
export function branchIds(map, nodeId) {
  const children = new Map();
  for (const node of map.nodes) { if (!children.has(node.parentId)) children.set(node.parentId, []); children.get(node.parentId).push(node.id); }
  const ids = new Set(map.nodes.some(node => node.id === nodeId) ? [nodeId] : []);
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child); // A Set visits what is added while iterating.
  return ids;
}

// The least distance the layout leaves between two ideas' centres (more beside the root). Exports scale by it.
export const minimumSpacing = 58;
// Saved coordinates are absolute centers. Layout never writes, activates, or edits nodes.
export function constellationLayout(map) {
  const nodes = new Map(map.nodes.map(node => [node.id, node]));
  const children = new Map(map.nodes.map(node => [node.id, []]));
  for (const node of map.nodes) children.get(node.parentId)?.push(node);
  const positions = {}, domains = {}, occupied = new Map();
  const root = nodes.get(map.rootId) || map.nodes[0];
  if (!root) return { positions, domains };
  // Place each branch near its parent, independent of the total number of leaves.
  // A spatial grid keeps nodes apart without spreading every edge across the map.
  const gap = 84;
  const key = (x, y) => Math.floor(x / gap) + ',' + Math.floor(y / gap);
  function available(point) {
    const cx = Math.floor(point.x / gap), cy = Math.floor(point.y / gap);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const other of occupied.get(x + ',' + y) || []) {
        if (Math.hypot(point.x - other.x, point.y - other.y) < gap) return false;
      }
    }
    return true;
  }
  function reserve(id, point, domain) {
    positions[id] = point; domains[id] = domain;
    const cell = key(point.x, point.y);
    if (!occupied.has(cell)) occupied.set(cell, []);
    occupied.get(cell).push(point);
  }
  function nearby(parent, angle, index) {
    for (let ring = 0; ; ring++) {
      const radius = 112 + ring * 38;
      const count = 24 + ring * 6;
      for (let attempt = 0; attempt < count; attempt++) {
        const turn = Math.ceil(attempt / 2) * (attempt % 2 ? 1 : -1) * Math.PI * 2 / count;
        const direction = angle + turn + Math.sin(index * 2.4) * .12;
        const point = { x: parent.x + Math.cos(direction) * radius, y: parent.y + Math.sin(direction) * radius };
        if (available(point)) return point;
      }
    }
  }
  const queue = [];
  function component(node, domain) {
    if (positions[node.id]) return;
    reserve(node.id, queue.length ? nearby({ x: 0, y: 0 }, .5, queue.length) : { x: 0, y: 0 }, domain);
    queue.push(node);
    for (let cursor = queue.length - 1; cursor < queue.length; cursor++) {
      const parent = queue[cursor], point = positions[parent.id];
      const origin = positions[parent.parentId] || { x: point.x - 1, y: point.y };
      const outward = Math.atan2(point.y - origin.y, point.x - origin.x);
      const list = children.get(parent.id);
      list.forEach((child, index) => {
        if (positions[child.id]) return;
        const angle = parent.id === root.id ? -1.2 + index * 2.399963 : outward + (index - (list.length - 1) / 2) * .9;
        reserve(child.id, nearby(point, angle, queue.length), parent.id === root.id ? index : domains[parent.id]);
        queue.push(child);
      });
    }
  }
  component(root, 0);
  // Imported/disconnected nodes remain visible even if their parent is absent.
  for (const node of map.nodes) component(node, queue.length);
  // Relax crowded branches locally: short connections and readable node spacing
  // matter more than matching a symmetric ring. This runs once per topology.
  const points = map.nodes.map(node => positions[node.id]);
  const indices = new Map(map.nodes.map((node, index) => [node.id, index]));
  const springs = map.nodes.filter(node => indices.has(node.parentId)).map(node => [indices.get(node.id), indices.get(node.parentId)]);
  for (let step = 0; step < 120; step++) {
    const offsets = points.map(() => ({ x: 0, y: 0 }));
    for (const [a, b] of springs) {
      const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y;
      const distance = Math.hypot(dx, dy) || 1;
      const pull = (distance - 112) / distance * .07;
      offsets[a].x += dx * pull; offsets[a].y += dy * pull;
      offsets[b].x -= dx * pull; offsets[b].y -= dy * pull;
    }
    for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
      const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y;
      if (Math.abs(dx) >= 72 || Math.abs(dy) >= 72) continue;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance >= 72) continue;
      const push = (72 - distance) / distance * .65;
      offsets[a].x -= dx * push; offsets[a].y -= dy * push;
      offsets[b].x += dx * push; offsets[b].y += dy * push;
    }
    points.forEach((point, index) => {
      if (map.nodes[index].id === root.id) return;
      point.x += Math.max(-18, Math.min(18, offsets[index].x));
      point.y += Math.max(-18, Math.min(18, offsets[index].y));
    });
  }
  // Finish by separating circles; manual placements below always remain authoritative.
  for (let step = 0; step < 35; step++) {
    for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) {
      const dx = points[b].x - points[a].x, dy = points[b].y - points[a].y;
      const clearance = (map.nodes[a].id === root.id || map.nodes[b].id === root.id) ? minimumSpacing + 10 : minimumSpacing;
      if (Math.abs(dx) >= clearance || Math.abs(dy) >= clearance) continue;
      const distance = Math.hypot(dx, dy) || 1;
      if (distance >= clearance) continue;
      const push = (clearance - distance) / distance * .52;
      const aFixed = map.nodes[a].id === root.id, bFixed = map.nodes[b].id === root.id;
      if (!aFixed) { points[a].x -= dx * push * (bFixed ? 2 : 1); points[a].y -= dy * push * (bFixed ? 2 : 1); }
      if (!bFixed) { points[b].x += dx * push * (aFixed ? 2 : 1); points[b].y += dy * push * (aFixed ? 2 : 1); }
    }
  }
  for (const node of map.nodes) {
    const saved = map.view?.positions?.[node.id];
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) positions[node.id] = { x: saved.x, y: saved.y };
  }
  return { positions, domains };
}

export function connectionPath(from, to) {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

// A view is { x, y, scale }: a map point p shows on screen at (x + p.x * scale, y + p.y * scale).
export const toScreen = (view, p) => ({ x: view.x + p.x * view.scale, y: view.y + p.y * view.scale });
export const toWorld = (view, p) => ({ x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale });
// The view that shows every point inside `area` ({ width, height } on screen), centred and at most `maxScale`.
// `pad` widens the points' box in map units (room for captions); `margin` keeps screen space free around it.
export function fitView(positions, area, { pad = {}, margin = { x: 0, y: 0 }, maxScale = Infinity } = {}) {
  const points = Object.values(positions);
  if (!points.length) return { scale: Math.min(1, maxScale), x: area.width / 2, y: area.height / 2 };
  const left = Math.min(...points.map(p => p.x)) - (pad.left ?? 0), top = Math.min(...points.map(p => p.y)) - (pad.top ?? 0);
  const width = Math.max(...points.map(p => p.x)) + (pad.right ?? 0) - left, height = Math.max(...points.map(p => p.y)) + (pad.bottom ?? 0) - top;
  const scale = Math.min(maxScale, Math.max(1, area.width - margin.x) / Math.max(1, width), Math.max(1, area.height - margin.y) / Math.max(1, height));
  return { scale, x: (area.width - width * scale) / 2 - left * scale, y: (area.height - height * scale) / 2 - top * scale };
}
// Fit map: every idea with room for its caption, never zoomed in past 115%.
export const overviewView = (positions, viewport) => fitView(positions, viewport, { pad: { left: 115, top: 60, right: 115, bottom: 110 }, margin: { x: 48, y: 40 }, maxScale: 1.15 });

export function focusedView(point, viewport, scale = 1, neighbors = []) {
  scale = Math.max(1, Math.min(3, scale));
  if (neighbors.length) {
    const reachX = Math.max(60, ...neighbors.map(p => Math.abs(p.x - point.x) + 40));
    const reachY = Math.max(60, ...neighbors.map(p => Math.abs(p.y - point.y) + 40));
    scale = Math.min(scale, Math.max(1, viewport.width - 32) / (2 * reachX), Math.max(1, viewport.height - 32) / (2 * reachY));
  }
  return centredView(point, viewport, scale);
}
// The view that puts `point` in the middle of the viewport at `scale`, as it is.
export const centredView = (point, viewport, scale) => ({ scale, x: viewport.width / 2 - point.x * scale, y: viewport.height / 2 - point.y * scale });
// The part of the map a view shows, in map coordinates.
export const viewRect = (view, viewport) => ({ ...toWorld(view, { x: 0, y: 0 }), width: viewport.width / view.scale, height: viewport.height / view.scale });

// How much each idea shows at a zoom (Z10): 'far' (circles and colours), 'standard', 'near' (every title) or 'close'
// (titles and states). A level is reached at 0.45, 1.3 and 2.2 and left about 10% lower, so it never flickers.
export const detailLevels = ['far', 'standard', 'near', 'close'];
const detailSteps = [0.45, 1.3, 2.2];
export function detailLevel(scale, previous) {
  let level = detailLevels.indexOf(previous);
  if (level < 0) return detailLevels[detailSteps.filter(step => scale >= step).length];
  while (level < detailSteps.length && scale >= detailSteps[level]) level++;
  while (level > 0 && scale < detailSteps[level - 1] * 0.9) level--;
  return detailLevels[level];
}

// A finished branch: the server marks it complete, and an older map's explored idea counts too.
export const branchComplete = node => !!node.completed || node.status === 'explored';
