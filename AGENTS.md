# Explore

This repository contains a portable agent skill plus its dependency-free local web application. The canonical skill package is `skills/explore/`. Keep improvements usable when that folder is copied into another repository.

## Product invariants

- Suggestions stay inactive until the user chooses a branch. Creating an exploration authorizes its initial investigation.
- Questions use actual user answers. An agent completing research does not accept its own conclusion.
- Completed branches stay complete, except when the user explicitly restores an earlier version or restarts a branch. The restore preview lists every branch it reopens; a restart is previewed and saves a named checkpoint before deleting anything. A changed premise or answer on a finished branch creates a new investigation that starts when the user chooses to explore it, and earlier findings are retained.
- The localhost UI stores and queues work. It does not run or wake an LLM. Do not promise background research unless the actual host integration supports it.
- JSON snapshots are authoritative; Markdown is generated. Use the app/CLI/Store for mutations. Preserve old format-1 maps.
- Growth history shows additions with current content and positions. Version history keeps saved versions in the repo for preview and explicit restore; restoring creates a new revision, never rewrites earlier versions and never starts research. Undated older data must stay explicitly unknown.
- Briefs are bounded extracts. Keep accepted, provisional, stale, unanswered, and unexplored material distinct; expose omissions and retrieval paths.
- Everything about an exploration lives in the repo: maps, version history, positions, settings, and pin and archive state. Anyone who clones or pulls must get the same experience and be able to continue any map. Only the server token and connection, the lock, and live claim keys stay in `.explore/`.
- Keep the experience simple and frictionless: no approval steps, sensible defaults, and one ⋯ menu per item for secondary actions. Advanced options must not crowd the main path.

## Layout and checks

- `scripts/store.mjs` inside the skill serializes map mutations and generates readable views.
- `scripts/server.mjs` exposes loopback HTTP and the asset allowlist; `scripts/cli.mjs` is the agent bridge.
- `assets/` contains the live Constellation UI and shared pure graph/history helpers.
- `references/` holds conditional agent guidance; keep `SKILL.md` concise.
- `tests/` uses Node's built-in test runner. Run `node scripts/test.mjs`, `node scripts/check.mjs`, and `node scripts/verify-prototypes.mjs` from the repository root. HTTP tests need local loopback connections.
- `node scripts/review-demo.mjs --serve` creates an isolated illustrative map under `.test-output/` and serves it on a free port.

Do not use the owner's `ideas/` for tests. `.explore/` (or `.grill-my-mind/` in workspaces from before the rename) contains runtime credentials and claims: never commit it or print its token fields. Standalone `prototypes/` snapshots are preserved comparisons, not the live app.

## Planned work

Planned features are GitHub issues on `uhstray-io/explore`, tracked in #70. Read `docs/roadmap.md` before picking an issue, switching branches or merging: it records branch state, the owner's decisions (which win over older issue text), and known defects. Earlier design decisions are in `.scratch/explore/map.md`. Record new decisions with reasons and verification, not hidden reasoning. A copied skill package or simulated worker test does not prove live Claude Code/Copilot compatibility.

Commit owner map edits under `ideas/` separately from implementation work.

Finish each issue all the way into `main`; you don't need to ask first:
1. Work on a feature branch from the latest `main`.
2. When the issue's checks pass, commit, push the branch and open a pull request against `main` with `Closes #N`.
3. Have a separate agent review the pull request with the [thermo-nuclear code quality review](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md) skill.
4. Fix what it finds, re-run the checks and push.
5. Merge the pull request into `main` with a merge commit.

No Copilot review is needed. Never force-push a branch someone else may have pulled.
