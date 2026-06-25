# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Webpack bundle src/ -> public/dist/bundle.js (dev mode)
npm run build:prod   # Production bundle (minified, source maps)
npm start            # Run Express server (port 3000, auto-increments if taken)
npm run dev          # webpack --watch in background + start server
```

`npm test` runs the pure stroke-classifier checks in `test/shape-classifier.test.mjs` (plain Node, no framework). There is no linter configured.

**Critical:** the browser loads `public/dist/bundle.js`, which is the webpack output. Editing anything under `src/` has no effect until you `npm run build` (or run `npm run dev` for watch mode). Always rebuild after changing `src/`.

Requires a `.env` file with `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `ANTHROPIC_API_KEY` (see `.env.example`). On startup the server **auto-runs `npm install`** if a provider SDK is missing (handy with the git-pull watcher that doesn't install deps; disable with `NO_AUTO_INSTALL=1`).

## Architecture

A single-page whiteboard app: draw a handwritten equation, an AI vision model reads it into structured JSON, the equation is evaluated and plotted as a graph rendered back onto the canvas.

### Backend — `server.js` (Express, single file)

POST endpoints:
- `/extract` — unified vision extraction; body `{ image, provider }` where `provider` ∈ `openai` | `gemini` | `claude`. Returns `{ dependentVariable, expression, scope, ranges }` for math.js. `/extract-equation` and `/extract-equation-gemini` remain as thin back-compat aliases (→ `openai` / `gemini`).
- `/solve` — text equation solver, dispatched by a `model` field: `'math'` (mathjs, local), `'gpt'` (OpenAI), `'gemini'`, `'claude'`.
- `/graph` — pure math.js: compiles `expression`, samples 100 points over the first variable's range, returns `[{x, y}]`.
- `/plan` — serves `docs/improvement-plan.html`.

Providers live behind a small interface in **`providers/`**: `openai.js`, `gemini.js`, and `claude.js` each implement `isConfigured()` / `extract(image)` / `solve(equation)`; `schema.js` holds the shared system prompt + `validateExtraction`; `index.js` is the registry (`get('gpt'|'openai'|'gemini'|'claude')`). Model IDs are env-overridable — `OPENAI_VISION_MODEL` / `OPENAI_SOLVE_MODEL` (default `gpt-5.4`, official `openai` SDK), `GEMINI_MODEL` (default `gemini-2.5-flash`, `@google/genai`; `gemini-2.0-flash` was shut down 2026-06-01), and `CLAUDE_VISION_MODEL` / `CLAUDE_SOLVE_MODEL` (default `claude-haiku-4-5`, `@anthropic-ai/sdk`). Keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`. The three billable endpoints share an in-memory per-IP `aiLimiter` (30 req/min). Missing keys are warned at startup; each provider's client is `null` without its key, so the server still boots.

### Frontend — ES modules in `src/`, bundled by webpack

`src/index.js` is a thin orchestrator wired up on `DOMContentLoaded`. Module responsibilities:
- `canvas.js` — Fabric.js canvas lifecycle (singleton via `getCanvas()`), free-draw brush, resize, bounding-box detection, crop-to-content (exports a JPEG data URL for the vision API), pinch-to-zoom/pan, undo, save-PNG, clear.
- `api.js` — all `fetch` calls to the backend; owns the analyze (extract) → graph data flow. After analysis the equation is rendered as clean text **in place** of the handwriting (one-press Undo restores the ink) and `showEquationMenu` is opened beside it.
- `equation-menu.js` — Word-style floating action menu shown next to a freshly analyzed equation. Content-aware (a function → Plot / Solve =0 / Steps); AI actions coerce the `math` model to `gpt`. Repositions on `after:render`, dismisses on `selection:cleared`/Escape.
- `ui.js` — **all** button/dropdown event wiring (`initializeEventListeners`), the `currentModel` state (`getCurrentModel()`), the ⚙ Settings popover (`initSettingsMenu`), and the double-click-to-add-IText behavior. (Solving is contextual now — no standalone Solve button.)
- `output.js` — the "Solution Output" panel: `appendToOutput()` result cards, clear, mobile collapse (`initOutputPanel`).
- `modes.js` — interaction modes (draw/select/shapes), the toolbar + Space-to-select, and the shape-beautify hook.
- `shape-classifier.js` (pure geometry, unit-tested) + `shapes.js` (Fabric builders) — freehand stroke → clean primitive recognition (line, **polyline** via RDP straightening, arrow, rect, ellipse).
- `node-edit.js` — `enablePointEditing(polyline)` gives a Fabric Polyline one draggable handle per vertex (custom controls) so lines/segments can be reshaped in Select mode; body-drag still moves it. Recognized lines/polylines are built as editable Polylines.
- `graph.js` — renders Chart.js to an **offscreen** canvas, then inserts the result as a Fabric image object (tagged `_isGraph`) onto the whiteboard.
- `speech.js` — Web Speech API voice commands (note: locale is hardcoded to `sv-SE`).

**Fabric.js is v6** — use named imports (`import { Canvas, IText } from 'fabric'`), not the v5 `fabric.X` global style.

### Key cross-cutting patterns

- **All UI behavior lives in the bundle.** `public/index.html` has **no inline script** (de-duplicated in §4.2) — every handler is wired in `src/` on `DOMContentLoaded`. A few `window` globals remain as a light bridge/state holder: `window.canvas`, `window.solveEquation`, `window.extractedEquationData` (last extracted equation), and `window.appendToOutput` (back-compat alias; `api.js` imports `appendToOutput` from `output.js` directly).
- **End-to-end analyze flow:** draw → `cropCanvasToBoundingBox` (JPEG data URL) → `POST /extract` (`{ image, provider }`) → store JSON on `window.extractedEquationData` → replace the handwriting with clean text in place → open the contextual menu. Plotting is no longer automatic: the menu's **Plot** action (or the 📈 toolbar button) calls `drawGraph()` → `/graph` → `renderGraph` draws via Chart.js offscreen and adds a Fabric image (`_isGraph`).

## Notes / known rough edges

- `AGENTS.md` is partially outdated: it predates the phase-1 refactor that split the old `src/index.js` monolith into the modules above and deleted the dead `public/js/app.js`. Trust the actual `src/` layout over that file.
- `public/test.html` is a standalone scratch page, not part of the app.
- Webpack `mode` defaults to development; use `build:prod` for deployable output.
- Commit style in history is Conventional Commits (`feat:`, `fix:`, `refactor:`).
