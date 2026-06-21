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
function ensureBundle() {
    if (process.env.NO_AUTO_BUILD) return;
    const fs = require('fs');
    const path = require('path');
    const bundlePath = path.join(__dirname, 'public', 'dist', 'bundle.js');
    const srcDir = path.join(__dirname, 'src');
    let bundleMtime = 0;
    try {
        bundleMtime = fs.statSync(bundlePath).mtimeMs;
    } catch (e) {
        bundleMtime = 0; // missing bundle
    }
    let newestSrc = 0;
    try {
        for (const f of fs.readdirSync(srcDir)) {
            if (f.endsWith('.js')) {
                const m = fs.statSync(path.join(srcDir, f)).mtimeMs;
                if (m > newestSrc) newestSrc = m;
            }
        }
    } catch (e) {
        return; // no src dir — nothing to build
    }
    if (bundleMtime && bundleMtime >= newestSrc) return; // up to date
    console.warn('📦 Bundle missing or stale — running npm run build...');
    try {
        require('child_process').execSync('npm run build', { cwd: __dirname, stdio: 'inherit' });
        console.warn('📦 Bundle build complete.');
    } catch (e) {
        console.error('📦 Auto build failed:', e.message);
    }
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
app.use(express.static(path.join(__dirname, 'public')));

// Serve the living improvement/feature plan at /plan
app.get('/plan', (req, res) => {
    res.sendFile(path.join(__dirname, 'docs', 'improvement-plan.html'));
});

// Shared handler for vision extraction across providers.
async function handleExtract(req, res, providerName) {
    const { image } = req.body;
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
        const data = await provider.extract(image);
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
    const { equation, model = 'math' } = req.body;
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
        const result = await provider.solve(equation);
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
