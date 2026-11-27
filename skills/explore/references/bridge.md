# Local agent bridge

All commands accept `--workspace <absolute working directory>`. A Git repository is optional. Resolve scripts from the skill directory, including when installed in another project. Requires Node 20+. The server binds only `127.0.0.1`; credentials for model providers are neither requested nor stored.

```text
node scripts/server.mjs --workspace <repo> [--port 4317]
node scripts/cli.mjs doctor --workspace <repo>
node scripts/cli.mjs status --workspace <repo>
node scripts/cli.mjs maps --query "distinctive words" --workspace <repo>
node scripts/cli.mjs maps --offset <nextOffset> --revision <revision> --workspace <repo>
node scripts/cli.mjs create --file <idea.json> --workspace <repo>
node scripts/cli.mjs next --wait 25 --worker codex --workspace <repo>
node scripts/cli.mjs result --job <job-id> --file <result.json> --workspace <repo>
node scripts/cli.mjs fail --job <job-id> --reason "What prevented completion" --workspace <repo>
node scripts/cli.mjs read --map <map-id> [--node <node-id>] --workspace <repo>
node scripts/cli.mjs read --map <map-id> --query "unresolved issue" --limit 20 --workspace <repo>
node scripts/cli.mjs read --map <map-id> --offset <nextOffset> --revision <revision> --workspace <repo>
node scripts/cli.mjs read --map <map-id> --node <node-id> --section questions --query "early constraint" --workspace <repo>
node scripts/cli.mjs read --map <map-id> --node <node-id> --section findings --offset <nextOffset> --revision <revision> --workspace <repo>
node scripts/cli.mjs brief --map <map-id> [--node <node-id>] [--format markdown] --workspace <repo>
node scripts/cli.mjs usage [--map <map-id>] --workspace <repo>
node scripts/cli.mjs act --map <map-id> --file <action.json> --workspace <repo>
```

Use JSON files for multiline text. Do not interpolate user content into a shell command. Keep claim files in `.explore/claims`; the CLI saves and uses claim keys automatically. Never send runtime tokens to the user or include them in prompts. A `result` delivery retry is idempotent after success.

## First use and reconnection

`doctor` is read-only and needs no active server. It reports the Node runtime, actual skill path, required package files, workspace path, saved-map count, connection state, and local process-lock state. Its `start` object supplies an executable and argument array, including absolute paths and `--port 0`; pass these as separate arguments through the host's process tools. Quote paths according to the actual shell when using a command line. Do not paste an array as a shell command or assume the current directory is the skill installation.

On a fresh workspace, `not-started` is normal. Start the server persistently, then rerun doctor. For an existing server, `ready` means the authenticated local API answered; it does not mean an agent is listening or that a model provider was tested. `bridge.listening` reports recent CLI polling, and `bridge.scopes` identifies the maps those listeners serve. A scope with `mapId: null` serves every map; a named map scope does not serve another map's queue. Presence expires after 40 seconds without polling. `doctor` returns structured diagnostics even when `ready` is false; inspect the fields rather than treating exit status alone as success.

A workspace used before the rename to Explore may contain a `.grill-my-mind` folder; it is no longer read. A copied or moved workspace may contain obsolete `.explore` connection/lock files. Doctor validates the recorded workspace and loopback address before sending credentials, reports the problem, and does not alter those files or stop processes. Inspect the owning server before resolving a stale lock; a recorded PID can have been reused. Start the server for the workspace's current location, then use `maps`/`brief` to resume saved ideas. Missing skill assets require restoring the complete package. Connection failure does not justify replacing saved maps or installing provider credentials.

To create a map, the input file is `{ "title": "Short name", "idea": "The user's idea in their own terms" }`. Creating it queues an initial exploration because the user asked to explore that idea. Other branches only queue after user activation.

## Result format

```json
{
  "summary": "A concise account of this branch's current understanding.",
  "body": "Detailed findings, reasons, alternatives, and uncertainties in readable Markdown.",
  "questions": ["One question that genuinely needs the user's answer"],
  "suggestions": [
    {"title": "A direction worth exploring", "body": "Why it matters and what we would investigate", "kind": "research"}
  ],
  "sources": [
    {"title": "Source title", "url": "https://example.org/source", "note": "The specific claim this source supports or challenges"}
  ],
  "links": [
    {"to": "an-existing-node-id", "type": "depends_on"}
  ]
}
```

This format is for `jobType: "investigate"`, the branch investigation. Other job types are described below.

`summary` and `body` are required. Omit unused arrays. The example URL and ID are illustrative; real results require actual consulted sources and existing node IDs. Do not cite a source you have not read.

Limits: summary 800 characters; body 24,000; at most 5 questions, 8 suggestions, 20 sources, 12 links. Suggestion kinds: `research`, `question`, `decision`, `risk`, `idea`. Link types: `depends_on`, `supports`, `contradicts`, `related_to`. `contains` is created by the server for suggested children. All results remain unreviewed until the user accepts them.

## Other kinds of work

Every packet from `next` carries `jobType`. `investigate` is the branch investigation above; a job saved without a `type` is one. Other types are registered in `scripts/job-types.mjs` by the features that need them. Each such packet carries `mapId`, `jobId`, `jobType`, `reason` and `instruction`, plus the type's own fields. Follow its `instruction`, then deliver the result it describes with the same `result --job ID --file result.json` command, or use `fail`. The result is kept on the job record. It never changes the idea's status, findings, questions or completion, and it never accepts anything for the user. If the idea or its context changed while the work ran, the result is kept but marked `stale`.

Some work covers the whole map rather than one idea. Its job has `nodeId: null`, and its packet names the map only. Work about one question of an idea records that question as `subjectId`. A repeat request for the same type, idea (or map) and subject reuses the open job. A job type this version of Explore does not know stays queued for a newer version. A job whose idea no longer exists fails with that reason.

## Mutations

An action carries `expectedRevision` and `type`, plus `nodeId` unless the action covers the whole map. Use the current revision returned by `read`. On a conflict, re-read before deciding whether the action still applies; do not blindly overwrite. Map-level actions still need `expectedRevision` and run one at a time like every other action.

If someone pulled or switched branches since you last read the map, an action fails with code `changed-outside` and changes nothing. Read the map again, check the action still makes sense against the new content, then retry. A result normally goes into the map as it now is, as long as its job is still running there. If a pull lands at the very moment of delivery, `result` fails with `changed-outside`; the CLI keeps the claim, so run the same `result` command again. Maps listed with `unreadable: true` cannot be read or changed until the user fixes the file; `next` skips them. See [the map format](format.md) for how outside changes are adopted and kept.

- `activate`: queue a suggested branch or retry unfinished work. Completed branches reject activation. Only on the user's explicit request, normally via the UI.
- `answer`: `questionId`, `answer`, optional `answerState` (`tentative` by default, `decided` or `assumption`; all need text). Supply only an actual user answer. Questions superseded by a changed premise remain in history and reject new answers. Answering a question saved for later clears that.
- `set-answer-state`: `questionId`, `answerState`. Changes how sure a saved, current answer is. It is an annotation: allowed on finished branches, and it never re-runs research, flags findings or changes content. User-only.
- `answer-later`: `questionId`. Saves an open question for later on an unfinished branch: it stays answerable but no longer pauses the branch, which continues once nothing else blocks it. User-only; never defer a question on the user's behalf.
- `suggest`: `title`, `body`. Adds an inactive research direction.
- `revise`: `body`. Revises unfinished work and marks dependent findings for review. Questions and actual answers from earlier premises are retained with `supersededAt`; unanswered earlier questions no longer block continuation. Retry explicitly to investigate the new premise. Completed branches reject direct revision.
- `fork-revision`: `body`, optional `title`. For a completed branch, create an inactive child with the changed premise. Preserve the original premise, findings, evidence, and review history; flag affected findings for review. Activate the child separately. The child records `revises` pointing to its earlier investigation.
- `accept`: user accepts a current finding. Never self-accept a model conclusion.
- `restore-version`, `name-version`, `unname-version`: user-only, no `nodeId`. Version history belongs to the user; an agent never restores or names a version, even when asked indirectly. Work packets, briefs and `read` always use the current map, not a version.
- `cancel`: stops queued work or rejects subsequent results from the claimed run. The agent should also stop its actual investigation; this API cannot kill host-owned subagents.
- `position`: `x`, `y`. Presentation only.
- `cancel-job`: `jobId`, no `nodeId`. Stops queued or running work that is not a branch investigation. Use `cancel` for a branch.

## Shared settings

Settings live in `ideas/settings.json` beside the maps and are meant to be committed, so everyone who opens the repo gets the same experience. The file is `{ "version": 1, "revision": N, ...fields }`. Each feature registers its own fields with a default and validation. A save names at least one field; unknown fields are rejected, and fields this version does not know are kept. The browser reads them with authenticated `GET /api/settings` and saves them with `POST /api/settings` carrying `expectedRevision`. A missing file means defaults. An unreadable one, for example with Git conflict markers, falls back to defaults with `unreadable: true` and is replaced only when the user saves. A file in a newer format falls back to defaults with `newer: true` and is never overwritten; update Explore to change it. Settings are the user's choice: never change them unless the user asks.

## Bounded discovery and reading

`maps` lists saved maps; `status` adds the local address and bridge state to the first map page. `--query TEXT` searches map titles and IDs case-insensitively. `read --map ID` lists node summaries and searches node IDs, titles, premises, summaries, and findings. Search does not expose the entire matching body. Both default to 20 entries and accept `--limit 1–40`, `--offset N`, and `--revision REV`. They return `total`, `matching`, `offset`, and `nextOffset` (`null` at the end). An empty search is explicit. Node summaries include staleness and review state; a summary is not necessarily a verified finding.

For continuation, retain the query and pass both `nextOffset` and `revision`. Map discovery uses an opaque catalog revision; node discovery uses the map's revision. If either changed, restart the targeted search at offset 0. Thus nodes after the first 40 remain discoverable without repeatedly loading a complete map into the agent's context. The CLI currently fetches the full list/snapshot internally from the local server and bounds its output; this is a model-context bound, not a streaming-storage implementation.

`read --node ID` defaults to a bounded summary. Add `--section premise|findings|questions|sources|relationships` for detail. `--query TEXT` filters records case-insensitively; `--question ID` selects one question record. Question IDs appear in work packets. Findings/premise are single text records; query filters the record rather than extracting surrounding sentences.

Each section response includes `excerpt`, work/review state, staleness, total/matching record counts, `totalCharacters`, `offset`, `nextOffset`, and `revision`. Summary and findings reads also identify `contentKind` as `findings` or `premise`; an unfinished branch can contain a revised premise before it has new research. Question reads label superseded records as belonging to earlier premises and preserve any actual answer; unanswered superseded questions are not awaiting the user. Default raw-text limit is 4,000 characters; `--limit` accepts 1–6,000. Formatted JSON is capped at 8,000 characters even with escaped text. Continue only if needed, passing `--offset <nextOffset> --revision <revision>` with the same section/query/question. A changed map rejects continuation, preventing silent mixing of versions. Offsets count JavaScript UTF-16 code units, not UTF-8 bytes or model tokens.

Successful CLI commands append content-free counts to `.explore/context-usage.jsonl`. `usage [--map ID]` sums recorded stdout characters and UTF-8 bytes, including formatting and its newline, by command. It excludes its own reports, failed commands, direct file reads, browser observations, research tools, model replies, and host compaction. It does not measure vendor token use or active context. No credentials or excerpts are stored in the log.

`brief --map ID` returns a bounded extraction of the saved map's findings, answers, open questions, review state, stale material, directions, work states, and relationships. This includes partial findings while a branch waits for an answer. A revised premise without a current result appears separately from findings; superseded questions and actual answers appear as records of previous premises. `--node ID` narrows it to that branch. Each section identifies its source nodes and omitted items; use targeted reads when a detail matters. The default JSON omits the duplicate Markdown representation; `--format markdown` prints the readable version instead. Neither form runs research, accepts conclusions, nor changes a map. These are saved statements, not a newly verified synthesis. Brief output, including Markdown, is counted exactly by `usage`.

`doctor` and `usage` also work while the server is stopped. Neither creates the runtime directory nor adds its own output to the usage log. Work packets target fewer than 16,000 characters and node section responses are bounded as above; these limits do not measure total host context or vendor token costs.

No additional provider connection is required to open a saved map. Existing format-1 snapshots remain readable. On restart, historical repeat jobs on already completed branches are cancelled while stored content and job history are retained; unfinished investigations remain retryable.

## Process lifetime

The server lives independently of a worker's research result. The browser polls only for changed map revisions; this does not call an LLM. `next` waits at most 25 seconds and returns a small idle response. The user can keep the app open after the agent session ends, but new research stays queued until an agent starts listening again.

On server restart, running jobs become interrupted and require an explicit retry. A running server's stale host-owned job can be stopped/retried from the UI. There is no automatic timeout-based paid retry.

During this MVP, individual UI activations within the selected map are executed serially by the main agent unless the host agent deliberately delegates bounded investigations. Parallel-result persistence is supported; a pool of autonomous provider workers is not implemented.
