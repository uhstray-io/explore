// One registry for the kinds of agent work, the Store actions that need no idea,
// and the shared settings fields. Feature issues register their own entries here
// so features built in parallel share one design.
//
// Job types
//   investigate (built in): today's branch investigation. A job without `type` is one.
//     It is the only type that may change an idea's status, findings, questions,
//     completion or growth history.
//   Other types: { label, target: 'node' | 'map', packet(context), validate(result, context) }
//     packet  returns the type-specific fields of the work packet, including `instruction`.
//     validate returns the normalized result kept on the job record, or throws a Problem.
//     context is { map, job, node } (node is null for map-level jobs).
//     isStale(context), optional, decides whether a result is stale when it arrives. With `recheck: true` it is
//     asked again whenever the map is shown, so a delivered result can become stale later.
//     A map-level job has `nodeId: null`.
//     Optional: release({ map, job }) when work stops without a result, and beforeSave(map) to keep the type's own
//     invariants before every save.
//
// Actions: { target: 'node' | 'map', apply({ map, node, input, store }) }
//   Store.action skips the idea lookup only for map-level actions. Every action still
//   needs `expectedRevision` and runs through the Store's serial queue.
//
// Settings fields: { default, validate(value) } stored in the shared `ideas/settings.json`.
import { mapJobTypes, mapJobActions } from './map-jobs.mjs';
import { questionJobTypes, questionActions } from './question-actions.mjs';
import { restartActions } from './restart.mjs';
import { branchRestoreActions } from './branch-restore.mjs';
import { libraryActions } from './library.mjs';
import { linkActions } from './links.mjs';
import { listenSetting } from '../assets/listening.js';

export const INVESTIGATE = 'investigate';

const builtInJobTypes = { [INVESTIGATE]: { label: 'Branch investigation', target: 'node' } };
// How long an agent keeps listening for work (K1): every server reports it, so every registry has it.
const builtInSettings = { listenMinutes: listenSetting };
// Store.action handles these itself; a registry entry may not replace them.
const builtInActions = new Set(['activate', 'answer', 'suggest', 'cancel', 'cancel-job', 'accept', 'revise', 'fork-revision', 'position', 'restore-version', 'name-version', 'unname-version', 'change-answer', 'reaffirm', 'clear-finding']);
const targets = new Set(['node', 'map']);

export function createRegistry({ jobTypes = {}, actions = {}, settings = {} } = {}) {
  for (const [type, definition] of Object.entries(jobTypes)) {
    if (type === INVESTIGATE) throw new Error('The investigate job type is built in.');
    if (!targets.has(definition.target) || typeof definition.packet !== 'function' || typeof definition.validate !== 'function' || !definition.label)
      throw new Error(`Job type ${type} needs a label, a target of node or map, and packet and validate functions.`);
  }
  for (const [type, definition] of Object.entries(actions)) {
    if (builtInActions.has(type)) throw new Error(`The ${type} action is built in.`);
    if (!targets.has(definition.target) || typeof definition.apply !== 'function') throw new Error(`Action ${type} needs a target of node or map and an apply function.`);
  }
  for (const [key, field] of Object.entries(settings)) {
    if (Object.hasOwn(builtInSettings, key)) throw new Error(`The ${key} setting is built in.`);
    if (['version', 'revision', 'expectedRevision', 'unreadable'].includes(key) || typeof field.validate !== 'function' || !('default' in field))
      throw new Error(`Setting ${key} needs a default and a validate function, and may not reuse a reserved name.`);
  }
  return { jobTypes: { ...builtInJobTypes, ...jobTypes }, actions: { ...actions }, settings: { ...builtInSettings, ...settings } };
}

// Map-wide reviews such as Check answers are part of every default registry.
export const defaultRegistry = createRegistry({ jobTypes: { ...mapJobTypes, ...questionJobTypes }, actions: { ...mapJobActions, ...questionActions, ...restartActions, ...branchRestoreActions, ...linkActions, ...libraryActions } });

export function jobTypeOf(job) { return job.type || INVESTIGATE; }
export function isInvestigation(job) { return jobTypeOf(job) === INVESTIGATE; }
