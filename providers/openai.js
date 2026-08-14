// providers/openai.js — OpenAI vision extract + text solve via the official SDK.
//
// The caller passes the model id to use (the server resolves it from the
// selected tier — see providers/catalogue.js, where the GPT-5.6 ladder is
// luna → terra → sol). Falls back to the catalogue's default tier when called
// without one, so direct use still works.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');
const { resolveModel } = require('./catalogue');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server (the git watcher pulls but doesn't
// `npm install`).
let OpenAI = null;
try {
    OpenAI = require('openai');
} catch (e) {
    console.warn('⚠️  `openai` package not installed — OpenAI provider disabled. Run `npm install`.');
}

const client = OpenAI && process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

module.exports = {
    name: 'openai',
    isConfigured: () => !!client,

    // Returns the parsed JSON object (may contain { error }); throws on API/parse failure.
    async extract(image, model) {
        const resp = await client.chat.completions.create({
            model: model || resolveModel('gpt', null, 'vision'),
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

    async solve(equation, model) {
        const resp = await client.chat.completions.create({
            model: model || resolveModel('gpt', null, 'solve'),
            messages: [
                { role: 'system', content: 'You are a mathematical assistant.' },
                { role: 'user', content: `Solve the equation: ${equation}` },
            ],
        });
        return (resp.choices?.[0]?.message?.content || '').trim();
    },
};
