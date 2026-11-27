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

If the user wants to report a problem, `doctor --support [--out FILE]` produces a redacted report built from an allowlist: setup state, checks, counts and versions, never map content, paths, names, tokens or process IDs. Do not paste the plain `doctor` output into a public issue.

On a fresh workspace, `not-started` is normal. Start the server persistently, then rerun doctor. For an existing server, `ready` means the authenticated local API answered; it does not mean an agent is listening or that a model provider was tested. `bridge.listening` reports recent CLI polling, and `bridge.scopes` identifies the maps those listeners serve. A scope with `mapId: null` serves every map; a named map scope does not serve another map's queue. Presence expires after 40 seconds without polling. `doctor` returns structured diagnostics even when `ready` is false; inspect the fields rather than treating exit status alone as success.

A workspace used before the rename to Explore may contain a `.grill-my-mind` folder; it is no longer read. A copied or moved workspace may contain obsolete `.explore` connection/lock files. Doctor validates the recorded workspace and loopback address before sending credentials, reports the problem, and does not alter those files or stop processes. Inspect the owning server before resolving a stale lock; a recorded PID can have been reused. Start the server for the workspace's current location, then use `maps`/`brief` to resume saved ideas. Missing skill assets require restoring the complete package. Connection failure does not justify replacing saved maps or installing provider credentials.

To create a map, the input file is `{ "title": "Short name", "idea": "The user's idea in their own terms" }`. Creating it queues an initial exploration because the user asked to explore that idea. Other branches only queue after user activation.

## Result format

```json
{
  "summary": "A concise account of this branch's current understanding.",
  "body": "Detailed findings, reasons, alternatives, and uncertainties in readable Markdown.",
  "questions": [
    {"text": "One question that genuinely needs the user's answer", "importance": "high", "why": "What the answer would change for this branch"}
  ],
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

When the branch is really a choice, a result can also compare options and recommend one. All of these are optional and need each other:

```json
{
  "options": [
    {"id": "hands-on", "title": "Hands-on session", "description": "What it involves.", "fit": "When it is the better choice.", "pros": ["…"], "cons": ["…"], "suggestedAnswer": "A first-person draft the user may adopt."}
  ],
  "optionsLimit": "Only with exactly one option: why there is no real alternative.",
  "recommendation": {"optionId": "hands-on", "rationale": "Why.", "mainTradeoff": "What it costs.", "reconsiderIf": "What would change it."}
}
```

Give 1–4 options with unique `id`s (a letter, then letters, digits, `_` or `-`; at most 32) and titles that differ. Limits: title 150, description 600, fit 400, at most 4 pros and 4 cons of 240 each, suggested answer 1,000. With options, a recommendation is required: an existing `optionId` with `rationale` (800) and `mainTradeoff` (600), and optionally `reconsiderIf` (600); or `optionId: null` with `missing` (600), which is "No recommendation yet". A current result replaces the idea's options; a result without options clears them. The whole result must stay under 150,000 characters.

`summary` and `body` are required. Omit unused arrays. The example URL and ID are illustrative; real results require actual consulted sources and existing node IDs. Do not cite a source you have not read.

Limits: summary 800 characters; body 24,000; at most 5 questions, 8 suggestions, 20 sources, 12 links. A question is a string or `{text, importance, why}`: `importance` is `low`, `medium` or `high` and needs a `why` (at most 600 characters) saying what the answer would change; `why` may also stand alone. A missing `why` for a rated question, or any other importance value, rejects the whole result so you can resend it. Suggestion kinds: `research`, `question`, `decision`, `risk`, `idea`. Link types: `depends_on`, `supports`, `contradicts`, `related_to`. `contains` is created by the server for suggested children. All results remain unreviewed until the user accepts them.

## Other kinds of work

Every packet from `next` carries `jobType`. `investigate` is the branch investigation above; a job saved without a `type` is one. Other types are registered in `scripts/job-types.mjs` by the features that need them. Each such packet carries `mapId`, `jobId`, `jobType`, `reason` and `instruction`, plus the type's own fields. Follow its `instruction`, then deliver the result it describes with the same `result --job ID --file result.json` command, or use `fail`. The result is kept on the job record. It never changes the idea's status, findings, questions or completion, and it never accepts anything for the user. If the idea or its context changed while the work ran, the result is kept but marked `stale`.

Some work covers the whole map rather than one idea. Its job has `nodeId: null`, and its packet names the map only. Work about one question of an idea records that question as `subjectId`. A repeat request for the same type, idea (or map) and subject reuses the open job. A job type this version of Explore does not know stays queued for a newer version. A job whose idea no longer exists fails with that reason.

## Explaining a question

A `question-help` packet carries the open `question` (`id`, `text`), its idea (`node`: `id`, `title`, `premise`, `summary`) and the `ancestors` up to the root (nearest first; the farthest are dropped first if the packet would be too long, counted in `omittedAncestors`). Explain what the question asks and why it matters, define unfamiliar terms, and give one illustrative example. Never answer it or recommend an answer. Return `{"help": "…"}` (at most 3,000 characters) and nothing else. The help stays on the job and is shown under the question as "Help from your agent, not an answer"; it never fills in the answer. Help that arrives after the question was answered, set aside or reworded is kept as stale and not shown. The user asks for it with `request-help` (`questionId`); never request it on their behalf.

## Researching a question

A `question-research` packet carries the `question` (`id`, `text`, its `why` when given, and `currentAnswer` when the user already answered it), its idea (`node`: `id`, `title`, `premise`, `summary`, `findings`, `status`, `reviewState`, `stale`, and the user's other `answers` there with how sure each is), the same nearby ideas an investigation reads (`context`: the original idea first, then nearest first, each with its review state and latest answers; the farthest are left out first when the packet would be too long, counted in `omittedContext`) and a `retrieval` hint. Research the question so the user can answer it, then return options and a recommendation in the options format above, plus an optional `summary` (800 characters) and `sources` (as in results, at most 20):

```json
{
  "options": [{"id": "merge", "title": "Merge edits automatically", "description": "…", "fit": "…", "pros": ["…"], "cons": ["…"], "suggestedAnswer": "A first-person draft the user may copy."}],
  "optionsLimit": "Only with exactly one option.",
  "recommendation": {"optionId": "merge", "rationale": "…", "mainTradeoff": "…"},
  "summary": "Optional overview.",
  "sources": [{"title": "…", "url": "https://…", "note": "What it showed."}]
}
```

Options and a recommendation are required; when the evidence does not settle it, use `"optionId": null` with `missing`. Any other field, including `questions`, `suggestions`, `links`, `body` or an `answer`, rejects the result. The research stays on the job: it never answers the question, never changes the idea's findings, options or status, and never completes the branch. It is shown under the question as "Research from your agent, not your answer", where the user may copy a suggested answer into their own draft. Research is earlier research, with nothing to copy, once the question is set aside or the premise or an answer nearby changes, whether that happens while you work or later. The user asks for it with `request-research` (`questionId`); never request it on their behalf.

## Regenerating a question

A `regenerate-question` packet carries the `question` to replace, the user's `userReason`, the idea (`node`), its `answeredQuestions` and `openQuestions`, and the map's `questionFeedback`. Return `{"question": {"text": "…", "importance": "…", "why": "…"}}` (text at most 1,600 characters; importance and why are optional, as in results): one question that serves the same purpose better, never the original or a dismissed one, and never its answer. It is added beside the original, linked by `replaces` and `replacedBy`. A replacement for a question that is no longer waiting is kept as stale and not added.

Every investigation packet carries `questionFeedback`: up to 10 of the map's most recent questions the user rated, dismissed or replaced, with any reason (trimmed first when the packet is over budget), and `selected.dismissedQuestions`, which are never to be asked again.

## Map jobs: Check answers

A map job reads across many saved answers instead of one branch. Only the user starts one, from the browser's Map tools; an agent never requests a map job, as it never activates a branch. `next` returns it with `jobType: "check-answers"`, `nodeId: null` and:

- `records`: the original idea, then every current answer (with its question, idea title, certainty, work and review state, staleness) and open question, root first. A user may have narrowed the check to chosen answers.
- `omittedRecords`: IDs left out, with the reason (`earlier premise`, or `over the packet budget`).
- `resultFormat` and `instruction`.

Deliver with the same `result --job ID --file result.json`:

```json
{
  "summary": "Optional overview.",
  "findings": [
    {"category": "possible-tension", "explanation": "What does not fit together.", "resolution": "What would settle it.", "refs": [{"nodeId": "…", "questionId": "…"}]}
  ]
}
```

Categories: `possible-tension`, `unresolved-choice`, `untested-assumption`. At most 12 findings; text up to 1,000 characters; each finding cites 1–8 records from `records`. An empty list is a valid result. Report what you notice between saved statements; never call an answer wrong or answer for the user. The result becomes a proposal: each point waits for the user to keep or dismiss it, and nothing in the map changes. A tension that rests on an answer the user has not marked Decided is shown as an unresolved choice. A check whose answers changed meanwhile is marked stale. `GET /api/maps/ID/job-preview?type=check-answers` shows the packet without starting anything.

## Mutations

An action carries `expectedRevision` and `type`, plus `nodeId` unless the action covers the whole map. Use the current revision returned by `read`. On a conflict, re-read before deciding whether the action still applies; do not blindly overwrite. Map-level actions still need `expectedRevision` and run one at a time like every other action.

If someone pulled or switched branches since you last read the map, an action fails with code `changed-outside` and changes nothing. Read the map again, check the action still makes sense against the new content, then retry. A result normally goes into the map as it now is, as long as its job is still running there. If a pull lands at the very moment of delivery, `result` fails with `changed-outside`; the CLI keeps the claim, so run the same `result` command again. Maps listed with `unreadable: true` cannot be read or changed until the user fixes the file; `next` skips them. See [the map format](format.md) for how outside changes are adopted and kept.

- `activate`: queue a suggested branch or retry unfinished work. Completed branches reject activation. Only on the user's explicit request, normally via the UI.
- `answer`: `questionId`, `answer`, optional `answerState` (`tentative` by default, `decided` or `assumption`; all need text). Supply only an actual user answer. Questions superseded by a changed premise remain in history and reject new answers. Answering a question saved for later clears that.
- `set-answer-state`: `questionId`, `answerState`. Changes how sure a saved, current answer is. It is an annotation: allowed on finished branches, and it never re-runs research, flags findings or changes content. User-only.
- `rate-question`: `questionId`, `rating` (`good`, `bad` or `null` to clear), optional `reason` (600). Feedback, not content: allowed on answered questions and finished branches, never re-runs research. User-only; an agent never rates.
- `dismiss-question`: `questionId`. Sets an open question aside on an unfinished branch; it then rejects answers. When nothing else blocks, the branch continues. `restore-question` brings it back while the branch is waiting for answers. User-only.
- `regenerate-question`: `questionId`, optional `reason`. Sets the question aside and queues a `regenerate-question` job; the branch waits for the replacement. If that job fails, is stopped or is interrupted, the original question comes back. User-only.
- `answer-later`: `questionId`. Saves an open question for later on an unfinished branch: it stays answerable but no longer pauses the branch, which continues once nothing else blocks it. User-only; never defer a question on the user's behalf.
- `suggest`: `title`, `body`. Adds an inactive research direction.
- `revise`: `body`. Revises unfinished work and marks dependent findings for review. Questions and actual answers from earlier premises are retained with `supersededAt`; unanswered earlier questions no longer block continuation. Retry explicitly to investigate the new premise. Completed branches reject direct revision.
- `fork-revision`: `body`, optional `title`; or `questionId` and `answer` for a changed answer. For a completed branch, create a child with the changed premise or answer. Preserve the original premise, answers, findings, evidence, and review history; flag affected findings for review. The child records `revises`, and `revisesAnswer: { questionId, previousAnswer, answer }` for a changed answer. The browser sends `start: true` so the child is queued at once, because the user choosing to explore it is the go-ahead. Agents never set `start`; without it the child stays inactive until the user activates it.
- `change-answer`: `questionId`, `answer`, optional `answerState` and `rerun`. User-only, on an unfinished branch. The old answer is kept in `previousAnswers`; findings on this branch that relied on it, and those below it or depending on it, are flagged for review (their questions stay); follow-up questions asked after the old answer are superseded; and the branch continues from the new answer when nothing else blocks it. `rerun: false` is a wording fix that changes only the text and history. A finished branch rejects it: use `fork-revision` with `questionId` instead.
- `restart-branch`: `questionId`, `answer`, `previewHash`, optional `answerState`. User-only: the agent never restarts a branch, even when asked indirectly. On a finished branch, the browser first reads `GET /api/maps/:id/restart-preview?node=N&question=Q[&offset&limit]`, which writes nothing and lists the ideas below N to delete (paged), later questions to set aside, outside findings to flag, links removed, the checkpoint name and a `hash`. The action is refused when that hash no longer matches, the answer is unchanged, or work in the branch is queued or running. It saves a named checkpoint version first (stopping with the map unchanged if it cannot), then deletes the ideas below N with their work, positions and links, flags outside findings that relied on them, gives N the new answer, sets aside later questions, clears N's findings back to its premise, and queues N again.
- `accept`: user accepts a current finding. Never self-accept a model conclusion.
- `reaffirm` ("Still holds") and `clear-finding` ("No longer relevant"): user-only, on a finding flagged for review. Reaffirm removes the flag and keeps the finding as it was (an accepted one is accepted and current again). Clear marks it `cleared`: kept with its history but not relied on; accepting it later is the way back. To re-explore a finished, flagged finding the browser sends `fork-revision` with `resolveReview: true` and `start: true`, which marks the original cleared with `replacedBy`. Never resolve a flag on the user's behalf.
- `restore-version`, `name-version`, `unname-version`: user-only, no `nodeId`. Version history belongs to the user; an agent never restores or names a version, even when asked indirectly. Work packets, briefs and `read` always use the current map, not a version.
- `cancel`: stops queued work or rejects subsequent results from the claimed run. The agent should also stop its actual investigation; this API cannot kill host-owned subagents.
- `position`: `x`, `y`. Presentation only.
- `cancel-job`: `jobId`, no `nodeId`. Stops queued or running work that is not a branch investigation. Use `cancel` for a branch.

## Shared settings

Settings live in `ideas/settings.json` beside the maps and are meant to be committed, so everyone who opens the repo gets the same experience. The file is `{ "version": 1, "revision": N, ...fields }`. Each feature registers its own fields with a default and validation. A save names at least one field; unknown fields are rejected, and fields this version does not know are kept. The browser reads them with authenticated `GET /api/settings` and saves them with `POST /api/settings` carrying `expectedRevision`. A missing file means defaults. An unreadable one, for example with Git conflict markers, falls back to defaults with `unreadable: true` and is replaced only when the user saves. A file in a newer format falls back to defaults with `newer: true` and is never overwritten; update Explore to change it. Settings are the user's choice: never change them unless the user asks.

## Bounded discovery and reading

`maps` lists saved maps; `status` adds the local address and bridge state to the first map page. `--query TEXT` searches map titles and IDs case-insensitively. `read --map ID` lists node summaries and searches node IDs, titles, premises, summaries, and findings. Search does not expose the entire matching body. Both default to 20 entries and accept `--limit 1–40`, `--offset N`, and `--revision REV`. They return `total`, `matching`, `offset`, and `nextOffset` (`null` at the end). An empty search is explicit. Node summaries include staleness and review state; a summary is not necessarily a verified finding.

For continuation, retain the query and pass both `nextOffset` and `revision`. Map discovery uses an opaque catalog revision; node discovery uses the map's revision. If either changed, restart the targeted search at offset 0. Thus nodes after the first 40 remain discoverable without repeatedly loading a complete map into the agent's context. The CLI currently fetches the full list/snapshot internally from the local server and bounds its output; this is a model-context bound, not a streaming-storage implementation.

A user may paste a reference to an idea, such as `Explore idea "Title": map-3e4d4390/node-20f918e5 (ideas/map-3e4d4390/nodes/node-20f918e5.md)`. The pair supplies the IDs for `read --map ID --node ID`.

`read --node ID` defaults to a bounded summary. Add `--section premise|findings|questions|sources|relationships` for detail. `--query TEXT` filters records case-insensitively; `--question ID` selects one question record. Question IDs appear in work packets. Findings/premise are single text records; query filters the record rather than extracting surrounding sentences.

Each section response includes `excerpt`, work/review state, staleness, total/matching record counts, `totalCharacters`, `offset`, `nextOffset`, and `revision`. Summary and findings reads also identify `contentKind` as `findings` or `premise`; an unfinished branch can contain a revised premise before it has new research. Question reads label superseded records as belonging to earlier premises and preserve any actual answer; unanswered superseded questions are not awaiting the user. Default raw-text limit is 4,000 characters; `--limit` accepts 1–6,000. Formatted JSON is capped at 8,000 characters even with escaped text. Continue only if needed, passing `--offset <nextOffset> --revision <revision>` with the same section/query/question. A changed map rejects continuation, preventing silent mixing of versions. Offsets count JavaScript UTF-16 code units, not UTF-8 bytes or model tokens.

Successful CLI commands append content-free counts to `.explore/context-usage.jsonl`. `usage [--map ID]` sums recorded stdout characters and UTF-8 bytes, including formatting and its newline, by command. It excludes its own reports, failed commands, direct file reads, browser observations, research tools, model replies, and host compaction. It does not measure vendor token use or active context. No credentials or excerpts are stored in the log.

`brief --map ID` returns a bounded extraction of the saved map's findings, answers, open questions, review state, stale material, directions, work states, and relationships. This includes partial findings while a branch waits for an answer. A revised premise without a current result appears separately from findings; superseded questions and actual answers appear as records of previous premises. `--node ID` narrows it to that branch. Each section identifies its source nodes and omitted items; use targeted reads when a detail matters. The default JSON omits the duplicate Markdown representation; `--format markdown` prints the readable version instead. Neither form runs research, accepts conclusions, nor changes a map. These are saved statements, not a newly verified synthesis. Brief output, including Markdown, is counted exactly by `usage`.

`doctor` and `usage` also work while the server is stopped. Neither creates the runtime directory nor adds its own output to the usage log. In every packet, `context` lists the original idea first and then nearby ideas nearest first, so the farthest are the ones left out when a packet would be too long. Work packets target fewer than 16,000 characters and node section responses are bounded as above; these limits do not measure total host context or vendor token costs.

No additional provider connection is required to open a saved map. Existing format-1 snapshots remain readable. On restart, historical repeat jobs on already completed branches are cancelled while stored content and job history are retained; unfinished investigations remain retryable.

## Export and import

Only when the user asks: `export --map ID --out FILE` writes the complete map as JSON (no claim data) and refuses to overwrite a file. `import --file FILE [--as-copy]` imports an export or a `map.json`. An identical map returns `{ existing }`; a different map with the same ID returns `{ conflict }` and writes nothing, so ask the user whether to import a copy. An imported map never starts work.

## Process lifetime

The server lives independently of a worker's research result. The browser polls only for changed map revisions; this does not call an LLM. `next` waits at most 25 seconds and returns a small idle response. The user can keep the app open after the agent session ends, but new research stays queued until an agent starts listening again.

On server restart, running jobs become interrupted and require an explicit retry. A running server's stale host-owned job can be stopped/retried from the UI. There is no automatic timeout-based paid retry.

During this MVP, individual UI activations within the selected map are executed serially by the main agent unless the host agent deliberately delegates bounded investigations. Parallel-result persistence is supported; a pool of autonomous provider workers is not implemented.
