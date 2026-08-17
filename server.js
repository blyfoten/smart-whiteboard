// server.js
require('dotenv').config();

// The git watcher pulls but does not run `npm install`. If a declared SDK is
// missing (e.g. just added in a pulled commit), install dependencies before
// continuing so providers come up without manual intervention. Runs once at
// startup, only when something is actually missing. Disable with NO_AUTO_INSTALL=1.
function ensureDependencies() {
    if (process.env.NO_AUTO_INSTALL) return;
    const required = ['openai', '@google/genai', '@anthropic-ai/sdk'];
    const missing = required.filter((mod) => {
        try {
            require.resolve(mod);
            return false;
        } catch (e) {
            return true;
        }
    });
    if (missing.length === 0) return;
    console.warn(`📦 Missing dependencies (${missing.join(', ')}) — running npm install...`);
    try {
        require('child_process').execSync('npm install', { cwd: __dirname, stdio: 'inherit' });
        console.warn('📦 npm install complete.');
    } catch (e) {
        console.error('📦 Auto npm install failed:', e.message);
        console.error('   Affected providers stay disabled until installed manually.');
    }
}
ensureDependencies();

// The git watcher pulls but doesn't rebuild the webpack bundle. If webpack
// --watch isn't running, the served bundle goes stale. Rebuild it on startup
// when any src/*.js is newer than public/dist/bundle.js. Disable with NO_AUTO_BUILD=1.
// The newest mtime under src/ — RECURSIVELY. src/cad/ lives a level down, and
// a check that only scanned the top level reported "up to date" after a pull
// that changed nothing but src/cad/*.js, so that work never reached the served
// bundle. webpack.config.js counts too: a config change re-bundles everything.
function newestSourceMtime() {
    const fs = require('fs');
    const path = require('path');
    let newest = 0;
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.name.endsWith('.js')) {
                try {
                    const m = fs.statSync(full).mtimeMs;
                    if (m > newest) newest = m;
                } catch (e) { /* vanished mid-scan */ }
            }
        }
    };
    walk(path.join(__dirname, 'src'));
    for (const file of ['webpack.config.js', '.babelrc']) {
        try {
            const m = fs.statSync(path.join(__dirname, file)).mtimeMs;
            if (m > newest) newest = m;
        } catch (e) { /* optional */ }
    }
    return newest;
}

function bundleIsStale() {
    const fs = require('fs');
    const path = require('path');
    let bundleMtime = 0;
    try {
        bundleMtime = fs.statSync(path.join(__dirname, 'public', 'dist', 'bundle.js')).mtimeMs;
    } catch (e) {
        return true; // missing bundle
    }
    const newest = newestSourceMtime();
    return !newest ? false : bundleMtime < newest;
}

let _lastBuildAttempt = 0;
function buildBundle(reason) {
    // Don't stampede: a failing build must not re-run on every request, and a
    // webpack --watch rebuild in flight will settle on its own.
    if (Date.now() - _lastBuildAttempt < 15000) return false;
    _lastBuildAttempt = Date.now();
    console.warn(`📦 ${reason} — running npm run build...`);
    try {
        require('child_process').execSync('npm run build', { cwd: __dirname, stdio: 'inherit' });
        // webpack skips writing a bundle whose content is unchanged ("compared
        // for emit"), leaving the old mtime behind — which would read as stale
        // forever and rebuild on every request. Stamp it as built.
        const fs = require('fs');
        const path = require('path');
        const now = new Date();
        try {
            fs.utimesSync(path.join(__dirname, 'public', 'dist', 'bundle.js'), now, now);
        } catch (e) { /* build produced no bundle — the next check will retry */ }
        console.warn('📦 Bundle build complete.');
        return true;
    } catch (e) {
        console.error('📦 Auto build failed:', e.message);
        return false;
    }
}

function ensureBundle() {
    if (process.env.NO_AUTO_BUILD) return;
    if (bundleIsStale()) buildBundle('Bundle missing or stale');
}
ensureBundle();

const express = require('express');
const bodyParser = require('body-parser');
const math = require('mathjs');
const cors = require('cors');
const path = require('path');

// Vision/solve providers live behind a small interface (providers/). Model IDs
// are centralized and env-overridable there.
const providers = require('./providers');
const catalogue = require('./providers/catalogue');
const { validateExtraction } = require('./providers/schema');

const app = express();
const PORT = process.env.PORT || 3000;

// Warn loudly at startup instead of failing opaquely at request time.
if (!process.env.OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY is not set — OpenAI (gpt) requests will fail.');
if (!process.env.GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY is not set — Gemini requests will fail.');
if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is not set — Claude requests will fail.');

// Minimal in-memory per-IP rate limiter for the billable AI endpoints. Not a
// substitute for real auth — just a guard so a public instance can't be trivially
// drained of API credits.
function rateLimit({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
    }, windowMs).unref();
    return (req, res, next) => {
        const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
        const now = Date.now();
        let rec = hits.get(ip);
        if (!rec || now - rec.start > windowMs) {
            rec = { start: now, count: 0 };
            hits.set(ip, rec);
        }
        rec.count++;
        if (rec.count > max) {
            return res.status(429).json({ success: false, message: 'Rate limit exceeded — please slow down.' });
        }
        next();
    };
}
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

// Middleware
app.use(bodyParser.json({ limit: '10mb' })); // Increase size limit for large images

// Lock down CORS: allow same-origin / non-browser requests (no Origin header)
// and any origin in ALLOWED_ORIGINS (comma-separated). Other cross-origin browser
// calls get no CORS headers and are blocked by the browser. The app itself is
// served same-origin, so this doesn't affect normal use.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
    },
}));
// Keep the served bundle honest. nodemon deliberately does NOT watch src/ (a
// restart would drop live voice sessions — see nodemon.json), so a git pull that
// only changes src/ never reaches the startup check above. Without this, the
// repository has the fix and the browser is still running the old code: exactly
// how a pushed CAD change ended up invisible in the app. Rebuilding here is a
// no-op whenever webpack --watch is running, and costs a few stat calls.
app.use((req, res, next) => {
    if (process.env.NO_AUTO_BUILD) return next();
    if (req.method !== 'GET') return next();
    const wantsApp = req.path === '/' || req.path === '/index.html' || req.path === '/dist/bundle.js';
    if (wantsApp && bundleIsStale()) buildBundle('Bundle is stale on request');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve the living improvement/feature plan at /plan
app.get('/plan', (req, res) => {
    res.sendFile(path.join(__dirname, 'docs', 'improvement-plan.html'));
});

// The model-tier catalogue the UI renders its picker from. Clients send a tier
// KEY ('fast' | 'balanced' | 'max'), never a model id — see providers/catalogue.js.
app.get('/models', (req, res) => res.json(catalogue.publicCatalogue()));

// Debug / bug-fix mode: the backend coding agent that works on this repository.
// Inactive unless DEBUG_AGENT_ENABLED=1 — see debug-routes.js.
const { attachDebugRoutes } = require('./debug-routes');
attachDebugRoutes(app, { limiter: aiLimiter });

// Shared handler for vision extraction across providers.
async function handleExtract(req, res, providerName) {
    const { image, tier } = req.body;
    if (!image) {
        return res.json({ success: false, message: 'No image received.' });
    }
    const provider = providers.get(providerName);
    if (!provider || !provider.extract) {
        return res.json({ success: false, message: `Unknown provider: ${providerName}` });
    }
    if (!provider.isConfigured()) {
        return res.json({ success: false, message: `${providerName} is not configured on the server.` });
    }
    try {
        const model = catalogue.resolveModel(providerName, tier, 'vision');
        const data = await provider.extract(image, model);
        const errorMessage = validateExtraction(data);
        if (errorMessage) {
            return res.json({ success: false, message: errorMessage });
        }
        return res.json({
            success: true,
            equation: data.expression,
            dependentVariable: data.dependentVariable,
            scope: data.scope,
            ranges: data.ranges,
        });
    } catch (error) {
        console.error(`Error extracting with ${providerName}:`, error.message);
        return res.json({ success: false, message: 'Error processing the image.' });
    }
}

// Unified extraction endpoint — `provider` selects the vision model.
app.post('/extract', aiLimiter, (req, res) => handleExtract(req, res, req.body.provider || 'openai'));

// Back-compat aliases for older clients / cached bundles.
app.post('/extract-equation', aiLimiter, (req, res) => handleExtract(req, res, 'openai'));
app.post('/extract-equation-gemini', aiLimiter, (req, res) => handleExtract(req, res, 'gemini'));

// API endpoint to solve equations with the selected model.
app.post('/solve', aiLimiter, async (req, res) => {
    const { equation, model = 'math', tier } = req.body;
    try {
        if (model === 'math') {
            const result = math.evaluate(equation);
            return res.json({ success: true, result });
        }
        const provider = providers.get(model); // 'gpt' -> openai, 'gemini' -> gemini
        if (!provider || !provider.solve) {
            return res.json({ success: false, message: 'Invalid model specified.' });
        }
        if (!provider.isConfigured()) {
            return res.json({ success: false, message: `${model} is not configured on the server.` });
        }
        const result = await provider.solve(equation, catalogue.resolveModel(model, tier, 'solve'));
        if (result) {
            return res.json({ success: true, result });
        }
        return res.json({ success: false, message: `Error solving equation with ${model}.` });
    } catch (error) {
        console.error(`Error solving "${equation}" with ${model}:`, error.message);
        return res.json({ success: false, message: `Error solving equation: ${error.message}` });
    }
});

// Graph endpoint — pure math.js.
app.post('/graph', (req, res) => {
    const { expression, dependentVariable, scope, ranges } = req.body;
    const variable = Object.keys(scope)[0]; // Assume first variable in scope is the one to plot
    const [start, end] = ranges[variable];
    const step = (end - start) / 100; // 100 points for the graph

    try {
        const expr = math.parse(expression).compile();
        let data = [];

        for (let x = start; x <= end; x += step) {
            let currentScope = { ...scope, [variable]: x };
            let y = expr.evaluate(currentScope);
            if (typeof y === 'number' && isFinite(y)) {
                data.push({ x, y });
            }
        }

        res.json({ success: true, data, dependentVariable });
    } catch (error) {
        res.json({ success: false, message: 'Invalid equation or parameters.' });
    }
});

// Start the server with port fallback
const fs = require('fs');
const http = require('http');
const https = require('https');
const { attachVoiceServer } = require('./voice-server');
const HOST = process.env.HOST || '0.0.0.0';
const CERT_DIR = process.env.CERT_DIR || '/etc/letsencrypt/live/cfor2.asuscomm.com';

function startServer(port) {
    let server;
    try {
        const tlsOptions = {
            key:  fs.readFileSync(`${CERT_DIR}/privkey.pem`),
            cert: fs.readFileSync(`${CERT_DIR}/fullchain.pem`),
        };
        server = https.createServer(tlsOptions, app);
        server.on('listening', () => console.log(`Server running on https://${HOST}:${port}`));
    } catch (err) {
        console.warn(`HTTPS unavailable (${err.message}), falling back to HTTP.`);
        server = http.createServer(app);
        server.on('listening', () => console.log(`Server running on http://${HOST}:${port}`));
    }
    attachVoiceServer(server); // WebSocket relay for the Gemini Live voice mode
    server
        .on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log(`Port ${port} is already in use, trying port ${port + 1}...`);
                startServer(port + 1);
            } else {
                console.error('Error starting server:', err);
            }
        });
    server.listen(port, HOST);
}

// Start the server with initial port
startServer(PORT);
