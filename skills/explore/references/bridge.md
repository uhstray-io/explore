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

To create a map, the input file is `{ "title": "Short name", "idea": "The user's idea in their own terms" }`. Creating it queues an initial exploration because the user asked to explore that idea. Other branches only queue after user activation. The file may also carry the user's `mode` (`understand`, `decide`, `design`, `diagnose` or `challenge`), `objective` and `successCriteria` (each at most 2,000 characters); record only what the user said.

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
    {"title": "Source title", "url": "https://example.org/source", "note": "The specific claim this source supports or challenges", "stance": "supports"}
  ],
  "links": [
    {"to": "an-existing-node-id", "type": "depends_on"}
  ]
}
```

A source's optional `stance` is `supports`, `challenges` or `context`: whether it backs the finding, argues against it or only frames it. Leave it out (or send null or an empty string) when unsure, and it shows as "Stance not recorded"; any other value rejects the result. Help me answer research ignores `stance`, since it has no finding for a source to back. The user's source library (Map tools) groups every source cited on the map, including earlier results and Help me answer research, and flags one that backs ideas linked as contradicting each other.

When the user has named a research model, a branch investigation packet carries `modelHint: { model, note }`. It is the user's permission to delegate that investigation to a subagent running the named model. Follow it only where your host can choose a subagent's model; Claude Code's subagent tool accepts a per-call model (seen in a Claude Code session, November 2026), and Codex and Copilot support is unverified. Never switch the main conversation's model, ask for API keys, or fail a job because the hint cannot be followed; do the work yourself instead. Report what happened in optional `execution: { "delegated": true|false, "model": "as reported", "note": "optional" }` (each text at most 200 characters). It is kept on the job beside the worker and shown as reported by the agent; Explore cannot verify it.

Optional `topicProfile` names the research guidance you followed: `general`, `software-versions`, `products-services` or `concepts-tradeoffs` (see "Choose a topic profile" in `exploration.md`). Any other value is rejected. It is kept with the result and shown under the findings.

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

List the few statements that matter for the decision in optional `claims` (at most 12; an empty list means none): `{ "id": "offline", "text": "The statement", "support": [{ "source": "https://example.org/a", "passage": "A short quotation (about 25 words) or close paraphrase", "locator": "Section or page" }] }`. `id` follows the option-id rule; `text` at most 500 characters; `support` 0–3 entries, each citing a `url` from this result's `sources` (which must then be distinct), `passage` 400, `locator` 120. Empty `support` means support unknown. A result without sources is shown as reasoning, never as verified. A later result replaces an idea's claims; a revised premise clears them.

When the map has a mode, objective or success criteria, every packet carries `goal`: `{ mode, modeFocus, objective, successCriteria }` with only the parts that are set, each text shortened past 1,200 characters. It is never trimmed for the budget; see exploration.md for how to use it. Tidying an answer is the one kind of work without it. `read --map` and the brief return `goal` too, `null` when nothing is set.

Every investigation packet carries `glossary`: the map's agreed terms as `{ term, definition }`, at most 3,000 characters (terms the selected idea uses come first), with `omittedGlossaryTerms`. Use those terms as defined. When the exploration has settled on a meaning for a new term, or needs a different one, propose it in an optional result field `glossary`: at most 5 `{ "term": "…", "definition": "…" }` (term at most 80 characters, definition 600). Proposals wait for the user and never reach a packet until accepted; a proposal for an agreed term is shown as a replacement, and one identical to it is dropped. Every other packet carries the agreed glossary too, in the room its own content leaves, except Tidy my wording, which keeps the user's words.

When sources disagree or evidence could not be found, record it in optional `limitations` (at most 8):

```json
{
  "limitations": [
    {"id": "price", "kind": "conflict", "summary": "The two price sources disagree, and the choice depends on it.", "nextStep": "Ask the vendor for a written quote.", "sources": ["https://example.org/a", "https://example.org/b"], "optionIds": ["buy"], "blocksRecommendation": true}
  ]
}
```

`kind` is `conflict` (sources disagree; cite at least two) or `missing-evidence` (looked for, not found; sources optional). `id` follows the option-id rule and is unique; `summary` at most 600 characters, `nextStep` 400. `sources` must be URLs from this result's `sources`. `optionIds` (0–4) names options in this result; empty means the whole branch. `blocksRecommendation: true` needs options and a recommendation with `optionId: null`. Any other value rejects the whole result. A later result replaces an idea's records and a revised premise clears them, so when a continuing branch's packet lists `selected.limitations` (and `selected.options`), resend in full the ones that still hold. The packet shortens them: read `--section limitations` (and `options`) for the full records first.

When the selected idea is a hypothesis (`selected.kind` is `hypothesis`; `selected.hypothesis` holds its `test`, recorded `outcome` and `proposed` outcome), you may return `hypothesis: { test, outcome, rationale }`: the smallest test that could refute the claim (at most 2,000 characters), and an outcome you propose, `supported`, `refuted`, `inconclusive` or `null` when the test needs something only the user can do, with a `rationale` (at most 1,500 characters, required with an outcome). On any other idea the field rejects the result. Your outcome is kept as a proposal, and a later result without `hypothesis` clears it, so resend it while it holds; only the user records an outcome.
Record the key interpretations the finding rests on without proof in optional `assumptions` (at most 8): `{ "statement": "Volunteers sync once a day.", "wouldChangeIf": "Field reports show weekly syncs." }`, each field required and at most 600 characters. They belong to the findings like `claims`: a new result replaces them, and a stale result keeps them only on its job. The packet carries them shortened as `selected.assumptions`; read `--section assumptions` and resend in full the ones that still hold. They appear in the user's assumptions register and the brief as unverified. Never list user preferences there.

`summary` and `body` are required. Omit unused arrays. The example URL and ID are illustrative; real results require actual consulted sources and existing node IDs. Do not cite a source you have not read.

Limits: summary 800 characters; body 24,000; at most 5 questions, 8 suggestions, 20 sources, 12 links. A question is a string or `{text, importance, why}`: `importance` is `low`, `medium` or `high` and needs a `why` (at most 600 characters) saying what the answer would change; `why` may also stand alone. A missing `why` for a rated question, or any other importance value, rejects the whole result so you can resend it. Suggestion kinds: `research`, `question`, `decision`, `risk`, `idea`, `hypothesis`. A `hypothesis` suggestion's `body` is the claim; it may carry `test` (at most 2,000 characters), how to test it. Link types: `depends_on`, `supports`, `contradicts`, `related_to`. `contains` is created by the server for suggested children. All results remain unreviewed until the user accepts them.

### Result checks

Before an investigation result is saved, it is checked against these exploration rules. Comparisons ignore case, repeated spaces and trailing punctuation. Each finding is `{ code, field, message }`, where `field` names the item, such as `questions[1]`.

- **Errors reject the result.** Nothing is saved and the claim stays valid, so fix the listed items and send it again with the same `result` command. The errors are `answered-question` (it re-asks a question the user already answered anywhere in the map), `dismissed-question` (one the user dismissed on this idea), `duplicate-question` and `duplicate-suggestion` (the same question or suggestion title twice in one result).
- **Warnings never block delivery.** They are returned as `warnings` and their codes are kept on the job. They are `superseded-question` (answered under an earlier premise; re-asking can be right), `dismissed-elsewhere` (dismissed on another idea), `compound-question` (it may ask two things), `existing-branch` (a suggestion matching an existing idea; one already under this idea is skipped) and `weak-source-note` (a note that repeats the title or URL, or is under five words).

A repeated delivery of a saved result changes nothing and returns only the saved `{ code, field }` of its warnings. Run `result --job ID --file result.json --check` to get `{ ok, errors, warnings }` without saving or touching the job (it exits non-zero when `ok` is false, and a malformed result fails as it would on delivery), and reconsider warnings before the final `result`: a completed branch cannot change afterwards.

### What changed since a commit

`changes --map ID --since REF [--format json|markdown]` compares the map as committed at `REF` (default `HEAD`) with the current saved map, matching ideas and questions by ID: new, removed and revised ideas, answers given or changed, questions now waiting, saved for later or closed, links added or removed, and changed findings. JSON replies give `before: { sha, ref, existed }` and `after: { revision }`, with counts and the Markdown. It only reads Git (`rev-parse` and `show`), never commits or fetches (not even a partial clone's missing objects, with Git 2.44 or later), reads the committed map by the same rules as a saved one, and refuses refs that could be read as options.

### Connections the user records

The user can record links themselves with the `link` action (`nodeId` is the dependent, `to` the other idea, `relation` one of `depends_on`, `supports`, `contradicts`, `related_to`, optional `note`) and remove any non-containment link with `unlink`. These edges carry `addedBy: "user"`. Use these actions only when the user explicitly asks; otherwise record links in a result.

## Other kinds of work

Every packet from `next` carries `jobType`. `investigate` is the branch investigation above; a job saved without a `type` is one. Other types are registered in `scripts/job-types.mjs` by the features that need them. Each such packet carries `mapId`, `jobId`, `jobType`, `reason` and `instruction`, plus the type's own fields. Every packet's `instruction`, an investigation's included, ends with the same sentence about keeping private details out of searches. Follow its `instruction`, then deliver the result it describes with the same `result --job ID --file result.json` command, or use `fail`. The result is kept on the job record. It never changes the idea's status, findings, questions or completion, and it never accepts anything for the user. If the idea or its context changed while the work ran, the result is kept but marked `stale`.

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

## Reconsidering with the user's criteria

Only the user asks for this (`reconsider`); never request it on their behalf. A `reconsider` packet carries an idea's comparison (C1) and the criteria the user gave it, each `{ id, label, priority }` with priority `high`, `normal` or `low`: `node` (premise, summary and the user's answers, each with how sure the user is), `options` (without suggested answers), the original `recommendation`, `criteria`, and the idea's `claims` and `limitations` if any. If the packet would be too long, the oldest answers, then claims, then limitations that block nothing are left out (counted in `omitted`), and then the options' wording, the premise, the recommendation and the limitations' summaries are shortened, in that order (listed in `omitted.shortened`); `retrieval` says how to read them in full. Work on an idea that changed after the user asked is not sent. Do no new research: judge from the saved evidence. Return:

```json
{
  "assessments": [{"optionId": "crdt", "criterionId": "crit-1a2b3c4d", "text": "Works with no signal: each device keeps editing.", "basis": "evidence"}],
  "recommendation": {"optionId": "lock", "rationale": "Why, against the user's priorities", "mainTradeoff": "What it costs"},
  "changed": "What changed from the original recommendation, and why"
}
```

Give exactly one assessment (at most 300 characters) for every option and criterion in the packet, with `basis` `evidence`, `reasoning` or `unknown`. The recommendation follows the same rules as a comparison, `optionId: null` with `missing` included; if a limitation on the idea blocks a recommendation, it must stay null. `changed` is at most 600 characters. Anything else rejects the result. The result stays on its job: the idea's own options, recommendation, status and findings never change, and the user chooses to use it or keep the original.

## Tidying an answer

A `clean-answer` packet carries the `question` (`id`, `text`) and the user's `draft`, and nothing else: no nearby ideas, findings or file paths. Fix punctuation, spelling and grammar, make it clearer and remove repetition, keeping the meaning, any uncertainty, names, numbers and the user's voice. Add nothing, answer nothing new, and do no research. Return `{"text": "…", "changes": "…"}` (text at most 12,000 characters; `changes` an optional note of at most 300). The result stays on the job and is shown beside the user's own wording; only the user can use it, and only Save makes it an answer. Until they use it or keep theirs, the draft and the tidied text stay in `map.json` only, never in versions or exports; then both are removed, as they are when the request is stopped, fails, is superseded by a newer one, or its question is answered or set aside. The user asks with `clean-answer` (`questionId`, `text`); never request it on their behalf.

## Regenerating a question

A `regenerate-question` packet carries the `question` to replace, the user's `userReason`, the idea (`node`), its `answeredQuestions` and `openQuestions`, and the map's `questionFeedback`. Return `{"question": {"text": "…", "importance": "…", "why": "…"}}` (text at most 1,600 characters; importance and why are optional, as in results): one question that serves the same purpose better, never the original or a dismissed one, and never its answer. It is added beside the original, linked by `replaces` and `replacedBy`. A replacement for a question that is no longer waiting is kept as stale and not added.

Every investigation packet carries `questionFeedback`: up to 10 of the map's most recent questions the user rated, dismissed or replaced, with any reason (trimmed first when the packet is over budget), and `selected.dismissedQuestions`, which are never to be asked again.

## Map jobs: Check answers

A map job reads across many saved answers instead of one branch. Only the user starts one, from the browser's Map tools; an agent never requests a map job, as it never activates a branch. `next` returns it with `jobType: "check-answers"`, `nodeId: null` and:

- `records`: the original idea, then every current answer (with its question, idea title, certainty, work and review state, staleness) and open question, root first. A user may have narrowed the check to chosen answers.
- `omittedRecords`: IDs left out, with the reason (`earlier premise`, or `over the packet budget`).
- `resultFormat`, `instruction`, and `retrieval`: how to read an answer shortened here in full.

Like every map job, the packet also carries the map's title and, when the map has them, its goal and agreed glossary terms. Deliver with the same `result --job ID --file result.json`:

```json
{
  "summary": "Optional overview.",
  "findings": [
    {"category": "possible-tension", "explanation": "What does not fit together.", "resolution": "What would settle it.", "refs": [{"nodeId": "…", "questionId": "…"}]}
  ]
}
```

Categories: `possible-tension`, `unresolved-choice`, `untested-assumption`. At most 12 findings; text up to 1,000 characters; each finding cites 1–8 records from `records`. An empty list is a valid result. Any other field rejects the result. Report what you notice between saved statements; never call an answer wrong or answer for the user. The result becomes a proposal: each point waits for the user to keep or dismiss it, and nothing in the map changes. A tension that rests on an answer the user has not marked Decided is shown as an unresolved choice. A check is marked stale once an answer it read changes, or how sure the user is of it, or an open question it read is answered, or a changed premise sets it aside; another question on the same idea leaves it current. A check of chosen answers that were set aside before you took it fails with the reason instead of reading fewer. `GET /api/maps/ID/job-preview?type=check-answers` shows the packet without starting anything.

## Map jobs: Challenge decisions

Only the user asks for this (`request-map-job` with `challenge`); never request it on their behalf. `next` returns it with `jobType: "challenge"` and `nodeId: null`. It is an answer review like Check answers, with the same packet shape: `records` holds the original idea, then exactly the 1–40 saved answers the user chose (`{ nodeId, questionId, nodeTitle, question, answer, certainty, status, reviewState, stale }`), with the map's title and, when it has them, its goal and agreed glossary terms. The browser shows the user that packet first, through `GET /api/maps/ID/job-preview?type=challenge&selection=[…]`. If a chosen answer was set aside before you take the job, it fails with the reason. Argue against them in good faith:

```json
{
  "findings": [{
    "category": "assumption",
    "explanation": "What the answer takes for granted",
    "resolution": "What would confirm or settle it",
    "refs": [{"nodeId": "node-…", "questionId": "q-…"}],
    "sources": [{"title": "…", "url": "https://…", "note": "The claim it supports"}]
  }]
}
```

`category` is `assumption`, `counterargument`, `alternative` or `evidence-gap`. Give at most 12 findings (an empty list is fine: do not manufacture objections when none matter), each with an explanation and a resolution of at most 1,000 characters, 1–8 refs to answers you were given, and at most 3 sources you actually read. Missing context is not evidence against a choice. Each finding is a hypothesis for the user to keep or dismiss: never ask the user to change an answer, and never present one as a finding about the map. Anything else rejects the result.

## Map jobs: Draft an ADR

Only the user asks for this (`request-map-job` with `adr-draft`); never request it on their behalf. An `adr-draft` packet carries `records`, the 1–40 the user chose: saved answers (`{ nodeId, questionId, idea, question, answer, certainty, reviewState, stale }`) and explored ideas' findings (`{ nodeId, idea, summary, findings, reviewState, stale }`), with an optional `titleHint`. Draft from those records alone, with no new research:

```json
{
  "title": "Store notes on the device and sync later",
  "context": "Markdown",
  "decision": "Markdown",
  "consequences": "Markdown",
  "alternatives": "Markdown, optional",
  "openQuestions": "Markdown, optional",
  "refs": [{"nodeId": "node-…", "questionId": "q-…"}, {"nodeId": "node-…"}]
}
```

The title is at most 120 characters and each section at most 6,000. Where the user never gave a reason, write "Not recorded"; never invent one. The title is one line. `refs` names at least one record you were given, each once; anything else rejects the result. Records that would not fit are shortened and marked `shortened`, with `retrieval` saying how to read them in full. Explore renders the record from a fixed template (Status: Proposed, the date it is saved, and a sources section with map, node and question IDs) and keeps it as one proposal item. The user edits and accepts it (`review-proposal` with `decision` and the edited `text`, user-only), and only the browser's Save file writes it to `docs/adr/`, never over an existing file. You only draft: never write an ADR file yourself, and never call the ADR file route, which is the browser's.

## Map jobs: Implementation handoff

Only the user asks for this (`request-map-job` with `handoff` and `options.format`); never request it on their behalf. `next` returns it with `jobType: "handoff"` and `nodeId: null`. The packet carries `records`, the 1–40 the user chose, as for an ADR draft (saved answers with their certainty, and explored ideas' findings, each with its review state and staleness, shortened and marked when they would not fit), with `idea` (the original idea), `format` (`brief`, `spec`, `plan`, `prompt` or `tasks`) and an instruction for that format, plus the map's title, goal and agreed terms as every map job has. The browser shows the user that packet first, through `GET /api/maps/ID/job-preview?type=handoff&selection=[…]&options={"format":"…"}`. Write the document for whoever implements the work:

```json
{
  "title": "Offline notes: a plan",
  "markdown": "# Plan\n\n1. Store notes on each phone.\n\n## Open questions\n\n…",
  "refs": [{"nodeId": "node-…", "questionId": "q-…"}, {"nodeId": "node-…"}]
}
```

The title is one line of at most 120 characters, and the markdown at most 24,000. `refs` names at least one record you were given, each once, with `questionId` only for an answer; anything else rejects the result. Owners, estimates and acceptance criteria the records never give stay "Not recorded"; an answer that is not Decided, a finding that is unreviewed or stale, and anything the records disagree on go under "Open questions", never under "Decisions". You only write the document: never start implementing, run commands, open issues or send it anywhere. The user edits and accepts it (`review-proposal` with `decision` and the edited `text`, user-only), and only then copies or downloads it from the live map, with a footer Explore adds: the map and the revision it was copied at, each record it was written from with how settled it is and a `*` where you cited it, who accepted it and when, and which sources changed since.

## Map jobs: Sort thoughts

The user jots rough thoughts into the map's inbox and, when they ask, a `sort-thoughts` packet carries them: `thoughts` (`{ id, text }`, whole thoughts only, at most 20, those never sorted before first; `remainingThoughts` counts the open ones left for a later sort) and `ideas`, an index of the map in reading order (`{ id, title, kind, status, completed, summary }`, summaries shortened), with `omittedIdeas` counted; use `read --map ID --query TEXT` for more. Propose a place for each thought; never activate anything:

```json
{
  "placements": [
    {"thoughtId": "thought-1a2b3c4d", "action": "new-branch", "parentId": "node-…", "title": "Paper backup", "body": "Why it matters and what to explore", "kind": "research"},
    {"thoughtId": "thought-5e6f7a8b", "action": "note", "nodeId": "node-…", "reason": "It adds to the storage question."},
    {"thoughtId": "thought-9c0d1e2f", "action": "unplaced", "reason": "Not about this exploration."}
  ]
}
```

Give exactly one placement per thought; `parentId` and `nodeId` must exist. Titles are at most 100 characters, bodies 4,000, reasons 600; `kind` is `research` (the default) or `hypothesis`, which may carry `test`: how to test it. A new branch's title must be new under its parent and used once in the result. Any other field rejects the result. Prefer a note when a thought adds to an existing branch, and a new branch when it opens a separate question; a thought that changes a finished premise becomes a new branch, not a note. The result is stored as a proposal: only the user accepts a placement. A note keeps the user's own words, and a later branch packet carries an idea's newest notes as `selected.userNotes` (within 1,500 characters, each at most 600 and marked when shortened, the rest counted in `omittedNotes`; `read --section notes` has them all): the user's context, not findings or answers.

## Mutations

An action carries `expectedRevision` and `type`, plus `nodeId` unless the action covers the whole map. Use the current revision returned by `read`. On a conflict, re-read before deciding whether the action still applies; do not blindly overwrite. Map-level actions still need `expectedRevision` and run one at a time like every other action.

If someone pulled or switched branches since you last read the map, an action fails with code `changed-outside` and changes nothing. Read the map again, check the action still makes sense against the new content, then retry. A result normally goes into the map as it now is, as long as its job is still running there. If a pull lands at the very moment of delivery, `result` fails with `changed-outside`; the CLI keeps the claim, so run the same `result` command again. Maps listed with `unreadable: true` cannot be read or changed until the user fixes the file; `next` skips them. See [the map format](format.md) for how outside changes are adopted and kept.

- `activate`: queue a suggested branch or retry unfinished work. Completed branches reject activation. Only on the user's explicit request, normally via the UI. Optional `doneWhen` (at most 400 characters; empty clears it) is the user's stopping point for the branch.
- `set-done-when`: `doneWhen`. Change or clear the stopping point of an unfinished branch that is not running (running work already has its packet). User-only; it never flags findings or queues work, and a result can never set it.
- `answer`: `questionId`, `answer`, optional `answerState` (`tentative` by default, `decided` or `assumption`; all need text). Supply only an actual user answer. Questions superseded by a changed premise remain in history and reject new answers. Answering a question saved for later clears that.
- `record-outcome`: `outcome` (`supported`, `refuted` or `inconclusive`), optional `note` (at most 1,000 characters). User-only, on a hypothesis: never record an outcome, even when asked in a result. It works on a finished hypothesis and changes no findings. A first refuted or inconclusive outcome, or any change of outcome, is like a changed answer: work running on the hypothesis or on the ideas resting on it (below it or depending on it) becomes stale, and their findings are flagged for review (`hypothesis-outcome`); their questions stay answerable. A first supported does neither. Nearby ideas in packets carry `kind` and `outcome` for a hypothesis. Event `outcome-recorded`.
- `suggest` may carry `kind`: `research` (the default) or `hypothesis`, with an optional `test`.
- `set-disprove-if`: `questionId`, `text` (at most 1,000 characters; empty removes it). User-only: the user's note on what would show one of their own current answers marked Assumption is wrong. It is an annotation like `set-answer-state`: allowed on finished branches, and it never changes content; a change that changes nothing is refused. Event `disprove-if-set`. A packet shows the note as `disproveIf` on that answer.
- `inbox-add` (`text`), `inbox-edit` (`thoughtId`, `text`) and `inbox-discard` (`thoughtId`), no `nodeId`: the user's own inbox. `place-thought` (`proposalId`, `itemId`): user-only; it accepts one suggestion from a sort. Never take these on the user's behalf.
- `set-criteria`: `criteria` (up to 8 `{ id?, label, priority }`, labels at most 120 characters and each once; an empty list clears them). User-only: the user's own criteria for an idea's options. It queues nothing and changes no findings.
- `reconsider`, `adopt-reconsideration` and `dismiss-reconsideration` (`jobId`): user-only. Asking queues a `reconsider` job; using a result or keeping the original changes only which recommendation leads, never the idea's own options, findings or status. Never take these on the user's behalf.
- `set-answer-state`: `questionId`, `answerState`. Changes how sure a saved, current answer is. It is an annotation: allowed on finished branches, and it never re-runs research, flags findings or changes content. User-only.
- `rate-question`: `questionId`, `rating` (`good`, `bad` or `null` to clear), optional `reason` (600). Feedback, not content: allowed on answered questions and finished branches, never re-runs research. User-only; an agent never rates.
- `dismiss-question`: `questionId`. Sets an open question aside on an unfinished branch; it then rejects answers. When nothing else blocks, the branch continues. `restore-question` brings it back while the branch is waiting for answers. User-only.
- `regenerate-question`: `questionId`, optional `reason`. Sets the question aside and queues a `regenerate-question` job; the branch waits for the replacement. If that job fails, is stopped or is interrupted, the original question comes back. User-only.
- `answer-later`: `questionId`. Saves an open question for later on an unfinished branch: it stays answerable but no longer pauses the branch, which continues once nothing else blocks it. User-only; never defer a question on the user's behalf.
- `suggest`: `title`, `body`. Adds an inactive research direction.
- `set-guidance`: any of `mode`, `objective`, `successCriteria`, no `nodeId`. Sets each field given, clears one given as null or empty, and keeps one left out; a save that changes nothing is refused. User-only. It changes no idea, flag, review or queued job, and the old values go to the history as a `guidance-changed` event.
- `revise`: `body`. Revises unfinished work and marks dependent findings for review. Questions and actual answers from earlier premises are retained with `supersededAt`; unanswered earlier questions no longer block continuation. Retry explicitly to investigate the new premise. Completed branches reject direct revision.
- `fork-revision`: `body`, optional `title`; or `questionId` and `answer` for a changed answer. For a completed branch, create a child with the changed premise or answer. Preserve the original premise, answers, findings, evidence, and review history; flag affected findings for review. The child records `revises`, and `revisesAnswer: { questionId, previousAnswer, answer }` for a changed answer. The browser sends `start: true` so the child is queued at once, because the user choosing to explore it is the go-ahead. Agents never set `start`; without it the child stays inactive until the user activates it.
- `change-answer`: `questionId`, `answer`, optional `answerState` and `rerun`. User-only, on an unfinished branch. The old answer is kept in `previousAnswers`; findings on this branch that relied on it, and those below it or depending on it, are flagged for review (their questions stay); follow-up questions asked after the old answer are superseded; and the branch continues from the new answer when nothing else blocks it. `rerun: false` is a wording fix that changes only the text and history. A finished branch rejects it: use `fork-revision` with `questionId` instead.
- `restart-branch`: `questionId`, `answer`, `previewHash`, optional `answerState`. User-only: the agent never restarts a branch, even when asked indirectly. On a finished branch, the browser first reads `GET /api/maps/:id/restart-preview?node=N&question=Q[&offset&limit]`, which writes nothing and lists the ideas below N to delete (paged), later questions to set aside, outside findings to flag, links removed, the checkpoint name and a `hash`. The action is refused when that hash no longer matches, the answer is unchanged, or work in the branch is queued or running. It saves a named checkpoint version first (stopping with the map unchanged if it cannot), then deletes the ideas below N with their work, positions and links, flags outside findings that relied on them, gives N the new answer, sets aside later questions, clears N's findings back to its premise, and queues N again.
- `accept`: user accepts a current finding. Never self-accept a model conclusion.
- `reaffirm` ("Still holds") and `clear-finding` ("No longer relevant"): user-only, on a finding flagged for review. Reaffirm removes the flag and keeps the finding as it was (an accepted one is accepted and current again). Clear marks it `cleared`: kept with its history but not relied on; accepting it later is the way back. To re-explore a finished, flagged finding the browser sends `fork-revision` with `resolveReview: true` and `start: true`, which marks the original cleared with `replacedBy`. Never resolve a flag on the user's behalf.
- `pin-answer`: `nodeId`, `questionId`, `pinned`. User-only view state; an agent never pins answers.
- `restore-version`, `restore-branch`, `name-version`, `unname-version`: user-only, no `nodeId`. Version history belongs to the user; an agent never restores or names a version, even when asked indirectly. Work packets, briefs and `read` always use the current map, not a version.
- `cancel`: stops queued work or rejects subsequent results from the claimed run. The agent should also stop its actual investigation; this API cannot kill host-owned subagents.
- `position`: `x`, `y`. Presentation only.
- `fold`: `collapsed` (true or false). Hides or shows the idea's directions on everyone's map; an idea without directions cannot be folded. `reveal`: unfolds every folded idea above this one. User-only presentation: they change no idea, and an agent never folds.
- `cancel-job`: `jobId`, no `nodeId`. Stops queued or running work that is not a branch investigation. Use `cancel` for a branch.

## Shared settings

Settings live in `ideas/settings.json` beside the maps and are meant to be committed, so everyone who opens the repo gets the same experience. The file is `{ "version": 1, "revision": N, ...fields }`. Each feature registers its own fields with a default and validation. A save names at least one field; unknown fields are rejected, and fields this version does not know are kept. The browser reads them with authenticated `GET /api/settings` and saves them with `POST /api/settings` carrying `expectedRevision`. A missing file means defaults. An unreadable one, for example with Git conflict markers, falls back to defaults with `unreadable: true` and is replaced only when the user saves. A file in a newer format falls back to defaults with `newer: true` and is never overwritten; update Explore to change it. Settings are the user's choice: never change them unless the user asks.

## Bounded discovery and reading

`maps` lists saved maps; `status` adds the local address and bridge state to the first map page. `--query TEXT` searches map titles and IDs case-insensitively; with `--content` it searches every map's titles, premises, findings, questions, answers and sources instead, returning at most three short excerpts per map with `nodeId`s to `read`. Archived maps are left out unless `--archived include` or `only`, except an archived map with work waiting. `read --map ID` lists node summaries and searches node IDs, titles, premises, summaries, and findings. Search does not expose the entire matching body. Both default to 20 entries and accept `--limit 1–40`, `--offset N`, and `--revision REV`. They return `total`, `matching`, `offset`, and `nextOffset` (`null` at the end). An empty search is explicit. Node summaries include staleness and review state; a summary is not necessarily a verified finding.

For continuation, retain the query and pass both `nextOffset` and `revision`. Map discovery uses an opaque catalog revision; node discovery uses the map's revision. If either changed, restart the targeted search at offset 0. Thus nodes after the first 40 remain discoverable without repeatedly loading a complete map into the agent's context. The CLI currently fetches the full list/snapshot internally from the local server and bounds its output; this is a model-context bound, not a streaming-storage implementation.

A user may paste a reference to an idea, such as `Explore idea "Title": map-3e4d4390/node-20f918e5 (ideas/map-3e4d4390/nodes/node-20f918e5.md)`. The pair supplies the IDs for `read --map ID --node ID`.

`read --node ID` defaults to a bounded summary. Add `--section premise|findings|questions|sources|options|limitations|claims|assumptions|notes|relationships` for detail. `--query TEXT` filters records case-insensitively; `--question ID` selects one question record. Question IDs appear in work packets. Findings/premise are single text records; query filters the record rather than extracting surrounding sentences.

Each section response includes `excerpt`, work/review state, staleness, total/matching record counts, `totalCharacters`, `offset`, `nextOffset`, and `revision`. Summary and findings reads also identify `contentKind` as `findings` or `premise`; an unfinished branch can contain a revised premise before it has new research. Question reads label superseded records as belonging to earlier premises and preserve any actual answer; unanswered superseded questions are not awaiting the user. Default raw-text limit is 4,000 characters; `--limit` accepts 1–6,000. Formatted JSON is capped at 8,000 characters even with escaped text. Continue only if needed, passing `--offset <nextOffset> --revision <revision>` with the same section/query/question. A changed map rejects continuation, preventing silent mixing of versions. Offsets count JavaScript UTF-16 code units, not UTF-8 bytes or model tokens.

Successful CLI commands append content-free counts to `.explore/context-usage.jsonl`. `usage [--map ID]` sums recorded stdout characters and UTF-8 bytes, including formatting and its newline, by command. It excludes its own reports, failed commands, direct file reads, browser observations, research tools, model replies, and host compaction. It does not measure vendor token use or active context. No credentials or excerpts are stored in the log.

`brief --map ID` returns a bounded extraction of the saved map's findings, answers, open questions, review state, stale material, directions, work states, and relationships. This includes partial findings while a branch waits for an answer. A revised premise without a current result appears separately from findings; superseded questions and actual answers appear as records of previous premises. `--node ID` narrows it to that branch. Each section identifies its source nodes and omitted items; use targeted reads when a detail matters. The default JSON omits the duplicate Markdown representation; `--format markdown` prints the readable version instead. Neither form runs research, accepts conclusions, nor changes a map. These are saved statements, not a newly verified synthesis. Brief output, including Markdown, is counted exactly by `usage`.

`doctor` and `usage` also work while the server is stopped. Neither creates the runtime directory nor adds its own output to the usage log. In every packet, `context` lists the original idea first and then nearby ideas nearest first, so the farthest are the ones left out when a packet would be too long. Work packets target fewer than 16,000 characters and node section responses are bounded as above; these limits do not measure total host context or vendor token costs.

No additional provider connection is required to open a saved map. Existing format-1 snapshots remain readable. On restart, historical repeat jobs on already completed branches are cancelled while stored content and job history are retained; unfinished investigations remain retryable.

## Answering in a file

The user can answer open questions in a Markdown file, in any editor, and import the answers. Only text between a question's `<!-- answer -->` and `<!-- end answer -->` markers is read, matched by the question ID; an optional first line `state: decided`, `state: tentative` or `state: assumption` says how sure the answer is (Tentative without one); any other "state:" line is part of the answer. Only the user answers: never write into an answers file, and run these only when the user asks.

- `answers export --map ID --out FILE` writes every open question (saved-for-later ones too) on unfinished branches; it refuses to overwrite a file.
- `answers import --map ID --file FILE` prints a preview: each answer's question and a status (`ready`, `answered`, `superseded`, `dismissed`, `completed`, `unknown` or `too-long`). It changes nothing. A file for another map, with a question twice or with a marker out of place is rejected with its line number.
- Add `--apply` to save each ready answer as its own `answer` action. It saves in two passes: first every answer that does not finish its idea, then each idea's last waiting answer, since that one queues the branch. Answers to an idea linked to a branch an agent has already claimed can still make that run stale, as answering them in the browser would. When an answer is refused (for instance because a listening agent claimed a branch and the map moved on), the map is read again and the answer, if still ready, is sent once more. The result lists `saved` and `failed`, and `notAttempted` if the server stopped. A failure never undoes an earlier save, and an already answered question keeps its saved answer.

## Export and import

Only when the user asks: `export --map ID --out FILE` writes the complete map as JSON (no claim data) and refuses to overwrite a file. Add `--format mermaid|canvas|svg|print` for a Mermaid flowchart, a JSON Canvas 1.0 file (Obsidian), a standalone SVG or a script-free printable HTML page (the user prints it and saves a PDF), and `--node ID` for that idea and everything below it. These show each idea's work and review state, never jobs, workers or paths, and refuse more than 500 ideas or 4 MiB rather than cut anything: export a branch instead. `import --file FILE [--as-copy]` imports an export or a `map.json`. An identical map returns `{ existing }`; a different map with the same ID returns `{ conflict }` and writes nothing, so ask the user whether to import a copy. An imported map never starts work.

## Process lifetime

The server lives independently of a worker's research result. The browser polls only for changed map revisions; this does not call an LLM. `next` waits at most 25 seconds and returns a small idle response with `listen: { windowMinutes, idleSeconds, keepListening }`. The user chooses the window in the browser (2, 10, 30 or 60 minutes; `listenMinutes` in the shared `ideas/settings.json`, default 2), and it is read on every idle response. `idleSeconds` counts from this listener's last activity: the last job handed to it, or the last saved change to a map it covers (any map without `--map`). Keep polling while `keepListening` is true; when it is false, finish and say how to resume. The user can keep the app open after the agent session ends, but new research stays queued until an agent starts listening again.

On server restart, running jobs become interrupted and require an explicit retry. A running server's stale host-owned job can be stopped/retried from the UI. There is no automatic timeout-based paid retry.

During this MVP, individual UI activations within the selected map are executed serially by the main agent unless the host agent deliberately delegates bounded investigations. Parallel-result persistence is supported; a pool of autonomous provider workers is not implemented.
