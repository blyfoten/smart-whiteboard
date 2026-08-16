# Debug / bug-fix mode — the hand-off skill

Voice mode can hand a problem with **the app itself** to a coding agent running on
the server, which works on this repository and pushes a fix while the user is
still standing at the whiteboard. This document is the contract between the two
halves: what the voice assistant must hand over, what the coding agent may do,
and how a fix gets back onto the running page.

## Why it is a "skill" and not just a button

The coding agent never hears the user. Everything it knows about the bug is what
the voice assistant writes in a single `start_debug_session` call, plus what the
browser can attach automatically. The quality of that one hand-off decides
whether the agent fixes the right thing — so the hand-off is the skill, and the
tool schema is written to force the parts that matter.

**The assistant supplies** (`start_debug_session`):

| Field | Why the agent needs it |
| --- | --- |
| `title` | Names the fault, and becomes the git branch (`debug/<slug>-MMDD-HHMM`). |
| `summary` | What is wrong, in the assistant's own words. |
| `stepsToReproduce` | What the user did, in order — the difference between a fix and a guess. |
| `expected` / `actual` | The two halves of a bug. Without both there is no bug, only a complaint. |
| `area` | `voice`, `cad`, `canvas`, `shapes`, `graph`, `math`, `boards`, `ui`, `server` — attaches file hints. |
| `severity` | `blocker` \| `major` \| `minor` \| `cosmetic`. |
| `userQuote` | The user's own words, verbatim. Often more precise than a paraphrase. |
| `wanted` | For "make it do X" requests rather than fault reports. |
| `suspectedFiles` | Optional hints — the agent verifies them, it does not trust them. |

**The app attaches automatically** (`src/debug-capture.js`, requested over the
voice socket at hand-off time):

- a clean JPEG screenshot of the board (no coordinate grid — the agent reads it
  as a person would);
- the console errors and unhandled rejections the page actually threw, from a
  ring buffer installed before anything else at startup;
- app state: interaction mode, selected model/tier, object counts and current
  selection, CAD sketch health, panel visibility, viewport, user agent;
- the last voice tool calls, which are usually what the user is complaining about.

`debug/bug-report.js` normalises all of that (it never throws — a thin report is
still actionable, and the missing pieces come back to the assistant as
`missingFromReport`) and renders the markdown briefing the agent wakes up to.

## The conversation after hand-off

Once a session is open the voice assistant stops being a drawing assistant and
becomes the agent's voice:

```
user speech → Gemini Live → debug_message(text) → session queue → coding agent
coding agent → notify_user / finish → system note into the Live session → spoken
```

- `debug_message` returns immediately. Agent turns take minutes; progress arrives
  later as spoken updates, so nothing blocks on a tool response.
- Messages sent while the agent is mid-turn are queued and picked up at the end
  of it — the user can keep talking, interrupt, and correct.
- `debug_status` reports branch, status, changed files, commits and last summary.
- `end_debug_session` commits and pushes anything outstanding and returns the
  assistant to normal whiteboard duties.

The debug tools run **in the relay** (`voice-server.js`), not in the browser: the
repository is on the server and stays there. The browser's only contribution is
the capture.

## What the coding agent can do

`debug/agent.js` runs a tool loop on Claude (`DEBUG_AGENT_MODEL`, default
`claude-sonnet-5`) with a deliberately small tool set, all of it going through
the sandbox in `debug/workspace.js`:

`list_files` · `read_file` · `search_code` · `write_file` · `edit_file` ·
`run_task` (`test` \| `build` \| `install`) · `git_diff` · `commit_and_push` ·
`notify_user` · `finish`

Its instructions are the repo's own: **`AGENTS.md` is loaded whole** into the
system prompt (then `CLAUDE.md`, capped), and its "The online code agent"
section carries the pre-commit checklist — rebuild after `src/` edits, run the
tests, wire a new voice tool in all three places, read your own diff. That
section is where a newly-discovered trap should be written down.

Constraints that are enforced in code, not in the prompt:

- **No shell.** Commands are `execFile` with fixed argument arrays; the only
  runnable commands are the three npm tasks above and git plumbing.
- **Repo containment.** Every path is resolved and checked against the repo root;
  `..` escapes, absolute paths outside the tree, `.git/`, `node_modules/`,
  `.env*` (except `.env.example`) and `.debug-sessions/` are refused.
- **Size caps** on reads, writes and tool output; a step budget
  (`DEBUG_AGENT_MAX_STEPS`, default 40) per turn.

## How a fix reaches the running page

The deployment box already runs `watch-branch.sh` (follow the most recently
updated remote branch, pull it) alongside `npm run dev` (webpack `--watch` +
nodemon). So:

1. the agent edits `src/`, runs `npm run build` and `npm test`;
2. `commit_and_push` pushes `debug/<slug>-<stamp>` to origin;
3. the watcher sees that branch as the newest and pulls it (it is already the
   checked-out branch on the box, so this is a fast-forward no-op);
4. `server.js` rebuilds the bundle at startup if it is stale, so a deployment
   without webpack `--watch` still serves the new code;
5. the panel shows a **Reload** button when the fix touched `src/` or `public/`,
   and the assistant says so out loud.

Two things exist purely to survive that reload loop:

- `nodemon.json` narrows the watch set to server-side files, so an edit to `src/`
  (the browser bundle, which webpack handles) no longer restarts the server and
  drops the live voice session.
- Sessions are persisted to `.debug-sessions/` and the browser re-attaches by id:
  `src/voice.js` reconnects the WebSocket with backoff and sends `debug_attach`,
  and the panel's SSE stream reconnects on its own. A restart the agent caused by
  pushing its own fix is therefore a blip, not the end of the conversation.

## Working without voice

The same session is reachable over HTTP, so the feature is usable with voice off
and testable without a microphone:

```
GET    /debug/status                   # enabled? which sessions exist?
GET    /debug/sessions                 # every session, live or left on disk
POST   /debug/session                  # { report, context, screenshot } -> session
GET    /debug/session/:id              # state + events since ?since=
GET    /debug/session/:id/events       # SSE stream of agent activity
POST   /debug/session/:id/message      # { text }
POST   /debug/session/:id/cancel       # stop after the current step
POST   /debug/session/:id/end          # { push } commit, push, close
DELETE /debug/session/:id              # forget it (the git branch is kept)
```

The panel's text box and its session picker use exactly these.

## One session per branch, and no orphans

Sessions are listed in the panel the way boards are — newest first, live status,
click to switch, ✕ to forget. Two rules keep that list honest:

- A new session branches from the base its **predecessor** started from, not from
  whatever happens to be checked out. Without this, a second session opened while
  the first still had unpushed commits would branch on top of them, carry them
  under its own name, and leave the first branch stranded at its base.
- Before leaving a branch behind, anything unpushed on it is pushed. Work the
  agent committed is never left only on the deployment's disk.

Switching session in the picker also re-points the live voice assistant at it
(`debug_attach`), so the panel and the conversation never disagree about which
bug is being worked on.

## Turning it on

Off by default. Anyone who can reach the page can otherwise cause commits to the
repository the site runs from.

```bash
DEBUG_AGENT_ENABLED=1          # required — the master switch
ANTHROPIC_API_KEY=...          # the coding agent's model
DEBUG_AGENT_TOKEN=...          # optional shared secret, sent as X-Debug-Token
DEBUG_AGENT_MODEL=claude-sonnet-5
DEBUG_AGENT_GIT_NAME=...       # identity on the agent's commits
DEBUG_AGENT_GIT_EMAIL=...
```

The server also needs push rights for `origin` (the same credentials the git
watcher already uses). When the feature is off, the voice assistant is not given
the debug tools at all and `/debug/*` answers 503 with the reason.

Note on `DEBUG_AGENT_TOKEN`: it guards the HTTP API only. The voice path runs
inside the server and is unaffected, but the browser panel has no way to know the
token — with one set, a session is steered by voice and the panel's text box is
refused. Leave it unset when the page itself is already behind authentication.
