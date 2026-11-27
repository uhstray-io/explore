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
