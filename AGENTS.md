# AGENTS.md — Smart Whiteboard

## Projektöversikt

Interaktiv whiteboard-webapp: rita ekvationer för hand, AI känner igen dem, löser och plottar grafer.

**Stack:** Node.js/Express backend, Fabric.js canvas, Chart.js grafer, Webpack bundling.
**AI-backends:** OpenAI GPT-4o (vision + solving), Google Gemini 2.0 Flash, Math.js (lokal).

## Arkitektur

```
public/index.html  <- Allt UI (inline styles + scripts)
src/index.js       <- ~900 rader: canvas, ritning, AI-anrop, grafritning, rost
server.js          <- Express API: /extract-equation, /solve, /graph, /extract-equation-gemini
public/js/app.js   <- DEAD CODE (gammal Fabric v5-syntax, ersatt av src/index.js)
```

## Kanda problem

1. public/js/app.js ar dead code - ta bort
2. src/index.js ar en 900-raders monolit
3. Duplicerad eventlistener-logik med cloneNode-hack
4. Ingen .env.example
5. Ingen felhantering vid saknade API-nycklar
6. Hardcodade modellnamn i server.js
7. Ingen touch-optimering (darlig pa surfplatta)
8. Webpack i dev mode, ingen production config
9. console.log med API-nycklar i klartext (server.js rad 2-3)
10. Inga tester

## Konventioner

- Kor `npm run build` efter andringar i src/
- API-nycklar i `.env` (OPENAI_API_KEY, GEMINI_API_KEY)
- Git: conventional commits (feat/fix/refactor)

## Byggkommandon

```bash
npm install          # Installera dependencies
npm run build        # Webpack bundle
npm start            # Starta server (port 3000)
npm run dev          # Watch + server
```
