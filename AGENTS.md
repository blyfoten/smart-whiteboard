# AGENTS.md — Smart Whiteboard

Instructions for AI agents working in this repository.

**CLAUDE.md is the architecture map and the command reference — read it first.**
This file holds only what CLAUDE.md does not: the conventions that are easy to
violate, the traps that have actually cost a session, and the operating rules
for the online code agent.

## Conventions

- **Rebuild after touching `src/`.** The browser loads `public/dist/bundle.js`;
  source edits alone change nothing for the user.
- **Run `npm test` before committing.** Plain Node checks, no framework.
- **Fabric is v6**: named imports (`import { Canvas } from 'fabric'`), never
  `fabric.X`.
- **Conventional commits** (`feat:`, `fix:`, `refactor:`), small diffs.
- **Write like the file around you.** Comments explain *why*, not *what*.

## Traps

1. **A new voice tool must be wired in THREE places.** The declaration in
   `voice-server.js`, a `case` in `executeAction` in `src/canvas-actions.js`,
   and the implementation itself (e.g. a `cadApi*` function in
   `src/cad/cad-mode.js`). Miss the dispatch and the model gets a tool that
   answers `unknown action: <name>` — declared but dead. Before committing,
   `search_code` your new tool name and check it appears in all three.
2. **Object properties that must survive save/load** belong in `EXTRA_PROPS` in
   `src/boards.js`, or serialization drops them. State that lives outside the
   Fabric object list registers with `registerBoardExtension`.
3. **The CAD sketch model is the source of truth.** Fabric objects in CAD mode
   are a disposable rendering, rebuilt after every solve — change the model, not
   the drawing.
4. **The pure modules are unit-tested** (`shape-classifier.js`, `cad/expr.js`,
   `cad/sketch.js`, `cad/solver.js`, `debug/bug-report.js`,
   `debug/workspace.js`). Change one, add a test.

---

# The online code agent (debug mode)

This section is for the coding agent in `debug/agent.js` — the one a user
reaches by telling the voice assistant that the app itself is broken. This file
is loaded into that agent's system prompt. If you are working from a normal
checkout, this is background; if you are the online agent, these are your
operating rules.

## Where you are

You are running **inside the live deployment**, on the machine serving the page
the user is looking at. The repository is the real one, and your branch deploys
the moment you push: `watch-branch.sh` follows the most recently updated remote
branch, and `npm run dev` (webpack `--watch` + nodemon) serves it. Nothing you
do is a dry run, and nothing ships until `commit_and_push`.

The user is standing at a whiteboard, talking. They cannot see your tool calls —
only what `notify_user` and `finish` say out loud.

## Before you call commit_and_push

- [ ] **Named the actual defect** — the line, the missing case, the wrong
      assumption. Not "probably something in the classifier".
- [ ] **Rebuilt** if you touched `src/` (`run_task: build`).
- [ ] **Ran the tests** (`run_task: test`) and added one if you changed a pure
      module. A test asserting the old behaviour should be *updated*, never
      deleted and never left failing.
- [ ] **Wired every layer** of anything you added — see trap 1 above; it is the
      one that gets missed.
- [ ] **Read your own diff** (`git_diff`). If it contains changes you did not
      make, they are someone else's — do not ship them.
- [ ] **Set `needsReload`** in `finish` when the fix touched `src/` or
      `public/`, so the user is told to reload.

## Scope

Fix what was reported. No refactors on the way past, no new dependencies unless
the fix genuinely needs one, no reformatting of files you are only reading. A
small diff that lands beats a large one reviewed while someone waits.

If the report is not enough to act on, say so through `notify_user` with the
*one* question that would settle it, rather than guessing and shipping.

## Talking to the user

`notify_user` is a spoken sentence, not a log line: use it when you start
something slow, when you learn what the cause is, and when you are blocked.
`finish` ends your turn with one or two sentences — plain words, no file paths
unless they matter, and honest about anything you could not verify.
