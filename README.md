# Explore

Formerly **Grill My Mind**. Dated research reports, saved prototypes and the original planning tickets keep the old name.

A skill for exploring complex ideas through a persistent visual mind map, focused questions, and user-activated agent research.

Target environments: Codex, Claude Code, and GitHub Copilot. The first working trial uses the invoking Codex agent; Claude Code and Copilot live execution still need hands-on validation.

## Roadmap

Planned features are [GitHub issues](https://github.com/uhstray-io/explore/issues), tracked in [#70](https://github.com/uhstray-io/explore/issues/70). [The roadmap](docs/roadmap.md) records branch state, open decisions and known defects.

## Exploration workspace

Focused progress navigation, map and branch briefs, a read-only growth timeline, and startup/resumption guidance are on `main`. [The review guide](docs/review-guide.md) explains the decisions and limits and has a walkthrough. Run `node scripts/review-demo.mjs --serve` to try an isolated illustrative map without modifying your saved ideas.

## Try the MVP

Requires Node.js 20 or later. No package installation or API key is needed for the local application.

```sh
node skills/explore/scripts/server.mjs
```

Open the URL printed by the server, normally `http://127.0.0.1:4317`. Use **Maps** to create an exploration or open a saved session. Select a constellation node to read it; choose **Explore this branch** to queue research. Drag individual nodes to move them, drag the background to pan, and use the zoom controls to navigate. Positions save to the map and survive restarts. Focus a node and use **Alt + arrow keys** for keyboard movement. The **Dark mode** toggle switches between light and dark themes and remembers your preference.

Use [the Explore skill](skills/explore/SKILL.md) in your coding agent and ask it to continue this workspace. The app shows when the agent is listening. **The browser does not run an LLM by itself:** research requires an active agent using the command bridge. If the agent has finished its turn, ask it to resume; queued work stays saved.

Maps open around the starting idea. Automatic placement keeps connected branches close, with an irregular layout; saved manual positions take precedence. Clicking a node centers it and frames its parent and children. **Nearby ideas** also lets you step between parent and child branches. Dragging moves the node without recentering the camera.

For larger maps, use **Find an idea** to search titles and bring a node into focus. Press Enter to select the first result, or Arrow Down and Tab to navigate results. **Focus selected idea** returns to the current node; **Fit map** shows the entire constellation. Navigation does not queue research.

Maps live in `ideas/<map-id>/map.json`, with generated Markdown overviews and node documents alongside them. The JSON snapshot is authoritative. Reads are open; edits go through the app or its commands. A map survives browser/server restarts and does not depend on the originating chat. No Git operation that changes anything happens automatically. The heading of an open map says whether its `map.json` is committed, saved locally but not committed, ignored, in conflict, or outside a Git repository. It checks with read-only Git commands that never stage, commit, fetch or change the index, and only when the map opens, after you save, after a pull, or when you click the label. Hovering it shows the branch and how it compares with its upstream; Explore never fetches, so the remote may be newer. Explore writes into your project only when you save a decision record, to `docs/adr/`, and never over an existing file.

Use the progress filters to find questions awaiting your answer, queued investigations, unexplored directions, and findings that need review. **Map brief** and **Branch brief** extract a compact account of recorded knowledge, uncertainty, and next directions; copy or download it as Markdown. Omitted records are counted, and stable IDs let an agent retrieve the details. A brief does not run new research or turn a provisional conclusion into an accepted one.

**Growth history** shows when ideas and connections were added. Scrub between recorded additions, then **Return to live** to edit. History uses current findings, status, and positions; it does not claim to reconstruct prior content. Older missing dates appear as unknown. Browsing history never starts research.

Explored branches stay complete. Use **Add a direction** to grow a new branch. **Explore a changed premise** creates a new investigation beside the original, starts it, and flags affected findings for review while preserving the original content. On a finished branch, **Change answer** offers the same, or **Restart from this answer**: after a preview, it saves a named checkpoint version, deletes the ideas below the branch and explores it again from the new answer. Restoring the checkpoint brings everything back. Questions and retries still continue unfinished work.

Agents can retrieve individual sections or old answers with `read --node ID --section questions --query "constraint"` (also pass `--map ID` and `--workspace PATH`). Reads are paged instead of loading full node histories. `usage --map ID` reports recorded CLI output sizes, not total conversation context or model tokens; see [the bridge reference](skills/explore/references/bridge.md).

For first use or connection problems, run `node skills/explore/scripts/cli.mjs doctor --workspace <repo>`. It works without a running server and changes no files. To report a problem, `doctor --support` prints a short JSON report you can attach to an issue. It holds setup facts and counts only: no ideas, answers, titles, IDs, paths, names, tokens or process IDs. `--out FILE` writes it to a new file instead. `maps --query TEXT` discovers saved explorations; `read --map ID --query TEXT` searches nodes beyond the first page. `brief --map ID --format markdown` provides the same extractive overview to another agent. All commands accept `--workspace`; list continuation uses the returned offset and revision.

## Saved design prototypes

**Constellation/version 1 is now the live UI.** It renders real saved sessions and uses the existing agent bridge; there are no simulated research timers in the working app. Suggested nodes remain gray until activated. Queued, researching, unanswered, explored, accepted, and stale states remain distinct. Findings and available sources appear in the inspector.

[Two standalone HTML snapshots](prototypes/README.md) preserve the earlier Constellation study and original card map for comparison. Those files simulate research and reset on reload; their hashes are unchanged. Version 2 is no longer an active choice. Old `?variant=` links open the live workspace. [Issue 08](.scratch/explore/issues/08-live-constellation.md) records integration and verification.

## Install in another project

The complete portable package is `skills/explore/`. From this repository:

```sh
node skills/explore/scripts/install.mjs --host codex --project /path/to/project
node skills/explore/scripts/install.mjs --host claude --project /path/to/project
node skills/explore/scripts/install.mjs --host copilot --project /path/to/project
```

Choose the host you use. These copy to `.agents/skills`, `.claude/skills`, or `.github/skills` respectively and refuse to overwrite an existing installation.

To update an installation, run the same command from a newer copy with `--update`. It does the following:
- **Checks before it starts.** It refuses while that project's Explore server is running, and refuses to install an older version unless you add `--allow-downgrade`. If the copy is already identical, it changes nothing.
- **Swaps safely.** It stages the new copy, moves the old one to `.explore/skill-backups/<host>-<version>-<time>/`, then moves the new one into place. If that last move fails, the old copy goes back. Nothing is ever placed inside a discovery folder, so your agent never sees two copies.
- **Reports what changed.** It prints both versions, the backup's location, and any files that only the old copy had.
- **Leaves your maps alone.** It never touches `ideas/`.

To go back, stop the server and move the backup folder back to `explore/` in the discovery folder. The installed version is in `explore/version.json`. `doctor` and the app's sidebar show it, and `doctor` warns when the running server is from a different version. Quote paths containing spaces. Reload the host's skill discovery if necessary. The host must support local shell commands and a persistent server process; a cloud agent's localhost is not your workstation.

Maps in `ideas/` are meant to be committed. Anyone who clones or pulls the repo can open a finished or half-finished map and continue it. Maps may contain private ideas and answers, so decide what the repo should share before pushing it. Agents are instructed to keep names, private figures and personal details out of web searches, but Explore cannot see or enforce what a host's search tool sends.

The local `.explore/` runtime directory contains only connection information, the server lock and claim files; keep it out of version control. Add `.explore/` to the target project's ignore file when installing. Workspaces used before the rename may still contain a `.grill-my-mind/` folder; it is no longer read, so stop any server started from it and delete the folder.

## Validate maps

Check committed maps without starting the server, for example before merging a pull request that changed `ideas/`:

```sh
node .agents/skills/explore/scripts/validate.mjs --workspace .
```

It checks every `ideas/map-*/map.json`, or only the folders and files you name. It reports:
- Git conflict markers, broken JSON, missing or mistyped fields, duplicate IDs, links and jobs pointing at ideas that no longer exist, and parent loops. These are errors.
- Generated views that are out of date. These are warnings; `--strict` makes them fail too.

It uses the same rules the server uses to open a map, plus checks the server does not need. Each problem names a code and where it is, never a value from the map. `--json` prints one JSON document. It exits 0 when everything is valid, 1 when a map is invalid, and 2 for a usage mistake. It writes nothing. To run it on every pull request, copy [`docs/examples/validate-explore-maps.yml`](docs/examples/validate-explore-maps.yml) to `.github/workflows/`.

## Check the build

```sh
node scripts/check.mjs
node scripts/test.mjs
node scripts/verify-prototypes.mjs
```

Tests cover queue authorization, concurrent results, stale premises, cancellation, resumption, bounded context, HTTP/CLI operation, constellation layout and status presentation, saved coordinates, and packaging for all three discovery paths. Packaging tests do not establish live runtime compatibility with those hosts.

An optional real-browser workflow check is available in `scripts/browser-smoke.mjs`. It uses an existing Playwright installation and your explicitly chosen browser executable, creates only disposable maps, and saves screenshots and a report. See the [polish review](docs/iterations/2026-10-29-polish.md) for the command and what was exercised. It is not a runtime dependency of the skill.

## Design and research

- [Product brief](docs/product-brief.md): confirmed requirements and open questions.
- [Research recommendation](docs/research/recommendation.md): proposed persistence, resumption, and integration design, with linked primary-source reports.
- [Domain vocabulary](CONTEXT.md): shared terms.
- [Wayfinder map](.scratch/explore/map.md): research conclusions and open decision tickets.
- [MVP agreement](docs/mvp.md): accepted choices, implementation scope, and trial checks.
- [Verification](docs/verification.md): what was exercised and what remains to test.
