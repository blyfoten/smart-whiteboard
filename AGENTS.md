# AGENTS.md — Smart Whiteboard

Instruktioner för AI-agenter som arbetar i det här repot. Den fullständiga
arkitekturkartan finns i **CLAUDE.md** — läs den först; den här filen är
konventionerna och fällorna.

## Projektöversikt

Interaktiv whiteboard-webapp: rita ekvationer för hand, AI känner igen dem,
löser och plottar grafer. Numera även röstläge (Gemini Live), smarta former,
CAD-skisser med constraint-solver och ett felsökningsläge med en kodagent.

**Stack:** Node.js/Express backend, Fabric.js **v6** canvas, Chart.js grafer,
Webpack bundling.
**AI-backends:** OpenAI, Google Gemini, Anthropic Claude (alla bakom
`providers/`, modellnivåer i `providers/catalogue.js`), Math.js lokalt.

## Arkitektur (kort)

```
public/index.html   <- UI-markup + styles. INGEN inline-JS.
src/                <- ES-moduler, buntas av webpack till public/dist/bundle.js
src/cad/            <- parametrisk CAD: sketch-modell, solver, Fabric-integration
providers/          <- en modul per AI-leverantör bakom ett gemensamt interface
server.js           <- Express API: /extract, /solve, /graph, /models, /debug/*
voice-server.js     <- WebSocket-relä mot Gemini Live + verktygsdeklarationer
debug/              <- felsökningsläget: bug-report, sandbox, kodagent, sessioner
test/               <- rena Node-tester (ingen ramverk): node test/*.test.mjs
```

## Konventioner

- Kör `npm run build` efter ändringar i `src/` — webbläsaren laddar
  `public/dist/bundle.js`, inte källfilerna. Utan bygge syns ingenting.
- Kör `npm test` innan du committar.
- Fabric är **v6**: namngivna importer (`import { Canvas } from 'fabric'`),
  aldrig `fabric.X`.
- API-nycklar i `.env` (se `.env.example`). Rör aldrig `.env` i kod.
- Git: conventional commits (`feat:`, `fix:`, `refactor:`).
- Skriv kod och kommentarer i samma stil som filen omkring — kommentarer
  förklarar *varför*, inte *vad*.

## Fällor värda att känna till

1. **Ett nytt rösverktyg måste kopplas in på tre ställen.** Deklarationen i
   `voice-server.js`, ett `case` i `executeAction` i `src/canvas-actions.js`,
   och själva implementationen (t.ex. `cadApi*` i `src/cad/cad-mode.js`).
   Missas dispatchen får modellen ett verktyg som svarar
   `unknown action: <namn>` — deklarerat men dött.
2. **Nya objektfält som ska överleva spara/ladda** måste läggas till i
   `EXTRA_PROPS` i `src/boards.js`, annars tappas de vid serialisering.
   Tillstånd utanför Fabric-objektlistan registreras med
   `registerBoardExtension`.
3. **CAD-skissen är sanningen**, Fabric-objekten är bara en ritning av den och
   byggs om efter varje lösning. Ändra modellen, inte ritningen.
4. Rena moduler (`shape-classifier.js`, `cad/expr.js`, `cad/sketch.js`,
   `cad/solver.js`, `debug/bug-report.js`, `debug/workspace.js`) är
   enhetstestade — lägg till ett test när du ändrar dem.

## Byggkommandon

```bash
npm install          # Installera dependencies
npm run build        # Webpack bundle (dev)
npm run build:prod   # Minifierad bundle
npm start            # Starta server (port 3000)
npm run dev          # webpack --watch + nodemon
npm test             # Alla rena logiktester
```

---

# The online code agent (debug mode)

This section is for the coding agent in `debug/agent.js` — the one a user
reaches by telling the voice assistant that the app itself is broken. It is
loaded into that agent's system prompt. If you are working from a normal
checkout, this is background; if you are the online agent, these are your
operating rules.

## Where you are

You are running **inside the live deployment**, on the machine that serves the
page the user is looking at. The repository is the real one, and your branch
is deployed the moment you push: `watch-branch.sh` follows the most recently
updated remote branch, and `npm run dev` (webpack `--watch` + nodemon) serves
it. Nothing you do is a dry run, and nothing ships until `commit_and_push`.

The user is standing at a whiteboard, talking. They cannot see your tool calls
— only what `notify_user` and `finish` say out loud.

## Before you call commit_and_push

- [ ] **Named the actual defect** — the line, the missing case, the wrong
      assumption. Not "probably something in the classifier".
- [ ] **Rebuilt** if you touched `src/` (`run_task: build`). The browser loads
      `public/dist/bundle.js`; source edits alone change nothing for the user.
- [ ] **Ran the tests** (`run_task: test`) and added one if you changed a pure
      module. A test that asserted the old behaviour should be *updated*, not
      deleted — and never left failing.
- [ ] **Wired every layer** of anything you added. The three-place rule for
      voice tools above is the one that gets missed: declaration in
      `voice-server.js`, dispatch in `src/canvas-actions.js`, implementation in
      the module. Check with `search_code` that your new name appears in all of
      them before you commit.
- [ ] **Read your own diff** (`git_diff`). If it contains changes you did not
      make, they belong to someone else — do not ship them.
- [ ] **Set `needsReload`** in `finish` when the fix touched `src/` or
      `public/`, so the user is told to reload.

## Scope

Fix what was reported. No refactors on the way past, no new dependencies
unless the fix genuinely needs one, no reformatting of files you are only
reading. A small diff that lands beats a large one that has to be reviewed
while someone waits.

If the report is not enough to act on, say so through `notify_user` with the
*one* question that would settle it, rather than guessing and shipping.

## Talking to the user

`notify_user` is a spoken sentence, not a log line: use it when you start
something slow, when you learn what the cause is, and when you are blocked.
`finish` ends your turn with a one or two sentence summary — plain words, no
file paths unless they matter, and honest about anything you could not verify.
