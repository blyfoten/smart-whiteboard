// debug/bug-report.js — the hand-off "skill" the voice assistant uses to move a
// problem from the whiteboard conversation to the backend coding agent.
//
// The voice model does NOT talk to git or the repo. Its job at hand-off time is
// to DESCRIBE the problem well: what the user did, what happened, what should
// have happened, plus whatever the app can supply automatically (a screenshot of
// the board, captured console errors, app state). This module is the contract
// for that: normalise whatever the model passed, decide the branch name, and
// render the whole thing as the markdown briefing the coding agent wakes up to.
//
// Pure — no fs, no network, no git — so it is unit-tested in
// test/debug-core.test.mjs.

const SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'];
const DEFAULT_SEVERITY = 'major';

// Areas of the app, used to point the agent at the right corner of the tree.
// Free-form values are kept as-is; these just get a file hint attached.
const AREA_HINTS = {
    voice: ['src/voice.js', 'src/canvas-actions.js', 'voice-server.js'],
    debug: ['debug/', 'src/debug-panel.js', 'voice-server.js'],
    cad: ['src/cad/'],
    canvas: ['src/canvas.js', 'src/modes.js', 'src/shapes.js', 'src/shape-classifier.js'],
    shapes: ['src/shapes.js', 'src/shape-classifier.js', 'src/modes.js'],
    graph: ['src/graph.js', 'src/api.js'],
    math: ['src/api.js', 'providers/', 'server.js'],
    boards: ['src/boards.js', 'src/boards-panel.js'],
    ui: ['src/ui.js', 'public/index.html', 'src/draw-toolbar.js'],
    server: ['server.js', 'providers/'],
};

function str(value, max = 4000) {
    if (value == null) return '';
    return String(value).replace(/\s+$/g, '').slice(0, max);
}

function strList(value, max = 20) {
    if (value == null) return [];
    const raw = Array.isArray(value) ? value : String(value).split(/\r?\n/);
    return raw
        .map((v) => str(v, 500).trim())
        .filter(Boolean)
        .slice(0, max);
}

// A git-safe branch segment: lowercase, alphanumerics and single dashes only.
function slugify(text, maxLength = 32) {
    let slug = str(text, 200)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (slug.length > maxLength) {
        slug = slug.slice(0, maxLength);
        // Prefer cutting at a word boundary — a branch ending in "…-sha" reads
        // like a typo, "…-erased" reads like a name.
        const lastDash = slug.lastIndexOf('-');
        if (lastDash > maxLength / 2) slug = slug.slice(0, lastDash);
    }
    return slug.replace(/^-|-$/g, '') || 'issue';
}

function stamp(date) {
    const d = date instanceof Date && !isNaN(date) ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// The branch the coding agent works on. Prefixed so the git watcher on the box
// (watch-branch.sh, which follows the most recently updated remote branch) shows
// clearly what it switched to.
function branchNameFor(report, date, prefix = 'debug') {
    return `${prefix}/${slugify(report && report.title)}-${stamp(date)}`;
}

// Accept the loose object a language model produces and return a well-formed
// report plus warnings about anything it left out. Never throws: a thin report
// is still worth acting on, the warnings just tell the model what to add.
function normalizeBugReport(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const warnings = [];

    const summary = str(input.summary || input.problem || input.description, 4000).trim();
    const title = str(input.title, 120).trim() || summary.split(/[.\n]/)[0].slice(0, 80).trim();

    const severity = SEVERITIES.includes(String(input.severity || '').toLowerCase())
        ? String(input.severity).toLowerCase()
        : DEFAULT_SEVERITY;

    const area = str(input.area, 40).trim().toLowerCase();
    const suspectedFiles = strList(input.suspectedFiles, 12);
    const hinted = AREA_HINTS[area] || [];
    for (const hint of hinted) if (!suspectedFiles.includes(hint)) suspectedFiles.push(hint);

    const report = {
        title: title || 'Unnamed issue',
        summary,
        stepsToReproduce: strList(input.stepsToReproduce || input.steps, 20),
        expected: str(input.expected, 2000).trim(),
        actual: str(input.actual, 2000).trim(),
        area,
        severity,
        suspectedFiles,
        userQuote: str(input.userQuote, 2000).trim(),
        wanted: str(input.wanted || input.requestedFix, 2000).trim(),
    };

    if (!report.summary) warnings.push('No summary was given — describe what is wrong in a sentence or two.');
    if (!report.stepsToReproduce.length) warnings.push('No steps to reproduce — say what the user did, in order.');
    if (!report.expected) warnings.push('No expected behaviour — say what should have happened.');
    if (!report.actual && report.summary) report.actual = report.summary;

    return { report, warnings };
}

function bullets(items) {
    return items.map((s) => `- ${s}`).join('\n');
}

function numbered(items) {
    return items.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

// Render the browser-side context capture (see src/debug-capture.js) into the
// briefing. Everything here is optional — the capture is best-effort.
function formatContext(context) {
    const ctx = context && typeof context === 'object' ? context : {};
    const lines = [];

    if (ctx.url) lines.push(`- Page: ${str(ctx.url, 300)}`);
    if (ctx.userAgent) lines.push(`- Browser: ${str(ctx.userAgent, 300)}`);
    if (ctx.viewport) lines.push(`- Viewport: ${str(ctx.viewport, 60)}`);
    if (ctx.mode) lines.push(`- Interaction mode: ${str(ctx.mode, 40)}`);
    if (ctx.model) lines.push(`- Selected AI model/tier: ${str(ctx.model, 60)}`);
    if (ctx.board) lines.push(`- Board: ${str(ctx.board, 300)}`);
    if (ctx.cad) lines.push(`- CAD sketch: ${str(ctx.cad, 300)}`);
    if (ctx.lastVoiceTools && ctx.lastVoiceTools.length) {
        lines.push(`- Recent voice tool calls: ${strList(ctx.lastVoiceTools, 12).join(', ')}`);
    }

    const sections = [];
    if (lines.length) sections.push(`## App state at the time\n${lines.join('\n')}`);

    const errors = strList(ctx.errors, 25);
    if (errors.length) {
        sections.push(
            '## Console errors captured in the browser\n' +
            'These are real errors from the running page — treat them as primary evidence.\n' +
            '```\n' + errors.join('\n').slice(0, 6000) + '\n```'
        );
    }

    const logs = strList(ctx.logs, 40);
    if (logs.length) {
        sections.push('## Recent console output\n```\n' + logs.join('\n').slice(0, 4000) + '\n```');
    }

    return sections.join('\n\n');
}

// The markdown briefing handed to the coding agent as its first user message.
function formatBugReport(report, context, extra) {
    const r = report || {};
    const meta = extra && typeof extra === 'object' ? extra : {};
    const parts = [`# Bug report: ${r.title || 'Unnamed issue'}`];

    const facts = [`- Severity: ${r.severity || DEFAULT_SEVERITY}`];
    if (r.area) facts.push(`- Area: ${r.area}`);
    if (meta.branch) facts.push(`- Working branch: \`${meta.branch}\``);
    if (meta.baseBranch) facts.push(`- Branched from: \`${meta.baseBranch}\``);
    if (meta.commit) facts.push(`- Base commit: \`${meta.commit}\``);
    if (meta.hasScreenshot) facts.push('- A screenshot of the whiteboard at the time is attached above.');
    parts.push(facts.join('\n'));

    if (r.summary) parts.push(`## What is wrong\n${r.summary}`);
    if (r.stepsToReproduce && r.stepsToReproduce.length) {
        parts.push(`## Steps to reproduce\n${numbered(r.stepsToReproduce)}`);
    }
    if (r.expected) parts.push(`## Expected\n${r.expected}`);
    if (r.actual) parts.push(`## Actual\n${r.actual}`);
    if (r.wanted) parts.push(`## What the user asked for\n${r.wanted}`);
    if (r.userQuote) parts.push(`## In the user's own words\n> ${r.userQuote.replace(/\n/g, '\n> ')}`);
    if (r.suspectedFiles && r.suspectedFiles.length) {
        parts.push(`## Places worth looking first\n${bullets(r.suspectedFiles)}\n\nThese are hints from the voice assistant, not conclusions — verify before you edit.`);
    }

    const ctx = formatContext(context);
    if (ctx) parts.push(ctx);

    return parts.join('\n\n') + '\n';
}

// One-line description for the panel / voice summary.
function shortLabel(report) {
    const r = report || {};
    return `${r.title || 'Unnamed issue'}${r.area ? ` (${r.area})` : ''}`;
}

module.exports = {
    SEVERITIES,
    DEFAULT_SEVERITY,
    AREA_HINTS,
    slugify,
    branchNameFor,
    normalizeBugReport,
    formatBugReport,
    formatContext,
    shortLabel,
};
