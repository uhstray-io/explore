import path from 'node:path';
import { git } from './git.mjs';
import { maxMapBytes } from './map-validation.mjs';
import { isOpen } from '../assets/questions.js';
import { markdownText as line } from '../assets/workspace-view.js';

// What changed in a map since a Git commit (E4), as editable Markdown for a pull request or a catch-up. The
// comparison is pure and matches ideas and questions by ID, never by wording. Git is only read: rev-parse and show.
class ChangesProblem extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const need = (condition, message, status) => { if (!condition) throw new ChangesProblem(message, status); };
const byId = list => new Map((list || []).map(item => [item.id, item]));
const premiseOf = node => node.prompt || node.body;
const ideaOf = node => ({ id: node.id, title: node.title, kind: node.kind, parentId: node.parentId });
const questionOf = (node, question) => ({ nodeId: node.id, nodeTitle: node.title, questionId: question.id, question: question.text, ...(question.answer ? { answer: question.answer } : {}) });
const linkKey = edge => `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
const completed = node => node.status === 'explored' || !!node.completedAt;

export function compareMaps(before, after) {
  const was = byId(before.nodes), now = byId(after.nodes);
  const result = { mapTitle: after.title,
    ideas: { added: after.nodes.filter(node => !was.has(node.id)).map(ideaOf), removed: (before.nodes || []).filter(node => !now.has(node.id)).map(ideaOf),
      premiseChanged: after.nodes.filter(node => was.has(node.id) && premiseOf(was.get(node.id)) !== premiseOf(node)).map(ideaOf) },
    answers: { given: [], changed: [] }, questions: { opened: [], closed: [] }, links: { added: [], removed: [] }, findings: [] };
  for (const node of after.nodes) {
    const old = was.get(node.id), oldQuestions = byId(old?.questions);
    for (const question of node.questions) {
      const previous = oldQuestions.get(question.id);
      if (question.answer && !question.supersededAt) {
        if (!previous?.answer) result.answers.given.push(questionOf(node, question));
        else if (previous.answer !== question.answer) result.answers.changed.push(questionOf(node, question));
      }
      const openNow = isOpen(question), openBefore = !!previous && isOpen(previous);
      if (openNow && !openBefore) result.questions.opened.push(questionOf(node, question));
      if (!openNow && openBefore) result.questions.closed.push({ ...questionOf(node, question), how: question.answer && !question.supersededAt ? 'answered' : question.supersededAt ? 'superseded' : 'dismissed' });
    }
    if (!old) continue;
    const changes = [
      old.summary !== node.summary && 'summary changed', !completed(old) && completed(node) && 'completed',
      old.reviewState !== 'accepted' && node.reviewState === 'accepted' && 'accepted',
      !old.stale && node.stale && 'flagged for review', old.stale && !node.stale && 'no longer flagged'].filter(Boolean);
    if (changes.length) result.findings.push({ ...ideaOf(node), summary: node.summary, changes });
  }
  const semantic = map => (map.edges || []).filter(edge => edge.type !== 'contains');
  const oldLinks = new Set(semantic(before).map(linkKey)), newLinks = new Set(semantic(after).map(linkKey));
  const titleIn = (map, id) => map.nodes?.find(node => node.id === id)?.title ?? id;
  const linkOf = (edge, map) => ({ from: edge.from, to: edge.to, type: edge.type, fromTitle: titleIn(map, edge.from), toTitle: titleIn(map, edge.to), ...(edge.addedBy ? { addedBy: edge.addedBy } : {}), ...(edge.note ? { note: edge.note } : {}) });
  result.links.added = semantic(after).filter(edge => !oldLinks.has(linkKey(edge))).map(edge => linkOf(edge, after));
  result.links.removed = semantic(before).filter(edge => !newLinks.has(linkKey(edge))).map(edge => linkOf(edge, before));
  return result;
}

export const countsOf = result => ({ ideasAdded: result.ideas.added.length, ideasRemoved: result.ideas.removed.length, premisesChanged: result.ideas.premiseChanged.length,
  answersGiven: result.answers.given.length, answersChanged: result.answers.changed.length, questionsOpened: result.questions.opened.length, questionsClosed: result.questions.closed.length,
  linksAdded: result.links.added.length, linksRemoved: result.links.removed.length, findingsChanged: result.findings.length });

// Headed sections with node IDs. User text is escaped as the brief escapes it; each section shows at most `limit`
// entries and says how many more it leaves out, and the whole stays under 200 KB.
export function changesMarkdown(result, { before, after, limit = 50 }) {
  const out = [`# Changes in ${line(result.mapTitle)}`, '', `${before} → ${after}`, ''];
  const section = (title, items, render) => {
    if (!items.length) return;
    out.push(`## ${title}`, '', ...items.slice(0, limit).map(render));
    if (items.length > limit) out.push(`- ${items.length - limit} more not shown`);
    out.push('');
  };
  const idea = item => `- ${line(item.title)} (${item.id})`;
  const asked = item => `- ${line(item.question)} — in ${line(item.nodeTitle)} (${item.nodeId})`;
  section('New ideas', result.ideas.added, idea);
  section('Removed ideas', result.ideas.removed, idea);
  section('Premises changed', result.ideas.premiseChanged, idea);
  section('Answers given', result.answers.given, item => `${asked(item)}: ${line(item.answer)}`);
  section('Answers changed', result.answers.changed, item => `${asked(item)}: ${line(item.answer)}`);
  section('Questions now waiting', result.questions.opened, asked);
  section('Questions closed', result.questions.closed, item => `${asked(item)} (${item.how})`);
  section('Links added', result.links.added, link => `- ${line(link.fromTitle)} ${link.type.replaceAll('_', ' ')} ${line(link.toTitle)}${link.addedBy === 'user' ? ` (added by the user${link.note ? `: ${line(link.note)}` : ''})` : ''}`);
  section('Links removed', result.links.removed, link => `- ${line(link.fromTitle)} ${link.type.replaceAll('_', ' ')} ${line(link.toTitle)}`);
  section('Findings', result.findings, item => `- ${line(item.title)} (${item.id}): ${item.changes.join(', ')}. ${line(item.summary)}`);
  if (out.length === 4) out.push('Nothing changed in ideas, answers, questions, links or findings.', '');
  const markdown = out.join('\n'), cap = 200 * 1024;
  return markdown.length > cap ? `${markdown.slice(0, cap)}\n\n_The rest is not shown: this summary is limited to 200 KB._\n` : markdown;
}

// A ref Git can take without being read as an option or splitting arguments.
const safeRef = ref => typeof ref === 'string' && ref.length >= 1 && ref.length <= 200 && !ref.startsWith('-') && /^[^\s\u0000-\u001f\u007f]+$/.test(ref);
// The map as it was committed at `ref`, read-only, or null when it did not exist there yet.
export async function mapAtCommit(folder, ref) {
  need(safeRef(ref), 'Name a commit, branch or tag, such as HEAD or main.');
  const verified = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd: folder });
  need(verified.outcome !== 'missing', 'Git is not installed, so commits cannot be read.', 503);
  need(verified.outcome !== 'failed', 'Git took too long to answer. Try again.', 503);
  need(verified.outcome === 'ok', /not a git repository/i.test(verified.stderr ?? '') ? 'This map is not inside a Git repository.' : `No commit is named ${ref}.`);
  const sha = verified.stdout.trim();
  const shown = await git(['show', `${sha}:./map.json`], { cwd: folder, maxBuffer: maxMapBytes });
  if (shown.outcome === 'exit') return { sha, map: null };
  need(shown.outcome === 'ok', 'Git could not read the map at that commit.', 503);
  let map; try { map = JSON.parse(shown.stdout); } catch {}
  need(map && Array.isArray(map.nodes), 'The map at that commit is not a readable map.');
  return { sha, map };
}
export async function changesSince(store, mapId, ref) {
  const after = await store.get(mapId);
  const { sha, map: before } = await mapAtCommit(path.dirname(store.file(mapId)), ref);
  const short = sha.slice(0, 7), named = ref.replace(/`/g, '');
  const beforeLabel = `Commit \`${short}\`${sha.startsWith(ref) ? '' : ` (\`${named}\`)`}${before ? '' : ', before this map existed'}`;
  const afterLabel = `current saved map, revision ${after.revision} (may include uncommitted changes)`;
  const result = compareMaps(before ?? { nodes: [], edges: [] }, after);
  return { before: beforeLabel, after: afterLabel, counts: countsOf(result), markdown: changesMarkdown(result, { before: beforeLabel, after: afterLabel }) };
}
