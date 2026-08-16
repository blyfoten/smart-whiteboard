// providers/gemini.js — Google Gemini vision extract + text solve (@google/genai).
//
// The caller passes the model id to use (the server resolves it from the
// selected tier — see providers/catalogue.js, where the ladder is Flash-Lite →
// Flash → Pro). responseMimeType forces raw JSON, so the markdown-fence
// fallback in extract() is purely defensive.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');
const { resolveModel } = require('./catalogue');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server.
let GoogleGenAI = null;
try {
    ({ GoogleGenAI } = require('@google/genai'));
} catch (e) {
    console.warn('⚠️  `@google/genai` package not installed — Gemini provider disabled. Run `npm install`.');
}

const genAI = GoogleGenAI && process.env.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
    : null;

function parseJsonLoose(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) return JSON.parse(text.substring(start, end + 1));
        throw new Error('Failed to parse Gemini response as JSON.');
    }
}

module.exports = {
    name: 'gemini',
    isConfigured: () => !!genAI,

    async extract(image, model) {
        // Parse the data URL so we send the correct mime type (canvas exports JPEG).
        const m = /^data:(.+?);base64,(.*)$/s.exec(image);
        const mimeType = m ? m[1] : 'image/jpeg';
        const data = m ? m[2] : image.split(',')[1];

        const result = await genAI.models.generateContent({
            model: model || resolveModel('gemini', null, 'vision'),
            contents: [
                { inlineData: { mimeType, data } },
                { text: EXTRACT_USER_PROMPT },
            ],
            config: {
                systemInstruction: SYSTEM_PROMPT,
                responseMimeType: 'application/json',
            },
        });
        return parseJsonLoose((result.text || '').trim());
    },

    async solve(equation, model) {
        const prompt = `You are a mathematical assistant. Solve the equation: ${equation}

Please provide a clear, concise solution. Don't use markdown formatting in your response.
Simply start with "The solution is:" followed by the answer.`;
        const result = await genAI.models.generateContent({ model: model || resolveModel('gemini', null, 'solve'), contents: prompt });
        let solution = (result.text || '').trim();
        if (solution.includes('The solution is:')) {
            solution = solution.split('The solution is:')[1].trim();
        }
        return solution;
    },
};
