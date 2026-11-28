import path from 'node:path';
import { git } from './git.mjs';
import { maxMapBytes, readMapFile, unreadableReasons } from './map-validation.mjs';
import { isCompleted, hasFindings } from './store.mjs';
import { isWaiting, hasCurrentAnswer } from '../assets/questions.js';
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
// Where a question stands, so each change is read from one pair of states.
const questionState = question => !question ? 'absent' : question.supersededAt ? 'superseded' : question.dismissedAt ? 'dismissed'
  : hasCurrentAnswer(question) ? 'answered' : isWaiting(question) ? 'waiting' : 'later';
const open = new Set(['waiting', 'later']), setAside = new Set(['superseded', 'dismissed']);

export function compareMaps(before, after) {
  const was = byId(before.nodes), now = byId(after.nodes);
  const result = { mapTitle: after.title,
    ideas: { added: after.nodes.filter(node => !was.has(node.id)).map(ideaOf), removed: (before.nodes || []).filter(node => !now.has(node.id)).map(ideaOf),
      premiseChanged: after.nodes.filter(node => was.has(node.id) && premiseOf(was.get(node.id)) !== premiseOf(node)).map(ideaOf) },
    answers: { given: [], changed: [] }, questions: { opened: [], savedForLater: [], closed: [] }, links: { added: [], removed: [] }, findings: [] };
  for (const node of after.nodes) {
    const old = was.get(node.id), oldQuestions = byId(old?.questions);
    for (const question of node.questions) {
      const previous = oldQuestions.get(question.id), from = questionState(previous), to = questionState(question);
      if (to === 'answered' && from !== 'answered') result.answers.given.push(questionOf(node, question));
      if (to === 'answered' && from === 'answered' && previous.answer !== question.answer) result.answers.changed.push(questionOf(node, question));
      if (to === 'waiting' && from !== 'waiting') result.questions.opened.push(questionOf(node, question));
      if (to === 'later' && from !== 'later') result.questions.savedForLater.push(questionOf(node, question));
      // Closed: open at the commit and now answered or set aside, or answered then and set aside since.
      if ((open.has(from) && !open.has(to)) || (from === 'answered' && setAside.has(to))) result.questions.closed.push({ ...questionOf(node, question), how: to });
    }
    if (!old) continue;
    // A summary is a finding only once research wrote it; before that it is the premise, reported above.
    const findings = hasFindings(after, node);
    const changes = [
      findings && old.summary !== node.summary && 'summary changed', !isCompleted(before, old) && isCompleted(after, node) && 'completed',
      old.reviewState !== 'accepted' && node.reviewState === 'accepted' && 'accepted',
      !old.stale && node.stale && 'flagged for review', old.stale && !node.stale && 'no longer flagged'].filter(Boolean);
    if (changes.length) result.findings.push({ ...ideaOf(node), ...(findings ? { summary: node.summary } : {}), changes });
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
  answersGiven: result.answers.given.length, answersChanged: result.answers.changed.length, questionsOpened: result.questions.opened.length,
  questionsSavedForLater: result.questions.savedForLater.length, questionsClosed: result.questions.closed.length,
  linksAdded: result.links.added.length, linksRemoved: result.links.removed.length, findingsChanged: result.findings.length });

// The two sides as the reader sees them. A hash the user typed is not repeated after the short hash.
const typedHash = (sha, ref) => /^[0-9a-f]+$/i.test(ref) && sha.startsWith(ref.toLowerCase());
const beforeLabel = ({ sha, ref, existed }) => `Commit \`${sha.slice(0, 7)}\`${typedHash(sha, ref) ? '' : ` (${line(ref).replaceAll('~', '\\~')})`}${existed ? '' : ', before this map existed'}`;
const afterLabel = ({ revision }) => `current saved map, revision ${revision} (may include uncommitted changes)`;
const maxCharacters = 200000;
// Headed sections with node IDs. User text is escaped as the brief escapes it; each section shows at most `limit`
// entries and says how many more it leaves out, and a summary over 200,000 characters is cut between lines.
export function changesMarkdown(result, { before, after, limit = 50 }) {
  const out = [`# Changes in ${line(result.mapTitle)}`, '', `${beforeLabel(before)} → ${afterLabel(after)}`, ''];
  let sections = 0;
  const section = (title, items, render) => {
    if (!items.length) return;
    sections++; out.push(`## ${title}`, '', ...items.slice(0, limit).map(render));
    if (items.length > limit) out.push(`- ${items.length - limit} more not shown`);
    out.push('');
  };
  const idea = item => `- ${line(item.title)} (${line(item.id)})`;
  const asked = item => `- ${line(item.question)} — in ${line(item.nodeTitle)} (${line(item.nodeId)})`;
  const link = item => `- ${line(item.fromTitle)} ${line(item.type.replaceAll('_', ' '))} ${line(item.toTitle)}`;
  section('New ideas', result.ideas.added, idea);
  section('Removed ideas', result.ideas.removed, idea);
  section('Premises changed', result.ideas.premiseChanged, idea);
  section('Answers given', result.answers.given, item => `${asked(item)}: ${line(item.answer)}`);
  section('Answers changed', result.answers.changed, item => `${asked(item)}: ${line(item.answer)}`);
  section('Questions now waiting', result.questions.opened, asked);
  section('Saved for later', result.questions.savedForLater, asked);
  section('Questions closed', result.questions.closed, item => `${asked(item)} (${item.how})`);
  section('Links added', result.links.added, item => `${link(item)}${item.addedBy === 'user' ? ` (added by the user${item.note ? `: ${line(item.note)}` : ''})` : ''}`);
  section('Links removed', result.links.removed, link);
  section('Findings', result.findings, item => `- ${line(item.title)} (${line(item.id)}): ${item.changes.join(', ')}.${item.summary ? ` ${line(item.summary)}` : ''}`);
  if (!sections) out.push('Nothing changed in ideas, answers, questions, links or findings.', '');
  const markdown = out.join('\n');
  if (markdown.length <= maxCharacters) return markdown;
  const cut = markdown.lastIndexOf('\n', maxCharacters - 200), dropped = markdown.slice(cut + 1).split('\n').filter(Boolean).length;
  return `${markdown.slice(0, cut)}\n\n_${dropped} more lines are not shown: this summary is limited to 200,000 characters._\n`;
}

// A ref Git can take without being read as an option or splitting arguments.
const safeRef = ref => typeof ref === 'string' && ref.length >= 1 && ref.length <= 200 && !ref.startsWith('-') && /^[^\s\u0000-\u001f\u007f]+$/.test(ref);
// Git's words for a path the commit does not have. Anything else, such as a missing object, is a failure.
const absentPath = /does not exist in|exists on disk, but not in/;
// The map in `folder` as it was committed at `ref`, read-only and by the Store's own rules, or null when the
// commit does not have it yet. The folder's name is the map's ID.
export async function mapAtCommit(folder, ref, { binary } = {}) {
  need(safeRef(ref), 'Name a commit, branch or tag, such as HEAD or main.');
  const verified = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd: folder, binary });
  need(verified.outcome !== 'missing', 'Git is not installed, so commits cannot be read.', 503);
  need(verified.outcome !== 'failed', 'Git did not answer. Try again.', 503);
  if (verified.outcome === 'exit') {
    need(!/not a git repository/i.test(verified.stderr), 'This map is not inside a Git repository.');
    need(verified.code !== 1, `No commit is named ${ref}.`); // --quiet: an unknown name exits 1 and says nothing.
    throw new ChangesProblem('Git refused to read this repository. Run git status in the map folder to see why.', 503);
  }
  const sha = verified.stdout.trim();
  const shown = await git(['show', `${sha}:./map.json`], { cwd: folder, binary, maxBuffer: maxMapBytes, encoding: 'buffer' });
  if (shown.outcome === 'exit' && absentPath.test(shown.stderr)) return { sha, map: null };
  need(shown.outcome !== 'failed', 'Git could not read the map at that commit in time, or it is larger than 64 MiB.', 503);
  need(shown.outcome === 'ok', 'Git could not read the map at that commit.', 503);
  const { map, problem } = readMapFile(shown.stdout, path.basename(folder));
  need(!problem, `The map at that commit ${unreadableReasons[problem]}, so Explore cannot read it. Compare with another commit.`, 422);
  return { sha, map };
}
export async function changesSince(store, mapId, ref) {
  const after = await store.get(mapId);
  const { sha, map: before } = await mapAtCommit(path.dirname(store.file(mapId)), ref);
  const sides = { before: { sha, ref, existed: !!before }, after: { revision: after.revision } };
  const result = compareMaps(before ?? { nodes: [], edges: [], jobs: [] }, after);
  return { ...sides, counts: countsOf(result), markdown: changesMarkdown(result, sides) };
}
