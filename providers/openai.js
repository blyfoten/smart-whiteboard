// providers/openai.js — OpenAI vision extract + text solve via the official SDK.
//
// Model IDs are env-overridable. If a default ever 404s (model renamed/retired),
// set OPENAI_VISION_MODEL / OPENAI_SOLVE_MODEL rather than editing code.
//
// Defaults to gpt-5.6-terra, the balanced tier of the current GPT-5.6 family —
// ample for reading an equation off the board and solving it, at a third of the
// flagship's token price. The family is gpt-5.6-sol (deepest reasoning; the bare
// `gpt-5.6` alias routes here), -terra (balanced), -luna (fastest/cheapest);
// swap tiers via the env vars.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server (the git watcher pulls but doesn't
// `npm install`).
let OpenAI = null;
try {
    OpenAI = require('openai');
} catch (e) {
    console.warn('⚠️  `openai` package not installed — OpenAI provider disabled. Run `npm install`.');
}

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-5.6-terra';
const SOLVE_MODEL = process.env.OPENAI_SOLVE_MODEL || 'gpt-5.6-terra';

const client = OpenAI && process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

module.exports = {
    name: 'openai',
    isConfigured: () => !!client,

    // Returns the parsed JSON object (may contain { error }); throws on API/parse failure.
    async extract(image) {
        const resp = await client.chat.completions.create({
            model: VISION_MODEL,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: EXTRACT_USER_PROMPT },
                        { type: 'image_url', image_url: { url: image } },
                    ],
                },
            ],
        });
        const content = (resp.choices?.[0]?.message?.content || '').trim();
        return JSON.parse(content);
    },

    async solve(equation) {
        const resp = await client.chat.completions.create({
            model: SOLVE_MODEL,
            messages: [
                { role: 'system', content: 'You are a mathematical assistant.' },
                { role: 'user', content: `Solve the equation: ${equation}` },
            ],
        });
        return (resp.choices?.[0]?.message?.content || '').trim();
    },
};
