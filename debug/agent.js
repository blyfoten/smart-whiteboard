// debug/agent.js — the backend coding agent.
//
// A small, self-contained tool loop on top of the Anthropic SDK (already a
// dependency for the Claude provider). It sees the repository through
// debug/workspace.js — read, search, write, edit, run the repo's own npm tasks,
// commit and push to the session's feature branch. That push is what makes the
// change live: the box runs watch-branch.sh (follow the newest remote branch) +
// webpack --watch / nodemon, so a pushed commit is pulled, rebuilt and served.
//
// The agent never gets a shell: every command is one of a fixed set of npm/git
// tasks in the workspace module.

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');

let Anthropic = null;
try {
    Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
    console.warn('⚠️  `@anthropic-ai/sdk` not installed — the debug coding agent is disabled. Run `npm install`.');
}

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
const client = Anthropic && apiKey ? new Anthropic({ apiKey }) : null;

// Sonnet is the default: strong enough to fix real bugs, cheap enough to leave
// running behind a voice conversation. Override per deployment.
const MODEL = process.env.DEBUG_AGENT_MODEL || 'claude-sonnet-5';
const MAX_STEPS = Number(process.env.DEBUG_AGENT_MAX_STEPS) || 40;
const MAX_TOKENS = Number(process.env.DEBUG_AGENT_MAX_TOKENS) || 8000;

function isConfigured() {
    return !!client;
}

// The repo documents itself; hand that to the agent instead of duplicating an
// architecture summary here that would drift out of date.
//
// AGENTS.md goes in WHOLE and first — it carries this agent's own operating
// rules (the pre-commit checklist, the three-places-to-wire-a-voice-tool trap).
// CLAUDE.md is the architecture map and is much longer, so it is the one that
// gets capped, and the cap is announced rather than silently swallowing the end
// of the file.
function readDoc(name, limit) {
    let text;
    try {
        text = fs.readFileSync(path.join(workspace.REPO_ROOT, name), 'utf8');
    } catch (e) {
        return `(${name} not found.)`;
    }
    if (text.length <= limit) return text;
    return text.slice(0, limit) +
        `\n\n… [${name} truncated here — read the rest with read_file if you need it.]`;
}

function projectBrief() {
    return `--- AGENT INSTRUCTIONS (AGENTS.md) ---\n${readDoc('AGENTS.md', 12000)}\n\n` +
        `--- ARCHITECTURE MAP (CLAUDE.md) ---\n${readDoc('CLAUDE.md', 20000)}`;
}

function systemPrompt(session) {
    return `You are the backend coding agent for the Smart Whiteboard app. You have been handed a bug report by the app's voice assistant, and you work directly in the running deployment's git repository.

YOUR BRANCH: ${session.branch} (created for this session from ${session.baseBranch}). Everything you do belongs on it — never switch branches.

HOW YOUR WORK REACHES THE USER
The box that serves the app runs a git watcher that follows the most recently updated remote branch, plus webpack --watch and nodemon. So: commit and push, and the running site picks the change up within seconds. Nothing ships until you call commit_and_push — an edit alone changes only the working tree.
IMPORTANT: the browser loads public/dist/bundle.js, which webpack builds from src/. After changing anything under src/, run the build task before you commit so a deployment without a watcher still serves the fix.

HOW TO WORK
1. REPRODUCE FROM EVIDENCE. Read the bug report, the console errors and the app state before touching code. Then find the responsible code with search_code and read_file. Do not guess at a fix from the description alone.
2. STATE THE CAUSE. Before editing, be able to name the actual defect — the line or the missing case. If the evidence does not support one, say so and ask the user (through notify_user) for the one thing that would settle it.
3. FIX MINIMALLY. Change what is broken, in the style of the surrounding code. No refactors, no drive-by cleanups, no new dependencies unless the fix genuinely needs one.
4. VERIFY. Run the test task (plain-node checks under test/) and the build task. A build error means the bundle is broken for everyone — never push one.
5. SHIP. commit_and_push with a Conventional Commits message (fix: / feat: / refactor:), then finish with a short summary. Say plainly if you pushed something you could not verify.
6. TALK BACK. The user is in a live voice conversation and hears what you send with notify_user. Use it when you start on something slow, when you learn what the cause is, and when you need a decision — one short sentence, no code, no filenames unless they matter.

If the user's next message changes the task, follow it — the conversation continues while you work.

Keep the whole exchange short and factual. You are talking to someone standing at a whiteboard, not writing a report.

The project's own documentation follows. AGENTS.md has a section addressed to YOU ("The online code agent") with a pre-commit checklist — follow it; it exists because of mistakes made on earlier sessions.

${projectBrief()}`;
}

const TOOLS = [
    {
        name: 'list_files',
        description: 'List files and directories in the repository. Start here when you need the lay of the land.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-relative directory, default "."' },
                depth: { type: 'number', description: 'How many levels to descend (default 2).' },
            },
        },
    },
    {
        name: 'read_file',
        description: 'Read a text file from the repository, with line numbers. Pass startLine/endLine to read a slice of a big file.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
            },
            required: ['path'],
        },
    },
    {
        name: 'search_code',
        description: 'Regex search across the repository. Returns file:line: matched-line. Use it to find where a symbol, string or behaviour lives.',
        input_schema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'JavaScript regular expression.' },
                filePattern: { type: 'string', description: 'Optional regex the file path must match, e.g. "src/.*\\.js$".' },
                dir: { type: 'string', description: 'Optional subdirectory to search in.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'write_file',
        description: 'Create a file or overwrite it completely. For changing part of an existing file prefer edit_file — a full overwrite loses anything you did not re-type.',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
        },
    },
    {
        name: 'edit_file',
        description: 'Replace an exact string in a file. oldString must appear exactly once unless replaceAll is true — include surrounding context to make it unique.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                oldString: { type: 'string' },
                newString: { type: 'string' },
                replaceAll: { type: 'boolean' },
            },
            required: ['path', 'oldString', 'newString'],
        },
    },
    {
        name: 'run_task',
        description: "Run one of the repository's own commands: 'test' (node checks in test/), 'build' (webpack src/ -> public/dist/bundle.js), 'install' (npm install). Nothing else can be run.",
        input_schema: {
            type: 'object',
            properties: { task: { type: 'string', enum: ['test', 'build', 'install'] } },
            required: ['task'],
        },
    },
    {
        name: 'git_diff',
        description: 'Show the uncommitted changes in the working tree. Pass stat=true for a summary instead of the full patch. Review this before committing.',
        input_schema: { type: 'object', properties: { stat: { type: 'boolean' } } },
    },
    {
        name: 'commit_and_push',
        description: 'Commit every change in the working tree and push the session branch to origin. This is what deploys the fix. Use a Conventional Commits message ("fix: ...").',
        input_schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
        },
    },
    {
        name: 'notify_user',
        description: 'Say one short sentence to the user, out loud, while you keep working. Use it for progress on something slow, the cause once you find it, or a question you need answered.',
        input_schema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
        },
    },
    {
        name: 'finish',
        description: 'End your turn. Give a one or two sentence spoken summary of what you did or found, and set the flags so the app can tell the user what to do next.',
        input_schema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'What you did or found, in one or two spoken sentences.' },
                pushed: { type: 'boolean', description: 'True if you committed and pushed a change.' },
                needsReload: { type: 'boolean', description: 'True if the fix touched src/ or public/ and the user must reload the page to see it.' },
                needsUser: { type: 'boolean', description: 'True if you stopped because you need something from the user.' },
            },
            required: ['summary'],
        },
    },
];

// Execute one tool call. Returns { content, meta } — content is what the model
// sees, meta carries anything the session/UI needs (e.g. a push happened).
async function executeTool(name, input, session) {
    const args = input && typeof input === 'object' ? input : {};
    switch (name) {
        case 'list_files':
            return { content: workspace.listFiles(args.path || '.', { depth: Number(args.depth) || 2 }).join('\n') || '(empty)' };
        case 'read_file': {
            const res = workspace.readFile(args.path, { startLine: args.startLine, endLine: args.endLine });
            return { content: `${res.path} (lines ${res.startLine}-${res.endLine} of ${res.totalLines})\n${res.content}` };
        }
        case 'search_code': {
            const hits = workspace.searchCode(args.pattern, { filePattern: args.filePattern, dir: args.dir || '.' });
            return { content: hits.length ? hits.join('\n') : 'No matches.' };
        }
        case 'write_file': {
            const res = workspace.writeFile(args.path, args.content);
            return {
                content: `${res.created ? 'Created' : 'Overwrote'} ${res.path} (${res.bytes} bytes).`,
                meta: { changedFiles: [res.path] },
            };
        }
        case 'edit_file': {
            const res = workspace.editFile(args.path, args.oldString, args.newString, args.replaceAll === true);
            return {
                content: `Edited ${res.path} (${res.replacements} replacement${res.replacements === 1 ? '' : 's'}).`,
                meta: { changedFiles: [res.path] },
            };
        }
        case 'run_task': {
            const res = await workspace.runTask(String(args.task || ''));
            return {
                content:
                    `$ ${res.command}\nexit code: ${res.code}\n` +
                    `--- stdout ---\n${res.stdout || '(empty)'}\n--- stderr ---\n${res.stderr || '(empty)'}`,
                meta: { task: res.task, ok: res.ok },
            };
        }
        case 'git_diff':
            return { content: await workspace.diff({ stat: args.stat === true }) };
        case 'commit_and_push': {
            const commit = await workspace.commitAll(args.message, session.branch);
            if (!commit.ok) return { content: commit.message, meta: { pushed: false } };
            const pushed = await workspace.push(session.branch);
            return {
                content: pushed.ok
                    ? `Committed ${commit.commit} (${commit.files.length} file(s)) and pushed ${session.branch}. The deployment will pick it up.`
                    : `Committed ${commit.commit}, but the push FAILED: ${pushed.message}`,
                meta: { pushed: pushed.ok, commit: commit.commit, files: commit.files },
            };
        }
        case 'notify_user':
            return { content: 'Delivered to the user.', meta: { spoken: String(args.message || '') } };
        default:
            return { content: `Unknown tool: ${name}` };
    }
}

// Keep the transcript from growing without bound across a long session: the
// first message (the bug report, with its screenshot) always stays, plus the
// most recent slice of the conversation.
function trimMessages(messages, keep = 60) {
    if (messages.length <= keep) return messages;
    const head = messages.slice(0, 1);
    let tail = messages.slice(messages.length - keep);
    // Roles must alternate, and a tool_result must not be orphaned from the
    // tool_use turn that produced it — so the tail has to start on an assistant
    // message, right after the (user) briefing that head keeps.
    while (tail.length && tail[0].role !== 'assistant') tail = tail.slice(1);
    return head.concat(tail);
}

// Run one agent turn to completion (until it calls finish, runs out of steps, or
// is cancelled). `session.messages` is mutated as the conversation grows so the
// next turn continues where this one stopped.
//
// onEvent receives { kind, ... } where kind is one of:
//   'thinking' | 'tool' | 'tool_result' | 'say' | 'done' | 'error'
async function runTurn(session, onEvent, options = {}) {
    if (!client) throw new Error('The debug coding agent needs ANTHROPIC_API_KEY (or CLAUDE_API_KEY) on the server.');
    const emit = (event) => {
        try { onEvent && onEvent(event); } catch (e) { /* a UI error must not kill the agent */ }
    };
    const cancelled = () => options.isCancelled && options.isCancelled();

    let result = { summary: '', pushed: false, needsReload: false, needsUser: false, steps: 0 };

    for (let step = 0; step < MAX_STEPS; step++) {
        if (cancelled()) {
            result.summary = result.summary || 'Stopped at your request.';
            emit({ kind: 'done', ...result, cancelled: true });
            return result;
        }
        result.steps = step + 1;

        let response;
        try {
            session.messages = trimMessages(session.messages);
            response = await client.messages.create({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: systemPrompt(session),
                tools: TOOLS,
                messages: session.messages,
            });
        } catch (e) {
            // Thrown, not emitted: the session emits one error event for the turn.
            throw new Error(`Coding agent request failed: ${(e && e.message) || String(e)}`);
        }

        session.messages.push({ role: 'assistant', content: response.content });

        const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
        const text = (response.content || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        if (text) emit({ kind: 'thinking', message: text });

        if (!toolUses.length) {
            // The model answered in prose instead of calling finish — treat that
            // text as the summary so the turn still ends cleanly.
            result.summary = text || 'Done.';
            emit({ kind: 'done', ...result });
            return result;
        }

        const toolResults = [];
        let finished = false;

        for (const use of toolUses) {
            if (use.name === 'finish') {
                const args = use.input || {};
                result = {
                    ...result,
                    summary: String(args.summary || 'Done.'),
                    pushed: args.pushed === true || result.pushed,
                    needsReload: args.needsReload === true || result.needsReload,
                    needsUser: args.needsUser === true,
                };
                toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: 'Turn ended.' });
                finished = true;
                continue;
            }

            emit({ kind: 'tool', name: use.name, input: use.input || {} });
            let out;
            try {
                out = await executeTool(use.name, use.input, session);
            } catch (e) {
                out = { content: `Error: ${(e && e.message) || String(e)}`, meta: { failed: true } };
            }
            const meta = out.meta || {};
            if (meta.spoken) emit({ kind: 'say', message: meta.spoken });
            if (meta.pushed) {
                result.pushed = true;
                session.commits = (session.commits || []).concat(meta.commit ? [meta.commit] : []);
            }
            if (Array.isArray(meta.changedFiles)) {
                session.changedFiles = Array.from(new Set((session.changedFiles || []).concat(meta.changedFiles)));
                if (meta.changedFiles.some((f) => f.startsWith('src/') || f.startsWith('public/'))) {
                    result.needsReload = true;
                }
            }
            emit({
                kind: 'tool_result',
                name: use.name,
                ok: !meta.failed,
                summary: workspace.truncate(out.content, 400),
            });
            toolResults.push({
                type: 'tool_result',
                tool_use_id: use.id,
                content: workspace.truncate(out.content, 20000),
                ...(meta.failed ? { is_error: true } : {}),
            });
        }

        session.messages.push({ role: 'user', content: toolResults });

        if (finished) {
            emit({ kind: 'done', ...result });
            return result;
        }
    }

    result.summary = result.summary
        || `I hit my ${MAX_STEPS}-step limit on this one. Tell me to keep going if you want me to continue.`;
    emit({ kind: 'done', ...result, exhausted: true });
    return result;
}

module.exports = { isConfigured, runTurn, MODEL, MAX_STEPS, TOOLS, trimMessages, executeTool };
