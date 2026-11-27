# Roadmap and handoff

Status as of 2026-11-27. Start here in a new session. The GitHub issues are the source of truth for each feature; this page records what they cannot: branch state, decisions still open with the owner, known defects and why the plan looks the way it does.

## Where the plan lives

- Planned features are issues #1–#69 on [uhstray-io/explore](https://github.com/uhstray-io/explore/issues). Tracking issue [#70](https://github.com/uhstray-io/explore/issues/70) groups them, lists the foundations to land first, and lists what was considered and not planned.
- Titles carry a short ID from the planning list, such as `B9: Help me answer`. Issues refer to each other by these IDs and by number.
- Each issue has a summary, current behaviour with `path:line` references, proposed behaviour, acceptance criteria, out of scope, implementer notes, **Depends on** and **Related** links, and the base branch and checks. References were checked against `rename-to-explore` on 2026-11-27 and drift as work lands.
- Labels: `area: …`; `size: S`, `S-M`, `M`, `L` (rough estimates); `runs: app` (works with no agent connected), `runs: agent` (a new job type or result format, so it needs a listening agent) or `runs: app+agent`; `origin: copilot-explore` or `origin: new idea`; `foundation`; `changes-invariant`.
- Pick an issue whose **Depends on** issues are closed. X1 ([#1](https://github.com/uhstray-io/explore/issues/1)) comes first: it defines job types, map-level jobs, actions without a node and `.explore/preferences.json` once, so features built in parallel share one design.

## Branch state

- `main` contains everything: the workspace improvements from `codex/exploration-workspace` (described in [the review guide](review-guide.md)) and the rename from `rename-to-explore`, fast-forwarded on 2026-11-27. Start new work from `main` on a feature branch.
- Both feature branches stay on GitHub for reference and can be deleted.

## How the plan was made

- Features were adapted from the owner's GitHub Copilot plugin, [Copilot Explore](https://github.com/AndrewGodlewsky/Copilot-Explore), reviewed at commit `af0117b` (docs, code and all closed issues), plus new ideas. The owner chose 68 of 83 candidates; X1 was added as shared groundwork.
- Only behaviour is adapted. The owner dislikes Copilot Explore's UI and visual design, so UI work follows the Constellation design in `skills/explore/assets/`.
- Copilot Explore starts its own model sessions; Explore cannot. Every AI feature is therefore a job type in the existing queue (`cli.mjs next`) and runs only while an agent is listening.

## Decisions still open with the owner

Confirm these with the owner before implementing them.

- E1 ([#20](https://github.com/uhstray-io/explore/issues/20)) and Z2 ([#60](https://github.com/uhstray-io/explore/issues/60)) change product invariants in `AGENTS.md`: history becomes content history, and a finished branch can be restarted. Update `AGENTS.md` in the same change.
- H8 ([#37](https://github.com/uhstray-io/explore/issues/37)) moves node positions out of shared map files, so layouts become per-machine.
- B7 ([#7](https://github.com/uhstray-io/explore/issues/7)), B8 ([#8](https://github.com/uhstray-io/explore/issues/8)) and D3 ([#18](https://github.com/uhstray-io/explore/issues/18)) change when a branch re-queues and how flagged findings are resolved. Read them together.

## Known defects

- One damaged or conflict-marked `map.json` stops the server from starting. Startup recovery reads every map with no per-map error handling (`skills/explore/scripts/server.mjs:40` → `store.mjs:383-385` → `store.mjs:64-66`). Confirmed by reading the code, not by running it. Covered by H3 ([#32](https://github.com/uhstray-io/explore/issues/32)) and J2 ([#44](https://github.com/uhstray-io/explore/issues/44)).
- Job claim keys and worker names are saved in shared map files, and committed maps contain them. They only work with the local server's token. Covered by H8 ([#37](https://github.com/uhstray-io/explore/issues/37)); I2 ([#40](https://github.com/uhstray-io/explore/issues/40)) strips them from exports.
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
