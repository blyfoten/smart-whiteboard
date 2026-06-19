// providers/claude.js — Anthropic Claude vision extract + text solve.
//
// Defaults to claude-haiku-4-5 (fast/cheap, vision-capable) for this OCR-style
// workload; set CLAUDE_VISION_MODEL / CLAUDE_SOLVE_MODEL to e.g. claude-opus-4-8
// for the hardest handwriting. Uses ANTHROPIC_API_KEY.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server.
let Anthropic = null;
try {
    Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
    console.warn('⚠️  `@anthropic-ai/sdk` package not installed — Claude provider disabled. Run `npm install`.');
}

const VISION_MODEL = process.env.CLAUDE_VISION_MODEL || 'claude-haiku-4-5';
const SOLVE_MODEL = process.env.CLAUDE_SOLVE_MODEL || 'claude-haiku-4-5';

// Accept either ANTHROPIC_API_KEY (SDK standard) or CLAUDE_API_KEY (alias).
const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const client = Anthropic && apiKey ? new Anthropic({ apiKey }) : null;

function textOf(resp) {
    const block = (resp.content || []).find((b) => b.type === 'text');
    return (block && block.text ? block.text : '').trim();
}

function parseJsonLoose(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) return JSON.parse(text.substring(start, end + 1));
        throw new Error('Failed to parse Claude response as JSON.');
    }
}

module.exports = {
    name: 'claude',
    isConfigured: () => !!client,

    async extract(image) {
        // Parse the data URL into media_type + base64 payload.
        const m = /^data:(.+?);base64,(.*)$/s.exec(image);
        const mediaType = m ? m[1] : 'image/jpeg';
        const data = m ? m[2] : image.split(',')[1];

        const resp = await client.messages.create({
            model: VISION_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
                        { type: 'text', text: EXTRACT_USER_PROMPT },
                    ],
                },
            ],
        });
        return parseJsonLoose(textOf(resp));
    },

    async solve(equation) {
        const resp = await client.messages.create({
            model: SOLVE_MODEL,
            max_tokens: 1024,
            system: 'You are a mathematical assistant.',
            messages: [{ role: 'user', content: `Solve the equation: ${equation}` }],
        });
        return textOf(resp);
    },
};
