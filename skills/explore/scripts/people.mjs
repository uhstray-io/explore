// What people keep beside the ideas: requests to look at a branch (H7) and discussions (H6). Neither is part of an
// idea's work, so work packets and briefs never carry them; an idea's Markdown view shows both; and both go with an idea
// a restart or a branch restore removes, as its jobs do, while the version saved before keeps them.
import { assignmentLines, openRequestsOn, dropRequestsOn } from './assignments.mjs';
import { discussionLines, openThreadsOn, dropThreadsOn } from './discussions.mjs';
import { assignmentsOf } from '../assets/assignments.js';
import { threadsOf } from '../assets/discussions.js';

export const peopleLines = (map, node) => [...assignmentLines(map, node), ...discussionLines(map, node)];
// What removing `ids` takes with it that is still open, for a preview to name.
export const openOnIdeas = (map, ids) => ({ requestsRemoved: openRequestsOn(map, ids), discussionsRemoved: openThreadsOn(map, ids) });
// What a preview's hash covers, so anything asked or said on those ideas after it makes the preview out of date.
export const peopleOnIdeas = (map, ids) => [...assignmentsOf(map).filter(item => ids.has(item.nodeId)).map(item => `${item.id} ${item.status}`),
  ...threadsOf(map).filter(thread => ids.has(thread.nodeId)).map(thread => `${thread.id} ${thread.status} ${thread.messages.length}`)].sort();
export function dropOnIdeas(map, ids) { dropRequestsOn(map, ids); dropThreadsOn(map, ids); }
