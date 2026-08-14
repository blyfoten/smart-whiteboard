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

`npm test` runs the pure-logic checks (plain Node, no framework): `test/shape-classifier.test.mjs` (stroke classifier) and `test/cad-core.test.mjs` (CAD expression evaluator, sketch model, constraint solver), and `test/catalogue.test.mjs` (model-tier resolution). There is no linter configured.

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
- `GET /models` — the model-tier catalogue (`providers/catalogue.js`) the Settings picker renders from.

Providers live behind a small interface in **`providers/`**: `openai.js`, `gemini.js`, and `claude.js` each implement `isConfigured()` / `extract(image)` / `solve(equation)`; `schema.js` holds the shared system prompt + `validateExtraction`; `index.js` is the registry (`get('gpt'|'openai'|'gemini'|'claude')`). Each provider offers the same three tiers — `fast` / `balanced` / `max` (Luna·Terra·Sol, Flash-Lite·Flash·Pro, Haiku·Sonnet·Opus) — defined once in **`providers/catalogue.js`** and served at `GET /models`. The browser sends only a tier KEY with `/extract` and `/solve`; the server resolves it to a model id, so a client can never name an arbitrary model. Default tier is `fast` (cheapest). Every id is env-overridable per step (`GEMINI_MODEL_MAX=…`), and the legacy single-model pins still win when set. Older per-provider notes: `OPENAI_VISION_MODEL` / `OPENAI_SOLVE_MODEL` (default `gpt-5.6-terra`, official `openai` SDK; the family is `-sol` / `-terra` / `-luna` from deepest-reasoning to cheapest), `GEMINI_MODEL` (default `gemini-3.7-flash`, `@google/genai`; `gemini-2.0-flash` was shut down 2026-06-01), and `CLAUDE_VISION_MODEL` / `CLAUDE_SOLVE_MODEL` (default `claude-sonnet-5`, `@anthropic-ai/sdk`; `claude-haiku-4-5-20251001` is the cheapest vision-capable fallback). Voice mode picks its own Live model — `voice-server.js` walks a fallback chain (newest first, currently `gemini-3.1-flash-live-preview`; the Live API lags the main model line), overridable with `GEMINI_LIVE_MODEL`. Keys: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`. The three billable endpoints share an in-memory per-IP `aiLimiter` (30 req/min). Missing keys are warned at startup; each provider's client is `null` without its key, so the server still boots.

### Frontend — ES modules in `src/`, bundled by webpack

`src/index.js` is a thin orchestrator wired up on `DOMContentLoaded`. Module responsibilities:
- `canvas.js` — Fabric.js canvas lifecycle (singleton via `getCanvas()`), free-draw brush, resize, bounding-box detection, crop-to-content (exports a JPEG data URL for the vision API), pinch-to-zoom/pan, undo, save-PNG, clear.
- `api.js` — all `fetch` calls to the backend; owns the analyze (extract) → graph data flow. After analysis the equation is rendered as clean text **in place** of the handwriting (one-press Undo restores the ink) and `showEquationMenu` is opened beside it.
- `equation-menu.js` — Word-style floating action menu shown next to a freshly analyzed equation. Content-aware (a function → Plot / Solve =0 / Steps); AI actions coerce the `math` model to `gpt`. Repositions on `after:render`, dismisses on `selection:cleared`/Escape.
- `ui.js` — **all** button/dropdown event wiring (`initializeEventListeners`), the `currentModel` state (`getCurrentModel()`), the ⚙ Settings popover (`initSettingsMenu`), and the double-click-to-add-IText behavior. (Solving is contextual now — no standalone Solve button.)
- `output.js` — the "Solution Output" panel: `appendToOutput()` result cards, clear, mobile collapse (`initOutputPanel`).
- `modes.js` — interaction modes (draw/select/shapes/cad), the toolbar + Space-to-select, the shape-beautify hook, Del-to-delete, re-clicking the active Draw/Shapes button to toggle the sub-toolbar, edge snapping + **sticky anchors** (a polyline endpoint drawn near a shape's outline pins to it and follows the shape when it moves; re-snaps/detaches on node-drag release), and the direction-aware marquee (drag down = window select, drag up = crossing select).
- `draw-settings.js` (pen/shape colour, fill colour+opacity, corner radius, **line style** solid/dashed/dotted via `dashArrayFor`; persisted in the `sw_draw` cookie) + `draw-toolbar.js` (the contextual sub-toolbar UI below the top bar) — one stroke colour drives both the pen and recognized shapes.
- `shape-classifier.js` (pure geometry, unit-tested) + `shapes.js` (Fabric builders) — freehand stroke → clean primitive recognition (line, **open polyline** & **closed polygon** via RDP straightening + shallow-vertex merging, arrow, rect, ellipse). A trailing hand-drawn V on a line/polyline is detected as an **arrow ending** (`arrowEnd`): the head is stripped from the shaft and rebuilt as clean wing points appended to the same editable polyline (`withArrowhead`).
- `cad/` — the **CAD mode**: 2D parametric sketching (Fusion/SolveSpace-style) reusing the stroke recognizer. `cad/sketch.js` (pure model: points, line/circle entities, constraints, named parameters), `cad/solver.js` (pure damped Gauss–Newton least-squares constraint solver; drag = pinned point, under-constrained handled via a weak stay-put prior), `cad/expr.js` (tiny expression evaluator for dimensions/parameters — deliberately not mathjs to keep the bundle small), `cad/cad-mode.js` (Fabric integration: stroke → entities with auto H/V/coincident/point-on-line constraints, tap-to-select in CAD mode via the stray-dot click trick, constraint/dimension commands, marker-drag re-solve in Select mode, board persistence via `registerBoardExtension`, and the `cadApi*` functions backing the voice agent's `cad_*` tools), `cad/cad-menu.js` (floating context menu beside the CAD selection — content-aware constraint/dimension chips with live measured values; H/V/Fix act as toggles), `cad/cad-panel.js` (params + constraint list + DOF/solve status panel). The sketch model is the source of truth; all CAD Fabric objects are disposable renderings (`_cad` prop, `_noHistory`, `excludeFromExport`) rebuilt after each solve. Undo pushes whole-sketch JSON snapshots as composite steps. The three pure modules are unit-tested in `test/cad-core.test.mjs`.
- `node-edit.js` — `enablePointEditing(poly)` gives a Fabric Polyline/Polygon one draggable handle per vertex (custom controls) so lines/segments can be reshaped in Select mode; body-drag still moves it. Recognized lines/polylines/polygons are built as editable Polylines/Polygons.
- `edge-snap.js` — pure geometry for snapping a point to the nearest shape edge (`snapPointToShapes`) + target-local coordinate transforms (`toTargetLocal`/`fromTargetLocal`) used by sticky anchors.
- `snap-move.js` — Select-mode "Align" snapping: moving/resizing snaps bbox edges/centres to other objects with pink guide lines (guides are `excludeFromExport` + `_noHistory`).
- `history.js` — command-stack undo; `suspend()` + `pushComposite()` turn multi-step operations into one undo step.
- `region-select.js` — the ⛶ "Analyze region" marquee (scopes extraction to the lassoed ink).
- `boards.js` + `boards-panel.js` — localStorage board autosave and the collapsible left panel (create/rename/switch/delete). Serialization goes through `canvas.toObject(EXTRA_PROPS)`; custom props that must survive save/load (ids, `_isGraph`, `_plot`, anchors as `_anchors` → rebuilt to `_edgeAnchors`, …) are listed in `EXTRA_PROPS` there — extend that list when adding new persistent object metadata. Board-scoped state living outside the Fabric object list (e.g. the CAD sketch) registers via `registerBoardExtension({ key, save, load })` and is stored under `ext_<key>` in the board JSON.
- `state.js` — cookie helpers + `sw_uid`; restores settings selects on startup.
- `graph.js` — renders Chart.js to an **offscreen** canvas at the displayed pixel size (`devicePixelRatio: 1`; constant line/font px, tick density adapts to size), then inserts the result as a Fabric image (tagged `_isGraph`, params on `_plot`). Multiple independent graphs; `replotGraph` re-renders one in place (resize handler in `api.js`'s `initGraphResize`).
- `voice.js` — Gemini Live client: mic → 16k PCM16 + ~1 fps JPEG board frames (with a coordinate-grid overlay: numbered 10-lines on all four edges, faint 5-lines) over WebSocket to `/voice`; plays audio replies; executes tool calls; injects the stored placement calibration as a session-start note.
- `canvas-actions.js` — executes the voice agent's tools (draw/style/reorder/label/plot/solve, the **CAD sketch tools** `cad_sketch_*`/`cad_get_sketch`/`cad_constrain`/`cad_dimension`/`cad_set_param`/`cad_delete` — positions in board percent, dimension values in sketch units, every result reports solve status + DOF — and the placement **self-calibration**: `calibrate_start`/`calibrate_check`/`calibrate_reset`). Coordinates are board-percent; `cx,cy` = center placement; `boxId` auto-fits text inside a shape; `fromVideo: true` marks eye-read coordinates and applies the stored linear correction model mechanically (trust-gated, clamped ±10, persisted in localStorage `sw_voicecal`). Tool declarations + system prompt live in `voice-server.js` — keep the two in sync when adding tools. The system prompt is organised as: what's on the board → coordinates → a plan/act/verify/correct working loop → subset-selection → task recipes (bulk restyle, clean redraw, layout & reorder, dimensioned technical drawing, teach-with-a-diagram) → ids & calibration → CAD. `move_object` takes either absolute `toCx,toCy` (layout) or relative `dx,dy` (nudge).
- `speech.js` — Web Speech API voice commands (note: locale is hardcoded to `sv-SE`).

**Fabric.js is v6** — use named imports (`import { Canvas, IText } from 'fabric'`), not the v5 `fabric.X` global style.

### Key cross-cutting patterns

- **All UI behavior lives in the bundle.** `public/index.html` has **no inline script** (de-duplicated in §4.2) — every handler is wired in `src/` on `DOMContentLoaded`. A few `window` globals remain as a light bridge/state holder: `window.canvas`, `window.solveEquation`, `window.extractedEquationData` (last extracted equation), and `window.appendToOutput` (back-compat alias; `api.js` imports `appendToOutput` from `output.js` directly).
- **End-to-end analyze flow:** draw → collect plain ink Paths (or the ink inside a drag-selected region via the ⛶ "Analyze region" button, `region-select.js`) → `cropObjects` (JPEG of just that ink) → `POST /extract` (`{ image, provider }`) → store JSON on `window.extractedEquationData` → replace the ink with clean text in place → open the contextual menu. Plotting is not automatic: the menu's **Plot** action (or the 📈 toolbar button) calls `drawGraph()` → `/graph` → `renderGraph` draws via Chart.js offscreen and adds a Fabric image (`_isGraph`).
- **Undo** is a command stack (`history.js`): adds/removals/modifications recorded via canvas events; multi-step ops (smart-shape snap, extract-in-place, clear) push one composite by suspending recording. Snapping a shape no longer leaves a ghost — undo restores the original stroke.

## Notes / known rough edges

- `AGENTS.md` is partially outdated: it predates the phase-1 refactor that split the old `src/index.js` monolith into the modules above and deleted the dead `public/js/app.js`. Trust the actual `src/` layout over that file.
- `public/test.html` is a standalone scratch page, not part of the app.
- Webpack `mode` defaults to development; use `build:prod` for deployable output.
- Commit style in history is Conventional Commits (`feat:`, `fix:`, `refactor:`).
