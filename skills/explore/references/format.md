# Map format v1

Each exploration is saved in `ideas/map-<id>/` inside the working repository:

```text
map.json         canonical snapshot: knowledge, relationships, work, history, layout
README.md        generated overview with source revision and links
nodes/<id>.md    generated readable node detail with source revision
```

Shared settings for every map live beside them in `ideas/settings.json` (`{ version: 1, revision, ...fields }`). Like the maps, the file is meant to be committed.

The JSON snapshot is the only source of truth. Markdown files are readable projections and can be rebuilt by restarting the server. If a generated file's revision differs from `map.json`, treat it as stale. Do not write generated files expecting the UI to ingest the edit.

`schemaVersion` identifies the format; `revision` identifies a saved map state. Stable map/node/job IDs survive title and layout changes. The original user idea is preserved in `originalIdea`; each node's `prompt` records its current premise independently of model-generated `body` findings. Prior premises and research results remain in history/jobs.

Nodes contain `id`, `title`, `kind`, `parentId`, `prompt`, `summary`, `body`, `status`, `reviewState`, `contentRevision`, `questions`, `sources`, and `stale`. Questions retain answers and answer timestamps. A question from a changed premise optionally records `supersededAt`; its actual answer remains unchanged as history, and unanswered earlier questions no longer require an answer. Sources retain an HTTP(S) URL, descriptive title, the supported/challenged proposition, and retrieval timestamp.

- Work states: `suggested`, `queued`, `running`, `awaiting-answer`, `explored`, `interrupted`.
- `explored` is terminal for that branch. New terminal results record optional `completedAt`; older snapshots infer completion from explored state or a successful terminal job. A changed-premise child optionally records `revises` referencing its earlier investigation. These additive fields do not change schema version 1. Public responses expose derived `completed` for UI behavior.
- Review states: `unreviewed`, `accepted`. Staleness is separate from review; a previously accepted finding can need review after a premise changes.
- Attribution: an answer optionally records `answeredBy: { name }` and an accepted node `acceptedBy: { name }`, using the Git name (`git config user.name`) of the person running the server. The email is never read. Without a Git name nothing extra is recorded and `acceptedBy` keeps its older value `'user'`. Names are labels, not logins, and never appear in work packets or briefs.
- Graph edges: `contains`, `depends_on`, `supports`, `contradicts`, `related_to`. A visual parent is not an evidence relationship. Dependency links inform context and staleness; they do not automatically activate/schedule other nodes.
- Jobs retain their input-context fingerprint, visible results, worker name, timing and packet character count. A late result whose relevant context changed is retained for review instead of replacing the current premise.
- A job's optional `type` names its kind of work; a missing type means `investigate`, the branch investigation, so older maps behave unchanged. Only investigations change an idea's status, findings, questions, completion or growth history. Other types keep their result on the job record. Work covering the whole map has `nodeId: null`; work about one question records it as `subjectId`.
- `view.positions` is presentation state. A layout change does not alter content fingerprints.

The server serializes mutations and writes/syncs a temporary snapshot before replacing `map.json`. Interrupted temporary files are not read as committed snapshots. One server writes a workspace; people share maps by committing and pulling them, not by writing the same files at once. This is not a guarantee against every filesystem/power-loss failure. Generated Markdown is not part of the authoritative transaction.

## Changes from outside Explore

Maps are shared through Git, so `map.json` can change underneath a running server, for example after `git pull` or a branch switch. The server remembers a SHA-256 `fingerprint` of the exact bytes it last wrote or adopted for each map. A map's next read adopts what is on disk, even an older revision, and reports `outsideChange: { at, preserved, inGit }`. The first read after the server starts adopts silently. The version that was replaced is kept: if Git does not already have those exact bytes, they are copied to `ideas/<map-id>/preserved/<time>-<fingerprint>.json`, once per version; ordinary pulls of committed work add no files.

An edit made from the replaced version is refused with code `changed-outside` and writes nothing, even when the revision numbers match. The browser sends the `expectedFingerprint` of the version it shows. Every save also checks that the file is still the version the change was based on.

A map that cannot be read is listed as `{ id, unreadable: true, problem }`, where `problem` is `conflict-markers`, `invalid-json`, `unsupported-version` or `invalid-map` (missing parts, or a file copied from another map's folder). It is never rewritten, the other maps still open, and errors never quote its contents. Fix the file, for example by resolving the Git conflict, and it opens again.

## Growth history

Optional schema-1 `growth: { version: 1, batches: [...] }` records graph additions. Each batch has a strictly increasing `sequence`, an ISO `at` timestamp, `nodeIds`, and `edges` containing `{ from, to, type }` identities. One graph-adding transaction produces one batch, including an edge-only result; its new nodes and edges share that timestamp in `createdAt`. Sequence preserves transaction order when timestamps tie or the clock moves backward. Duplicate suggestions, connections and result deliveries do not add duplicate history. The ledger and graph commit in the same canonical snapshot. Work changes, answers, findings, review and layout do not create growth batches, and routine context packets omit the ledger.

The browser's shared `history.js` provides pure `growthTimeline(map)` and `mapAtGrowthStep(map, index)` functions. Steps contain cumulative node IDs/counts and connection counts, the additions at that boundary, `at`, and `kind` (`recorded`, `dated`, or `unknown`). The first step is the earliest available addition group, and `latestStep` is the final index (`-1` for an empty graph). Projection returns a detached copy, filtering only graph membership. It uses **today's findings, statuses and layout**, and does not reconstruct historical content or work states. Browsing is read-only and never queues work or changes the saved view.

Older maps are readable without migration or writes. Their available `createdAt` dates form deterministic date groups before recorded batches; equal dates form one group. Missing or invalid dates remain unknown. An undated connection is never assigned its endpoints' dates. Unknown additions appear in a final explicitly undated step, which does not assert when they happened. Connections with dates inconsistent with their endpoints also appear in that step; no connection appears before both endpoints. `incomplete`, `unknownNodeCount`, and `unknownEdgeCount` expose these limits. This is a view of known additions, not a claim to exact historical snapshots. First recording a new batch leaves legacy timestamps and connections untouched.

## Version history

Each saved content change is also kept as a version, so anyone who pulls can preview, undo and restore. Versions live in `ideas/<map-id>/versions/` and are committed with the map. Each is one standalone file named `<UTC time>-<6 hex>.json`, holding `{ format: "explore-version", version: 1, mapId, revision, at, author?, labels, name?, contentHash, map }`, where `map` is the full snapshot without claim data (`claimKey`, `claimHash`, `inputSignature`). There is no index file: the list comes from scanning the folder, so two people's versions merge in Git as separate files without conflicts, and the file name is the version's identity.

- Recording: the version is written just after `map.json` is replaced, inside the same lock, so no version ever shows content that was not saved; if the process stops in between, that one change has no version. `labels` are the event types of that change, and `author` is the contributor's Git name when known. Moving ideas, claiming work and restart bookkeeping (`started`, `interrupted`) are not versions. A snapshot identical to the newest version is not written again. If recording fails the map is still saved and the failure is reported.
- Retention: every named version and every imported copy (`kept: true`), plus the 50 newest others, with unnamed versions capped at 16 MiB per map; the newest is always kept. At most 10 names, 1–120 characters, unique per map. Pruning removes files from the folder; committed versions remain in Git history.
- Restore (`restore-version` with `version`, user-only) replaces the title, original idea, ideas, connections and jobs with the version's. It keeps the event log and growth history, which only grow, and today's positions for ideas that still exist. It is refused while work is queued or running and when the map already matches. Work that was active in that version comes back `interrupted`, so an old claim cannot deliver into the restored map, and nothing starts until the user retries. A restore can reopen a finished branch; the preview lists every such branch. The restore is itself a new revision and version, so it can be undone. The browser's Undo is a restore of the version before the user's latest change, sent with `undo: true` and recorded as `change-undone`.
- When a pull or branch switch replaces `map.json`, the replaced content is recorded as a version labelled `before-outside-change`, unless version history or Git already has it. Copies kept in `ideas/<map-id>/preserved/` before version history existed are imported as versions labelled `preserved`, with their original time, when the server starts; the folder is removed only once every copy is in version history. A damaged version, or one saved by a newer Explore format, is refused rather than restored.
- Versions can contain earlier wording of answers the user later rewrote. Maps saved before this feature have no earlier versions; the list reports `earlierMissing`.

Machine-local connection tokens, process locks, result drafts, and claim-delivery files live under `.explore/`, which should be ignored by Git. Settings are not machine-local; they live in `ideas/settings.json`. No model API key is part of a map. A provider's original chat history or conversation ID is not necessary to read/continue the map. Share saved maps deliberately: they contain the user's actual ideas and answers.

## Reading procedure

Read the map overview, then the selected node and related evidence. Check status and staleness before treating a finding as accepted knowledge. Prefer the CLI's bounded section reads with question IDs or a query, continuing only necessary pages at the same revision. Linked node Markdown remains a fallback; avoid loading a long history to answer one targeted question. Never load the whole snapshot merely to resume an investigation.
