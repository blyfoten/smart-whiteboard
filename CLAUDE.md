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

There is **no test runner and no linter** configured. `npm test` does nothing.

**Critical:** the browser loads `public/dist/bundle.js`, which is the webpack output. Editing anything under `src/` has no effect until you `npm run build` (or run `npm run dev` for watch mode). Always rebuild after changing `src/`.

Requires a `.env` file with `OPENAI_API_KEY` and `GEMINI_API_KEY` (see `.env.example`). Missing keys are not validated — calls just fail at request time.

## Architecture

A single-page whiteboard app: draw a handwritten equation, an AI vision model reads it into structured JSON, the equation is evaluated and plotted as a graph rendered back onto the canvas.

### Backend — `server.js` (Express, single file)

Four POST endpoints:
- `/extract-equation` — OpenAI **gpt-4o** vision (raw `axios`). Takes a base64 image, returns `{ dependentVariable, expression, scope, ranges }` for math.js.
- `/extract-equation-gemini` — same contract via Google **Gemini** using the **`@google/genai`** SDK with `responseMimeType: 'application/json'` (so no markdown-fence stripping is needed; a brace-substring fallback remains as defense).
- `/solve` — text equation solver, dispatched by a `model` field: `'math'` (mathjs, local), `'gpt'` (gpt-4, `axios`), `'gemini'` (`@google/genai`).
- `/graph` — pure math.js: compiles `expression`, samples 100 points over the first variable's range, returns `[{x, y}]`.

The Gemini model is **`GEMINI_MODEL`** (env-overridable, default `gemini-2.5-flash`; `gemini-2.0-flash` was shut down 2026-06-01). OpenAI model names are still hardcoded in `server.js`. The three billable endpoints (`/extract-equation`, `/extract-equation-gemini`, `/solve`) share an in-memory per-IP `aiLimiter` (30 req/min). Missing API keys are warned about at startup (and `genAI` is `null` when `GEMINI_API_KEY` is absent, so the server still boots). Both extract endpoints still duplicate their prompt/validation logic (not yet factored out — see plan §3.4).

### Frontend — ES modules in `src/`, bundled by webpack

`src/index.js` is a thin orchestrator wired up on `DOMContentLoaded`. Module responsibilities:
- `canvas.js` — Fabric.js canvas lifecycle (singleton via `getCanvas()`), free-draw brush, resize, bounding-box detection, crop-to-content (exports a JPEG data URL for the vision API), pinch-to-zoom/pan, undo, save-PNG, clear.
- `api.js` — all `fetch` calls to the backend; owns the extract → graph data flow.
- `ui.js` — button/dropdown event wiring, the `currentModel` state (`getCurrentModel()`), and the double-click-to-add-IText behavior.
- `graph.js` — renders Chart.js to an **offscreen** canvas, then inserts the result as a Fabric image object (tagged `_isGraph`) onto the whiteboard.
- `speech.js` — Web Speech API voice commands (note: locale is hardcoded to `sv-SE`).

**Fabric.js is v6** — use named imports (`import { Canvas, IText } from 'fabric'`), not the v5 `fabric.X` global style.

### Key cross-cutting patterns

- **`window` globals are the bridge** between the bundle and the inline `<script>` in `public/index.html`. The bundle exposes `window.canvas`, `window.solveEquation`, `window.extractedEquationData`, and `window.appendToOutput` (the function that writes result cards into the output panel). State like the last extracted equation lives on `window.extractedEquationData`.
- **Buttons are wired in two places.** `src/ui.js` (`initializeEventListeners`) AND the inline script in `public/index.html` both attach handlers to several buttons (`solve-eq-btn`, `clear-btn`, model-select, add-test-equation). When changing button behavior, check both. The inline script handles Clear and the test-equation input directly; `ui.js` handles extract/solve/graph/undo/save and dynamically creates a few buttons if absent.
- **End-to-end graph flow:** draw → `cropCanvasToBoundingBox` (JPEG data URL) → `/extract-equation[-gemini]` → store JSON on `window.extractedEquationData` → `/graph` → `renderGraph` draws via Chart.js offscreen and adds a Fabric image.

## Notes / known rough edges

- `AGENTS.md` is partially outdated: it predates the phase-1 refactor that split the old `src/index.js` monolith into the modules above and deleted the dead `public/js/app.js`. Trust the actual `src/` layout over that file.
- `public/test.html` is a standalone scratch page, not part of the app.
- Webpack `mode` defaults to development; use `build:prod` for deployable output.
- Commit style in history is Conventional Commits (`feat:`, `fix:`, `refactor:`).
