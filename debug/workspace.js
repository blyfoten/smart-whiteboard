// debug/workspace.js — the sandbox the backend coding agent works in.
//
// Everything the agent is allowed to touch goes through here: file reads/writes
// are confined to the repository (no `..` escapes, no .git/.env/node_modules),
// and the only commands it can run are a fixed set of npm/git tasks invoked with
// execFile (no shell, so nothing it writes can be injected as a command).
//
// The path/command guards are pure functions and unit-tested in
// test/debug-core.test.mjs; the fs/git wrappers are thin on top of them.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// Never readable or writable by the agent: credentials, git internals, build
// output and installed packages. `.env.example` stays readable on purpose.
const DENIED = [
    /^\.git(\/|$)/,
    /^node_modules(\/|$)/,
    /^\.env$/,
    /^\.env\.(?!example$)[^/]*$/, // .env.example is documentation, not a secret
    /^\.debug-sessions(\/|$)/,
    /(^|\/)\.ssh(\/|$)/,
];

// Directories skipped when listing/searching — huge and never interesting.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.debug-sessions', '.cache']);

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 12000;

class WorkspaceError extends Error {}

// Repo-relative, normalised, guaranteed inside the repo and not denied.
// Returns { rel, abs }; throws WorkspaceError otherwise.
function resolveInRepo(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
        throw new WorkspaceError('A file path is required.');
    }
    const cleaned = relPath.trim().replace(/^\.\//, '');
    if (path.isAbsolute(cleaned)) {
        // Absolute paths are accepted only when they point inside the repo.
        const abs = path.resolve(cleaned);
        if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
            throw new WorkspaceError(`Path is outside the repository: ${relPath}`);
        }
        return resolveInRepo(path.relative(REPO_ROOT, abs) || '.');
    }
    const abs = path.resolve(REPO_ROOT, cleaned);
    if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
        throw new WorkspaceError(`Path escapes the repository: ${relPath}`);
    }
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    if (rel && DENIED.some((re) => re.test(rel))) {
        throw new WorkspaceError(`Path is off limits to the debug agent: ${rel}`);
    }
    return { rel: rel || '.', abs };
}

function isTextFile(rel) {
    return !/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|mp[34]|wav)$/i.test(rel);
}

function truncate(text, max = MAX_OUTPUT_CHARS) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max) + `\n… [truncated, ${s.length - max} more characters]`;
}

// ---- files ------------------------------------------------------------------

function listFiles(relDir = '.', { depth = 2, limit = 400 } = {}) {
    const { rel, abs } = resolveInRepo(relDir);
    const out = [];
    const walk = (dirAbs, dirRel, level) => {
        if (out.length >= limit) return;
        let entries;
        try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch (e) {
            throw new WorkspaceError(`Cannot list ${dirRel}: ${e.message}`);
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (out.length >= limit) return;
            if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
            if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
            const childRel = dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`;
            if (entry.isDirectory()) {
                out.push(`${childRel}/`);
                if (level < depth) walk(path.join(dirAbs, entry.name), childRel, level + 1);
            } else {
                let size = 0;
                try { size = fs.statSync(path.join(dirAbs, entry.name)).size; } catch (e) { /* ignore */ }
                out.push(`${childRel} (${size} bytes)`);
            }
        }
    };
    walk(abs, rel, 0);
    return out;
}

function readFile(relPath, { startLine, endLine } = {}) {
    const { rel, abs } = resolveInRepo(relPath);
    let stat;
    try {
        stat = fs.statSync(abs);
    } catch (e) {
        throw new WorkspaceError(`No such file: ${rel}`);
    }
    if (stat.isDirectory()) throw new WorkspaceError(`${rel} is a directory — use list_files.`);
    if (!isTextFile(rel)) throw new WorkspaceError(`${rel} is a binary asset and cannot be read as text.`);
    if (stat.size > MAX_READ_BYTES && !startLine) {
        throw new WorkspaceError(
            `${rel} is ${stat.size} bytes — too large to read at once. Pass startLine/endLine to read a slice.`
        );
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const from = Math.max(1, Number(startLine) || 1);
    const to = Math.min(lines.length, Number(endLine) || (Number(startLine) ? from + 400 : lines.length));
    const slice = lines.slice(from - 1, to).map((line, i) => `${from + i}\t${line}`);
    return {
        path: rel,
        totalLines: lines.length,
        startLine: from,
        endLine: to,
        content: truncate(slice.join('\n'), 60000),
    };
}

function writeFile(relPath, content) {
    const { rel, abs } = resolveInRepo(relPath);
    const text = String(content == null ? '' : content);
    if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) {
        throw new WorkspaceError(`Refusing to write ${rel}: over ${MAX_WRITE_BYTES} bytes.`);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, text, 'utf8');
    return { path: rel, created: !existed, bytes: Buffer.byteLength(text, 'utf8') };
}

// Exact-string replacement, the same contract as an editor's find/replace: the
// old string must appear, and must be unique unless replaceAll is set.
function editFile(relPath, oldString, newString, replaceAll = false) {
    const { rel, abs } = resolveInRepo(relPath);
    if (typeof oldString !== 'string' || oldString === '') {
        throw new WorkspaceError('oldString is required and must not be empty.');
    }
    if (!fs.existsSync(abs)) throw new WorkspaceError(`No such file: ${rel}`);
    const before = fs.readFileSync(abs, 'utf8');
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) {
        throw new WorkspaceError(`oldString not found in ${rel} — read the file again and match it exactly.`);
    }
    if (occurrences > 1 && !replaceAll) {
        throw new WorkspaceError(
            `oldString appears ${occurrences} times in ${rel} — include more context to make it unique, or pass replaceAll.`
        );
    }
    const after = replaceAll
        ? before.split(oldString).join(String(newString == null ? '' : newString))
        : before.replace(oldString, String(newString == null ? '' : newString));
    fs.writeFileSync(abs, after, 'utf8');
    return { path: rel, replacements: replaceAll ? occurrences : 1 };
}

// Regex search over the tree — implemented in JS so the agent does not depend on
// ripgrep/grep being installed on the box.
function searchCode(pattern, { dir = '.', filePattern, maxResults = 60, ignoreCase = true } = {}) {
    let re;
    try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (e) {
        throw new WorkspaceError(`Invalid search pattern: ${e.message}`);
    }
    let fileRe = null;
    if (filePattern) {
        try {
            fileRe = new RegExp(filePattern, 'i');
        } catch (e) {
            throw new WorkspaceError(`Invalid filePattern: ${e.message}`);
        }
    }
    const { rel: rootRel, abs: rootAbs } = resolveInRepo(dir);
    const hits = [];
    const walk = (dirAbs, dirRel) => {
        if (hits.length >= maxResults) return;
        let entries = [];
        try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            if (hits.length >= maxResults) return;
            if (entry.name.startsWith('.')) continue;
            if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
            const childRel = dirRel === '.' ? entry.name : `${dirRel}/${entry.name}`;
            const childAbs = path.join(dirAbs, entry.name);
            if (entry.isDirectory()) {
                walk(childAbs, childRel);
                continue;
            }
            if (!isTextFile(childRel)) continue;
            if (fileRe && !fileRe.test(childRel)) continue;
            let text;
            try {
                if (fs.statSync(childAbs).size > MAX_READ_BYTES) continue;
                text = fs.readFileSync(childAbs, 'utf8');
            } catch (e) { continue; }
            const lines = text.split('\n');
            for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
                if (re.test(lines[i])) hits.push(`${childRel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            }
        }
    };
    walk(rootAbs, rootRel);
    return hits;
}

// ---- commands ---------------------------------------------------------------

// The complete set of commands the agent may run. Nothing here takes input from
// the model except the values explicitly interpolated by the git helpers below,
// and every invocation is execFile (no shell).
const TASKS = {
    build: { cmd: 'npm', args: ['run', 'build'], timeout: 180000, label: 'npm run build' },
    test: { cmd: 'npm', args: ['test'], timeout: 180000, label: 'npm test' },
    install: { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'], timeout: 600000, label: 'npm install' },
};

function isAllowedTask(task) {
    return Object.prototype.hasOwnProperty.call(TASKS, task);
}

function run(cmd, args, { timeout = 60000, env } = {}) {
    return new Promise((resolve) => {
        execFile(
            cmd,
            args,
            { cwd: REPO_ROOT, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(env || {}) } },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
                    stdout: truncate(stdout),
                    stderr: truncate(stderr),
                    error: error ? error.message : null,
                });
            }
        );
    });
}

async function runTask(task) {
    if (!isAllowedTask(task)) {
        throw new WorkspaceError(`Unknown task "${task}". Allowed: ${Object.keys(TASKS).join(', ')}.`);
    }
    const spec = TASKS[task];
    const res = await run(spec.cmd, spec.args, { timeout: spec.timeout });
    return { task, command: spec.label, ...res };
}

// ---- git --------------------------------------------------------------------

const git = (args, opts) => run('git', args, { timeout: 120000, ...opts });

async function gitText(args) {
    const res = await git(args);
    return res.ok ? res.stdout.trim() : '';
}

async function currentBranch() {
    return (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
}

async function headCommit() {
    return (await gitText(['rev-parse', '--short', 'HEAD'])) || '';
}

async function isDirty() {
    return !!(await gitText(['status', '--porcelain']));
}

// Create (or switch to) a branch. `from` pins the starting point — without it
// git branches from whatever is checked out, so a second debug session would
// inherit the first session's commits instead of starting clean.
async function createBranch(name, from) {
    const res = await git(from ? ['checkout', '-b', name, from] : ['checkout', '-b', name]);
    if (!res.ok) {
        // Already exists (e.g. a resumed session) — just switch to it.
        const sw = await git(['checkout', name]);
        if (!sw.ok) throw new WorkspaceError(`Could not create or switch to branch ${name}: ${res.stderr || res.error}`);
    }
    return name;
}

// How many commits on `branch` are not on origin/<branch>. -1 means the branch
// has never been pushed, so everything on it is unpushed.
async function unpushedCount(branch) {
    const exists = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (!exists.ok) return -1;
    const count = await gitText(['rev-list', '--count', `origin/${branch}..${branch}`]);
    return Number(count) || 0;
}

// Does this branch carry commits the base branch does not? Used to tell an
// abandoned-but-empty debug branch from one holding real work.
async function commitsAhead(branch, base) {
    const count = await gitText(['rev-list', '--count', `${base}..${branch}`]);
    return Number(count) || 0;
}

async function status() {
    return {
        branch: await currentBranch(),
        commit: await headCommit(),
        porcelain: await gitText(['status', '--porcelain']),
    };
}

async function diff({ staged = false, stat = false } = {}) {
    const args = ['diff'];
    if (staged) args.push('--staged');
    if (stat) args.push('--stat');
    const res = await git(args);
    return truncate(res.stdout || '(no changes)');
}

const COMMIT_NAME = process.env.DEBUG_AGENT_GIT_NAME || 'Whiteboard Debug Agent';
const COMMIT_EMAIL = process.env.DEBUG_AGENT_GIT_EMAIL || 'debug-agent@smart-whiteboard.local';

// watch-branch.sh polls this same working directory and can `checkout` between
// an agent turn's steps. lockWorkspace() (held for the whole turn) is the main
// guard; this is the backstop for the sliver it doesn't cover — commitAll/push
// refuse to act if HEAD has drifted off the branch the caller expects, instead
// of silently committing or pushing the wrong branch's work.
async function commitAll(message, expectedBranch) {
    const msg = String(message || '').trim();
    if (!msg) throw new WorkspaceError('A commit message is required.');
    if (expectedBranch) {
        const on = await currentBranch();
        if (on !== expectedBranch) {
            return {
                ok: false,
                message: `refusing to commit: workspace is checked out on ${on}, not ${expectedBranch} ` +
                    '(something switched branches mid-turn)',
            };
        }
    }
    const add = await git(['add', '-A']);
    if (!add.ok) return { ok: false, message: `git add failed: ${add.stderr || add.error}` };
    const staged = await gitText(['diff', '--staged', '--name-only']);
    if (!staged) return { ok: false, message: 'Nothing to commit — no files changed.' };
    const res = await git([
        '-c', `user.name=${COMMIT_NAME}`,
        '-c', `user.email=${COMMIT_EMAIL}`,
        'commit', '-m', msg,
    ]);
    if (!res.ok) return { ok: false, message: `git commit failed: ${res.stderr || res.error}` };
    return { ok: true, commit: await headCommit(), files: staged.split('\n').filter(Boolean) };
}

// Push with the same backoff the repo's other network steps use — a transient
// DNS/TLS hiccup should not fail a fix that is already committed.
async function push(branch, { attempts = 4 } = {}) {
    const on = await currentBranch();
    if (on !== branch) {
        return {
            ok: false,
            branch,
            message: `refusing to push ${branch}: workspace is checked out on ${on} instead ` +
                '(something switched branches mid-turn)',
        };
    }
    let last = null;
    for (let i = 0; i < attempts; i++) {
        const res = await git(['push', '-u', 'origin', branch], { timeout: 180000 });
        if (res.ok) return { ok: true, branch, output: res.stdout || res.stderr };
        last = res;
        const transient = /could not resolve|timed out|connection|network|ssl|tls|502|503/i.test(
            `${res.stderr} ${res.error}`
        );
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, i)));
    }
    return { ok: false, branch, message: (last && (last.stderr || last.error)) || 'push failed' };
}

// A debug session holds this lock for the whole time it owns the shared
// working directory (session creation through the end of each turn), so
// watch-branch.sh knows to leave the checkout alone. Best-effort: if the
// write fails, commitAll/push's branch checks above are still there to catch
// the fallout instead of silently mis-committing.
const LOCK_PATH = path.join(REPO_ROOT, '.debug-sessions', '.workspace-lock');

function lockWorkspace(branch) {
    try {
        fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
        fs.writeFileSync(LOCK_PATH, branch, 'utf8');
    } catch (e) { /* best-effort */ }
}

function unlockWorkspace() {
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch (e) { /* already gone */ }
}

module.exports = {
    REPO_ROOT,
    WorkspaceError,
    resolveInRepo,
    isAllowedTask,
    TASKS,
    truncate,
    listFiles,
    readFile,
    writeFile,
    editFile,
    searchCode,
    runTask,
    currentBranch,
    headCommit,
    isDirty,
    createBranch,
    unpushedCount,
    commitsAhead,
    status,
    diff,
    commitAll,
    push,
    lockWorkspace,
    unlockWorkspace,
};
