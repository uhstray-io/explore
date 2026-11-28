# Roadmap and handoff

Status as of 2026-11-27. Start here in a new session. The GitHub issues are the source of truth for each feature; this page records what they cannot: branch state, the owner's decisions, known defects and why the plan looks the way it does.

## Where the plan lives

- Planned features are issues #1–#69 on [uhstray-io/explore](https://github.com/uhstray-io/explore/issues). Tracking issue [#70](https://github.com/uhstray-io/explore/issues/70) groups them, lists the foundations to land first, and lists what was considered and not planned.
- Titles carry a short ID from the planning list, such as `B9: Help me answer`. Issues refer to each other by these IDs and by number.
- Each issue has a summary, current behaviour with `path:line` references, proposed behaviour, acceptance criteria, out of scope, implementer notes, **Depends on** and **Related** links, and the base branch and checks. References were checked against `rename-to-explore` on 2026-11-27 and drift as work lands.
- Labels: `area: …`; `size: S`, `S-M`, `M`, `L` (rough estimates); `runs: app` (works with no agent connected), `runs: agent` (a new job type or result format, so it needs a listening agent) or `runs: app+agent`; `origin: copilot-explore` or `origin: new idea`; `foundation`; `changes-invariant`.
- Pick an issue whose **Depends on** issues are closed. X1 ([#1](https://github.com/uhstray-io/explore/issues/1)) comes first: it defines job types, map-level jobs, actions without a node and the shared `ideas/settings.json` once, so features built in parallel share one design. H3 ([#32](https://github.com/uhstray-io/explore/issues/32)) comes next: shared maps make outside changes from `git pull` routine.

## Branch state

- `main` contains everything: the workspace improvements from `codex/exploration-workspace` (described in [the review guide](review-guide.md)) and the rename from `rename-to-explore`, fast-forwarded on 2026-11-27. Start new work from `main` on a feature branch.
- The foundation issues (#1, #3, #9, #20, #24, #32, #34), plus #7, #8, #18 and #71, were merged into `main` on 2026-11-27 through PRs #72–#83. Each finished issue now goes straight into `main` after a separate agent's review (see `AGENTS.md`).
- Both feature branches stay on GitHub for reference and can be deleted.

## How the plan was made

- Features were adapted from the owner's GitHub Copilot plugin, [Copilot Explore](https://github.com/AndrewGodlewsky/Copilot-Explore), reviewed at commit `af0117b` (docs, code and all closed issues), plus new ideas. The owner chose 68 of 83 candidates; X1 was added as shared groundwork.
- Only behaviour is adapted. The owner dislikes Copilot Explore's UI and visual design, so UI work follows the Constellation design in `skills/explore/assets/`.
- Copilot Explore starts its own model sessions; Explore cannot. Every AI feature is therefore a job type in the existing queue (`cli.mjs next`) and runs only while an agent is listening.

## Decisions made with the owner (2026-11-27)

The owner settled every open decision on 2026-11-27. Where an issue body still describes the earlier design, these decisions win until the issue is edited.

### Product rules

- **Everything about an exploration lives in the repo.** Maps, version history, positions, settings, and pin and archive state are committed, so anyone who clones or pulls gets the same experience and can continue any finished or half-finished map. "Multiplayer" means taking turns through Git; #33 handles parallel edits. Only the server token and connection, the server lock, and live job claim keys stay in `.explore/`, because they are credentials or live process state that nobody else can use.
- **The tree is simple and frictionless.** There are no approval steps. Actions start once the user chooses them. Each question, finding or idea has one ⋯ menu for secondary actions. Advanced options stay out of the way.

### Decisions

| # | Issue | Decision | Reason |
|---|---|---|---|
| 1 | E1 #20 | Version history lives in the repo at `ideas/<map-id>/versions/`, one uniquely named file per version, stored compactly. Retention tidies the folder; Git keeps everything committed. After a merge, Undo means "undo my latest change". | The next person must be able to undo, restore and recover. One file per version merges without conflicts. |
| 2 | E1 #20 | A restore may reopen a finished branch. The preview lists every branch it reopens. Restore never starts research. | Undo that refuses the most common case (right after a result) is not undo. The restore can itself be undone. |
| 3 | Z2 #60 | Restart branch is allowed, with a preview, a confirmation and a named checkpoint first. | It keeps the map clean when an early answer was wrong, and the checkpoint makes it recoverable for everyone. |
| 4 | H8 #37 | Positions stay in `map.json` and are shared. Only claim keys move out. The worker label stays in the map. | Layouts must be the same for everyone. Claim keys only work with one machine's server. |
| 5 | B7 #7 | Questions appear without an approval step. Each has a ⋯ menu: Good or Bad question (with an optional "why"), Regenerate, Dismiss. Ratings are stored in the map and sent to the agent. Dismissing the last open question continues the branch. Reword and Keep are dropped. | Approving every question adds friction. Feedback still reaches the agent. |
| 5b | new issue | The inspector shows the current batch one question at a time ("Question 1 of 3"). Answering moves to the next. The branch continues after the batch. The agent keeps batches small. | It feels like a conversation without throwing away agent work: answering while the agent runs makes its result stale (`store.mjs:345-349`). |
| 6 | B8 #8 | Changing an answer re-runs the branch automatically, with a small "Save without re-running" link for typo fixes. | People edit answers because they changed their mind. |
| 6b | B8 #8, Z2 #60 | On a finished branch, "Change answer" asks whether to explore the new answer beside the original (preselected) or restart. Either starts straight away. "Explore a changed premise" also starts straight away. | One action does one job. The choice in the dialog is the user's go-ahead. |
| 7 | D3 #18 | Flagged findings get Still holds, No longer relevant and Re-explore in the ⋯ menu, plus a one-at-a-time "Review flagged" walk-through. Re-explore starts straight away. | Flags on finished branches can be resolved at all. Re-checking with the agent can be added later. |
| F1 | X1 #1, K1 #49, Z5 #63 | Settings are shared by the repo in `ideas/settings.json`, the same for everyone. | Everyone who opens the repo gets the same experience. |
| — | I1 #39 | Pin and archive state is shared in the repo. | Follows from F1. |
| F2 | H5 #34 | Contributions are attributed by Git name (`git config user.name`). The email is never stored. There is no local file. | It needs no setup, and the name matches the commits that share the map. |
| F3 | B1 #3 | Answering stays type-then-Save. A saved answer carries a small Tentative, Decided or Assumption label. Not relevant becomes Dismiss, Need evidence becomes Help me answer (#10), and Revisit later becomes "Answer later" in the ⋯ menu. | Six choices on every answer is friction, and three of them duplicated other actions. |
| F4 | B2 #4, B4 #6, B9 #10, Z3 #61 | The question box keeps only the question, an importance label with a "Why?" link, the answer box and Save. The ⋯ menu, in order: Help me answer, Explain this question, Tidy my wording (only while drafting), Answer later, Regenerate, Dismiss, Good or Bad question. | Every extra is one click away in one place, and two overlaps disappear. |

### Limits decided while building

- **Impact keeps each idea's band, and lists one idea's affected ideas when asked (D4 #19).** The issue's `impactIndex` holds every affected idea for every idea. On a map where most ideas depend on another, those lists grow with the square of the map (90 MB at 2,000 ideas). So the index keeps each idea's band, whether it is open, and why a high one is high, and each idea's walk stops once its band is certain to be high. `impactOf` walks one idea in full for the inspector. The filter's rows give that reason ("At least 5 ideas elsewhere rest on it through dependencies.") rather than the full sentence, which stays in the inspector, because walking every listed idea in full took 7 seconds on a dense 2,000-idea map. An idea's branch is what `contains` links alone reach, so an idea reached both ways counts as in this branch and shows its branch path, even where a dependency reaches it in fewer steps. An idea reached only through dependencies shows a shortest path. Impact is shown on the live map only. Growth history shows today's content, and a saved version is read-only, so nothing there can be settled.

- **Folds are saved with the map (Z6 #64).** The issue's acceptance criteria and out-of-scope list still say folding leaves `map.json` unchanged, but its own view-state section records the owner's 2026-11-27 decision: folds are shared map content like positions. They are kept in `view.collapsed` through the `fold` and `reveal` actions, record no version and are not an outside change. Showing only one branch stays the browser's own. Because folds are shared content, growth history and a version preview never save one: they show the folds of the map shown, as they show its positions, and opening a folded idea there (its ⋯ menu, Right in the outline, or choosing a hidden idea) opens it in this browser only, until the user returns to live. Branch focus works there too. The fold and branch controls are items in the idea's ⋯ menu rather than buttons beside Nearby ideas (one ⋯ menu per item). In the outline, Right and Left open and fold a parent as the tree pattern says, which saves the fold.

- **The Map / Outline switch sits in the canvas heading (Z7 #65).** The issue placed it in the workspace tools row. It sits beside the saved state instead, at the top of the view it changes: the tools row already holds Find an idea and four buttons, and a view switch is not a tool. `outlineRows` lives in `assets/outline.js` with the rest of the outline rather than in `workspace-view.js`, so one module owns it. Without Z6 (#64) rows have no `aria-expanded`, and Left and Right only move.

- **Commands sit in the top bar (Z8 #66).** The issue placed a **Commands** button in the workspace tools row. It sits in the top bar beside Dark mode instead, with Ctrl+K or ⌘K: the palette works across the whole app, and the tools row already holds four map buttons.

- **More filters sit with the progress filters (Z9 #67).** The issue placed the **More filters** button in the workspace tools row. It sits directly under the progress filters instead, inside the same "Find ideas by state" landmark: it is a filter, its results open in the overview list right below, and the tools row holds map-level dialogs that a fifth button would crowd.

- **A map file is at most 64 MiB (J3 #45).** The server neither opens nor saves a larger `map.json`; it is listed as unreadable (`too-large`) and a save is refused with a clear message. One rule in `map-validation.mjs` (`readMapFile`, `maxMapBytes`) serves the server, the validator and the support report. Real maps are far smaller; the limit keeps reads, generated views and CI checks bounded.

- **Result checks reject only certain breaches (K3 #51).** A result is refused for re-asking a question answered anywhere in the map, re-asking one dismissed on the same idea, or repeating a question or suggestion title in one result. A question dismissed on another idea is only a warning (`dismissed-elsewhere`): the agent sees this idea's dismissals but not every branch's, and a dismissal means "not useful here". The issue's rule that heuristics never reject a result stands. Verified by `tests/result-checks.test.mjs`.

### Rules that change when those issues land

- `AGENTS.md` "History shows graph growth…" changes with #20.
- `AGENTS.md` "Completed branches stay complete; changed premises create new inactive investigations…" gains the restore and restart exceptions (#20, #60), and changed premises and answers start straight away (#8).
- `AGENTS.md` "`.explore/` contains runtime credentials and claims" stays true. Settings and version history go in the repo instead.

## Known defects

- One damaged or conflict-marked `map.json` stops the server from starting. Startup recovery reads every map with no per-map error handling (`skills/explore/scripts/server.mjs:40` → `store.mjs:383-385` → `store.mjs:64-66`). Confirmed by reading the code, not by running it. Covered by H3 ([#32](https://github.com/uhstray-io/explore/issues/32)) and J2 ([#44](https://github.com/uhstray-io/explore/issues/44)).
- Reported while drafting H3 but not independently re-checked: an edit can overwrite a map changed outside Explore when the revision numbers happen to match. Covered by H3.

## Rename notes

- Dated records keep the old name: `prototypes/`, `docs/research/`, `docs/iterations/`, `.scratch/explore/issues/` and the unserved `skills/explore/assets/prototype.*` studies.
- Workspaces used before the rename may contain `.grill-my-mind/`. It is no longer read; stop any server started from it, then delete it. `.gitignore` still ignores it.
- The browser's saved theme and last-opened map reset once, because their storage keys changed.
- The owner's Copilot Explore plugin also ships a skill named `explore`. Installing both in Copilot would clash; Claude Code alone is unaffected.

## Verification state

- Passed on 2026-11-27 in a fresh clone, before the merge into `main`: `node scripts/check.mjs`, `node scripts/verify-prototypes.mjs`, `node scripts/test.mjs` (90/90).
- Not yet checked: visual rendering after the rename, and live Claude Code and Copilot runs.
- Browser checks: the Playwright MCP plugin blocks `file://` pages by default, and the owner chose to keep that block. Serve pages over `http://127.0.0.1` instead, through the app server or `node scripts/review-demo.mjs --serve`.
