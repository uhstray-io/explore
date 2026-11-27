import { semanticRelations } from './map-validation.mjs';
import { textField } from './fields.mjs';

// Connections the user records (D1): "this idea depends on, supports, contradicts or relates to that one", across
// branches too. A link changes no findings and never starts work. A later change to a prerequisite flags what
// depends on it, through the existing review traversal. Agent-recorded links have no `addedBy`.
class LinkProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new LinkProblem(message, status); };
const fail = message => need(false, message);
const relationOf = input => {
  const relation = input.relation ?? 'depends_on';
  need(semanticRelations.has(relation), 'Choose depends on, supports, contradicts or related to. Containment comes from the map itself.');
  return relation;
};
// Whether `from` already depends on `to`, directly or through other dependencies.
function dependsOn(map, from, to) {
  const seen = new Set(), queue = [from];
  while (queue.length) {
    const id = queue.shift(); if (id === to) return true; if (seen.has(id)) continue; seen.add(id);
    for (const edge of map.edges) if (edge.type === 'depends_on' && edge.from === id) queue.push(edge.to);
  }
  return false;
}
// Work reading either idea now sees a different map: its result comes back stale, never silently applied.
const touch = (...nodes) => { for (const node of nodes) node.contentRevision++; };

export const linkActions = {
  link: { target: 'node', apply: ({ map, node, input, store }) => {
    const relation = relationOf(input), other = map.nodes.find(n => n.id === input.to);
    need(other, 'Choose an idea to connect to.', 404);
    need(other.id !== node.id, 'An idea cannot be connected to itself.');
    need(!map.edges.some(e => e.from === node.id && e.to === other.id && e.type === relation), 'These ideas are already connected this way.', 409);
    if (relation === 'depends_on') need(!dependsOn(map, other.id, node.id), `That would make a loop: “${other.title}” already depends on this idea.`, 409);
    const note = textField(input.note, 'A note', 1000, fail, { optional: true });
    const edge = { from: node.id, to: other.id, type: relation, addedBy: 'user', ...(note ? { note } : {}) };
    map.edges.push(edge); store.recordGrowth(map, [], [edge]); touch(node, other);
    store.event(map, 'linked', node.id, `${relation} ${other.id}`);
  } },
  // Removes a link the user or the agent recorded; containment stays.
  unlink: { target: 'node', apply: ({ map, node, input, store }) => {
    const relation = relationOf(input), index = map.edges.findIndex(e => e.from === node.id && e.to === input.to && e.type === relation);
    need(index >= 0, 'These ideas are not connected this way.', 404);
    map.edges.splice(index, 1); touch(node, ...map.nodes.filter(n => n.id === input.to));
    store.event(map, 'unlinked', node.id, `${relation} ${input.to}`);
  } },
};
