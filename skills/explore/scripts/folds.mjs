// Collapse branches (Z6): which ideas' directions are hidden, kept with the map in view.collapsed like positions, so
// everyone who opens the map sees the same arrangement. Folding changes no idea, edge or history event: no version is
// recorded and a teammate's fold is not an outside change. Branch focus is the browser's own and never saved.
class FoldProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new FoldProblem(message, status); };
const foldsOf = map => (Array.isArray(map.view?.collapsed) ? map.view.collapsed : []);
// Keeps known, distinct IDs, and drops the list when it is empty, so an unfolded map reads as before.
function setFolds(map, list) {
  map.view ??= { positions: {} };
  const known = new Set(map.nodes.map(node => node.id)), next = [...new Set(list)].filter(id => known.has(id));
  if (next.length) map.view.collapsed = next; else delete map.view.collapsed;
}

export const foldActions = {
  // `collapsed`: true hides the idea's directions, false shows them again.
  fold: { target: 'node', apply: ({ map, node, input }) => {
    need(typeof input.collapsed === 'boolean', 'collapsed must be true or false.');
    if (input.collapsed) need(map.nodes.some(item => item.parentId === node.id), 'This idea has no directions to hide.');
    setFolds(map, input.collapsed ? [...foldsOf(map), node.id] : foldsOf(map).filter(id => id !== node.id));
  } },
  // Shows the idea wherever it is: every folded idea above it unfolds.
  reveal: { target: 'node', apply: ({ map, node }) => {
    const byId = new Map(map.nodes.map(item => [item.id, item])), above = new Set();
    for (let at = byId.get(node.parentId); at && !above.has(at.id); at = byId.get(at.parentId)) above.add(at.id);
    setFolds(map, foldsOf(map).filter(id => !above.has(id)));
  } },
};
