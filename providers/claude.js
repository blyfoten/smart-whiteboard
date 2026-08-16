// providers/claude.js — Anthropic Claude vision extract + text solve.
//
// The caller passes the model id to use (the server resolves it from the
// selected tier — see providers/catalogue.js, where the ladder is Haiku →
// Sonnet → Opus). Uses ANTHROPIC_API_KEY.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');
const { resolveModel } = require('./catalogue');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server.
let Anthropic = null;
try {
    Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
    console.warn('⚠️  `@anthropic-ai/sdk` package not installed — Claude provider disabled. Run `npm install`.');
}

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

    async extract(image, model) {
        // Parse the data URL into media_type + base64 payload.
        const m = /^data:(.+?);base64,(.*)$/s.exec(image);
        const mediaType = m ? m[1] : 'image/jpeg';
        const data = m ? m[2] : image.split(',')[1];

        const resp = await client.messages.create({
            model: model || resolveModel('claude', null, 'vision'),
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

    async solve(equation, model) {
        const resp = await client.messages.create({
            model: model || resolveModel('claude', null, 'solve'),
            max_tokens: 1024,
            system: 'You are a mathematical assistant.',
            messages: [{ role: 'user', content: `Solve the equation: ${equation}` }],
        });
        return textOf(resp);
    },
};
