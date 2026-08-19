// debug/sessions.js — debug session lifecycle: branch, transcript, event stream.
//
// A session is one bug being worked on: a git feature branch, the conversation
// between the user (speaking, relayed by the voice assistant) and the coding
// agent, and the stream of events the UI shows. Turns run one at a time; a
// message that arrives while the agent is working is queued and picked up as
// soon as it finishes, so the user can keep talking.
//
// Sessions are written to .debug-sessions/ so that a server restart — which the
// agent itself causes every time it pushes, since nodemon reloads — does not
// lose the conversation. The browser re-attaches by id after reconnecting.

const fs = require('fs');
const path = require('path');
const agent = require('./agent');
const workspace = require('./workspace');
const { normalizeBugReport, branchNameFor, formatBugReport, shortLabel } = require('./bug-report');

const STORE_DIR = path.join(workspace.REPO_ROOT, '.debug-sessions');
const MAX_EVENTS = 300;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const sessions = new Map(); // id -> session
const listeners = new Map(); // id -> Set<fn>

function newId() {
    return 'dbg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isConfigured() {
    return agent.isConfigured();
}

// ---- persistence ------------------------------------------------------------

function storePath(id) {
    return path.join(STORE_DIR, `${id}.json`);
}

// A session file holds the whole transcript, screenshot included — megabytes.
// The picker only needs the header, so it is written alongside as a small
// companion file and the list never opens the big ones.
function metaPath(id) {
    return path.join(STORE_DIR, `${id}.meta.json`);
}

function persist(session) {
    try {
        fs.mkdirSync(STORE_DIR, { recursive: true });
        fs.writeFileSync(storePath(session.id), JSON.stringify(session), 'utf8');
        fs.writeFileSync(metaPath(session.id), JSON.stringify(publicState(session)), 'utf8');
    } catch (e) {
        console.warn('debug session persist failed:', e.message);
    }
}

// Re-attach to a session created before the last restart.
function load(id) {
    if (sessions.has(id)) return sessions.get(id);
    try {
        const session = JSON.parse(fs.readFileSync(storePath(id), 'utf8'));
        if (session.status === 'working') {
            // The restart killed the turn mid-flight (usually the agent's own push).
            session.status = 'idle';
            session.events = (session.events || []).concat([
                { kind: 'info', message: 'The server restarted while I was working — say "carry on" to continue.', at: Date.now() },
            ]);
        }
        session.pending = [];
        session.cancelled = false;
        sessions.set(id, session);
        return session;
    } catch (e) {
        return null;
    }
}

function get(id) {
    return sessions.get(id) || load(id);
}

// ---- events -----------------------------------------------------------------

function subscribe(id, fn) {
    if (!listeners.has(id)) listeners.set(id, new Set());
    listeners.get(id).add(fn);
    return () => {
        const set = listeners.get(id);
        if (set) {
            set.delete(fn);
            if (!set.size) listeners.delete(id);
        }
    };
}

function emit(session, event) {
    const withTime = { ...event, at: Date.now() };
    session.events.push(withTime);
    if (session.events.length > MAX_EVENTS) session.events = session.events.slice(-MAX_EVENTS);
    const set = listeners.get(session.id);
    if (set) for (const fn of set) {
        try { fn(withTime); } catch (e) { /* a dead listener must not break the run */ }
    }
}

// Everything the UI needs, without the (large) model transcript.
function publicState(session) {
    if (!session) return null;
    return {
        id: session.id,
        title: session.report.title,
        label: shortLabel(session.report),
        branch: session.branch,
        baseBranch: session.baseBranch,
        status: session.status,
        model: agent.MODEL,
        createdAt: session.createdAt,
        changedFiles: session.changedFiles || [],
        commits: session.commits || [],
        pushed: !!session.pushed,
        needsReload: !!session.needsReload,
        lastSummary: session.lastSummary || '',
        queued: (session.pending || []).length,
        warnings: session.warnings || [],
    };
}

// ---- creation ---------------------------------------------------------------

// Split a screenshot (data URL or bare base64) into an Anthropic image block.
function imageBlock(screenshot) {
    if (typeof screenshot !== 'string' || screenshot.length < 100) return null;
    if (screenshot.length > MAX_SCREENSHOT_BYTES) return null;
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(screenshot);
    const mediaType = m ? m[1] : 'image/jpeg';
    const data = m ? m[2] : screenshot;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

// Where a new session's branch should start from.
//
// If the deployment is sitting on an earlier session's debug branch, branching
// from HEAD would silently inherit that session's commits — which is how a first
// session ends up abandoned at its base while a second one carries its work. So
// walk back to what that session itself started from, and make sure the branch
// being left behind is pushed rather than orphaned locally.
async function resolveBase() {
    const current = await workspace.currentBranch();
    const owner = list().find((s) => s.branch === current);
    if (!owner) return { base: current, preserved: null };

    let preserved = null;
    const unpushed = await workspace.unpushedCount(current);
    if (unpushed !== 0) {
        const ahead = await workspace.commitsAhead(current, owner.baseBranch);
        if (ahead > 0) {
            const res = await workspace.push(current);
            preserved = { branch: current, commits: ahead, pushed: res.ok, message: res.message };
            const prior = sessions.get(owner.id);
            if (prior) {
                emit(prior, {
                    kind: 'info',
                    message: res.ok
                        ? `Pushed ${ahead} commit(s) on ${current} before a new debug session started.`
                        : `Could not push ${current} before a new session started: ${res.message}`,
                });
            }
        }
    }
    return { base: owner.baseBranch, preserved };
}

async function create({ report: rawReport, context, screenshot } = {}) {
    if (!isConfigured()) {
        throw new Error('The debug coding agent is not configured — the server needs ANTHROPIC_API_KEY.');
    }
    const { report, warnings } = normalizeBugReport(rawReport);
    const { base: baseBranch, preserved } = await resolveBase();
    // Uncommitted work in the deployment's tree comes along onto the new branch
    // (git's own behaviour). Say so in the briefing rather than letting the agent
    // mistake someone else's edits for its own.
    const dirty = await workspace.isDirty();
    const branch = branchNameFor(report, new Date());
    await workspace.createBranch(branch, baseBranch);
    const commit = await workspace.headCommit();

    const image = imageBlock(screenshot);
    const briefing = formatBugReport(report, context, {
        branch,
        baseBranch,
        commit,
        hasScreenshot: !!image,
    });

    const session = {
        id: newId(),
        report,
        warnings,
        branch,
        baseBranch,
        baseCommit: commit,
        status: 'idle',
        createdAt: Date.now(),
        events: [],
        messages: [{
            role: 'user',
            content: [
                ...(image ? [image] : []),
                {
                    type: 'text',
                    text: briefing +
                        (dirty
                            ? '\n\nNOTE: the working tree already had uncommitted changes when this branch was ' +
                              'created — they are not yours. Check git_diff before committing so you do not ship them ' +
                              'by accident.'
                            : '') +
                        '\n\nInvestigate and fix this. Start now.',
                },
            ],
        }],
        changedFiles: [],
        commits: [],
        pending: [],
        cancelled: false,
    };
    sessions.set(session.id, session);
    session.preserved = preserved;
    emit(session, { kind: 'info', message: `Debug session started on branch ${branch} (from ${baseBranch}).` });
    persist(session);
    return session;
}

// ---- running ----------------------------------------------------------------

// Add something the user said to the transcript. A turn usually ends on a
// tool_result — which is itself a user-role message — so this appends rather
// than pushing a second consecutive user turn, which the API rejects.
function appendUserText(session, text) {
    const last = session.messages[session.messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text });
    } else {
        session.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    }
}

async function runQueue(session) {
    if (session.status === 'working' || session.status === 'ended') return;
    session.status = 'working';
    session.cancelled = false;
    emit(session, { kind: 'status', status: 'working' });

    // Between turns the session is idle and watch-branch.sh is free to move the
    // shared checkout elsewhere (e.g. a newer push from another session). Lock
    // it for the whole turn — including the re-checkout below, in case that's
    // exactly what happened — so nothing switches branches out from under the
    // agent while it edits, commits and pushes.
    workspace.lockWorkspace(session.branch);
    try {
        await workspace.createBranch(session.branch);
        while (true) {
            if (session.pending.length) {
                appendUserText(session, session.pending.splice(0, session.pending.length).join('\n\n'));
            }
            const result = await agent.runTurn(
                session,
                (event) => emit(session, event),
                { isCancelled: () => session.cancelled }
            );
            session.lastSummary = result.summary;
            session.needsReload = session.needsReload || result.needsReload;
            session.pushed = session.pushed || result.pushed;
            persist(session);
            if (!session.pending.length || session.cancelled) break;
        }
        session.status = 'idle';
        emit(session, { kind: 'status', status: 'idle' });
    } catch (e) {
        session.status = 'error';
        emit(session, { kind: 'error', message: (e && e.message) || String(e) });
        emit(session, { kind: 'status', status: 'error' });
    } finally {
        workspace.unlockWorkspace();
    }
    persist(session);
}

// Hand the agent something the user said. Returns immediately: agent turns take
// far longer than a voice tool call may block, so progress arrives as events.
function send(session, text) {
    const message = String(text || '').trim();
    if (!message) return { ok: false, message: 'Nothing to send.' };
    if (session.status === 'ended') return { ok: false, message: 'This debug session has ended.' };
    session.pending.push(message);
    emit(session, { kind: 'user', message });
    if (session.status !== 'working') {
        runQueue(session); // fire and forget — events carry the outcome
        return { ok: true, queued: false, status: 'working' };
    }
    return { ok: true, queued: true, status: 'working', queueLength: session.pending.length };
}

function cancel(session) {
    session.cancelled = true;
    session.pending = [];
    emit(session, { kind: 'info', message: 'Stopping after the current step.' });
    return { ok: true };
}

async function end(session, { push = true } = {}) {
    session.cancelled = true;
    session.pending = [];
    let pushResult = null;
    if (push) {
        workspace.lockWorkspace(session.branch);
        try {
            await workspace.createBranch(session.branch);
            const dirty = await workspace.isDirty();
            if (dirty) {
                const commit = await workspace.commitAll(`chore: wip from debug session ${session.id}`, session.branch);
                if (commit.ok) pushResult = await workspace.push(session.branch);
            }
        } finally {
            workspace.unlockWorkspace();
        }
    }
    session.status = 'ended';
    emit(session, { kind: 'status', status: 'ended' });
    emit(session, {
        kind: 'info',
        message: `Session closed. Work is on ${session.branch}${pushResult && pushResult.ok ? ' (pushed)' : ''}.`,
    });
    persist(session);
    return { ok: true, branch: session.branch, pushed: !!(pushResult && pushResult.ok) };
}

// Every session this server knows about, newest first: the live ones plus the
// headers of any left on disk by an earlier run. This is what the picker in the
// debug panel lists, the same way the boards panel lists saved boards.
function list() {
    const live = new Map(Array.from(sessions.values()).map((s) => [s.id, publicState(s)]));
    let files = [];
    try {
        files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.meta.json'));
    } catch (e) {
        files = []; // no store yet
    }
    for (const file of files) {
        const id = file.replace(/\.meta\.json$/, '');
        if (live.has(id)) continue;
        try {
            const meta = JSON.parse(fs.readFileSync(path.join(STORE_DIR, file), 'utf8'));
            // A session persisted mid-turn was cut off by the restart, not left working.
            if (meta.status === 'working') meta.status = 'idle';
            live.set(id, meta);
        } catch (e) { /* skip a corrupt header */ }
    }
    return Array.from(live.values()).sort((a, b) => b.createdAt - a.createdAt);
}

// Forget a session: drop it from memory and delete its files. The git branch is
// deliberately left alone — the work on it is the whole point.
function remove(id) {
    const session = sessions.get(id);
    if (session && session.status === 'working') {
        return { ok: false, message: 'That session is still working — stop or end it first.' };
    }
    if (session) {
        session.cancelled = true;
        sessions.delete(id);
    }
    listeners.delete(id);
    for (const file of [storePath(id), metaPath(id)]) {
        try { fs.rmSync(file, { force: true }); } catch (e) { /* already gone */ }
    }
    return { ok: true, id };
}

module.exports = {
    isConfigured, create, get, send, cancel, end, list, remove, subscribe, publicState, emit, STORE_DIR,
};
