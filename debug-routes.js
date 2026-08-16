// debug-routes.js — HTTP surface for the debug / bug-fix mode.
//
// The voice path drives these through the WebSocket relay (voice-server.js), but
// they are also the plain HTTP API behind the debug panel's text box — so a
// session can be started, steered and closed without saying a word.
//
// SAFETY: this feature hands a coding agent write access to the repository the
// site is served from, and lets it push. It is therefore OFF unless the server
// is started with DEBUG_AGENT_ENABLED=1, and can additionally require a shared
// secret (DEBUG_AGENT_TOKEN) sent as X-Debug-Token.

const sessions = require('./debug/sessions');

function isEnabled() {
    return process.env.DEBUG_AGENT_ENABLED === '1' || process.env.DEBUG_AGENT_ENABLED === 'true';
}

function tokenOk(req) {
    const expected = process.env.DEBUG_AGENT_TOKEN;
    if (!expected) return true;
    const got = req.get('X-Debug-Token') || (req.body && req.body.token) || req.query.token;
    return got === expected;
}

// Why the feature is unavailable, in the words the assistant should relay.
function unavailableReason() {
    if (!isEnabled()) {
        return 'Debug mode is switched off on this server. Start it with DEBUG_AGENT_ENABLED=1 to let the coding agent work on the repository.';
    }
    if (!sessions.isConfigured()) {
        return 'The coding agent needs ANTHROPIC_API_KEY (or CLAUDE_API_KEY) set on the server.';
    }
    return null;
}

function available() {
    return unavailableReason() === null;
}

function attachDebugRoutes(app, { limiter } = {}) {
    const pass = (req, res, next) => next();
    const limit = limiter || pass;

    const guard = (req, res, next) => {
        const reason = unavailableReason();
        if (reason) return res.status(503).json({ success: false, message: reason });
        if (!tokenOk(req)) return res.status(403).json({ success: false, message: 'Invalid debug token.' });
        next();
    };

    const withSession = (req, res) => {
        const session = sessions.get(req.params.id);
        if (!session) {
            res.status(404).json({ success: false, message: 'No such debug session.' });
            return null;
        }
        return session;
    };

    // Whether the UI should offer debug mode at all. Session headers come along
    // when the caller is allowed to see them, so the panel can render its picker
    // in one round trip.
    app.get('/debug/status', (req, res) => {
        res.json({
            success: true,
            enabled: available(),
            reason: unavailableReason(),
            requiresToken: !!process.env.DEBUG_AGENT_TOKEN,
            sessions: available() && tokenOk(req) ? sessions.list() : [],
        });
    });

    // Every session this server knows about, live or left on disk — the picker.
    app.get('/debug/sessions', guard, (req, res) => {
        res.json({ success: true, sessions: sessions.list() });
    });

    // Forget a session (its branch is kept — the work on it is the point).
    app.delete('/debug/session/:id', guard, (req, res) => {
        const result = sessions.remove(req.params.id);
        res.status(result.ok ? 200 : 409).json({ success: result.ok, ...result });
    });

    app.post('/debug/session', limit, guard, async (req, res) => {
        try {
            const session = await sessions.create({
                report: req.body.report || req.body,
                context: req.body.context,
                screenshot: req.body.screenshot,
            });
            res.json({ success: true, session: sessions.publicState(session), warnings: session.warnings });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    app.get('/debug/session/:id', guard, (req, res) => {
        const session = withSession(req, res);
        if (!session) return;
        const since = Number(req.query.since) || 0;
        res.json({
            success: true,
            session: sessions.publicState(session),
            events: session.events.filter((e) => e.at > since),
        });
    });

    app.post('/debug/session/:id/message', limit, guard, (req, res) => {
        const session = withSession(req, res);
        if (!session) return;
        const result = sessions.send(session, req.body.text);
        res.json({ success: result.ok !== false, ...result, session: sessions.publicState(session) });
    });

    app.post('/debug/session/:id/cancel', guard, (req, res) => {
        const session = withSession(req, res);
        if (!session) return;
        res.json({ success: true, ...sessions.cancel(session) });
    });

    app.post('/debug/session/:id/end', guard, async (req, res) => {
        const session = withSession(req, res);
        if (!session) return;
        try {
            const result = await sessions.end(session, { push: req.body.push !== false });
            res.json({ success: true, ...result, session: sessions.publicState(session) });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // Server-sent events: live agent activity for the panel.
    app.get('/debug/session/:id/events', guard, (req, res) => {
        const session = withSession(req, res);
        if (!session) return;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const write = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const since = Number(req.query.since) || 0;
        session.events.filter((e) => e.at > since).forEach(write);
        const unsubscribe = sessions.subscribe(session.id, write);
        const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
            clearInterval(keepAlive);
            unsubscribe();
        });
    });

    console.log(
        available()
            ? '🛠️  Debug agent routes enabled (/debug/*) — model: ' + require('./debug/agent').MODEL
            : '🛠️  Debug agent routes registered but inactive: ' + unavailableReason()
    );
}

module.exports = { attachDebugRoutes, isEnabled, available, unavailableReason };
