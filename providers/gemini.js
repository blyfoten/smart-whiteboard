// providers/gemini.js — Google Gemini vision extract + text solve (@google/genai).
//
// GEMINI_MODEL is env-overridable (default gemini-3.7-flash — GA, and cheaper
// per token than the 3.6/2.5 Flash it replaces; gemini-2.0-flash was shut down
// 2026-06-01). responseMimeType forces raw JSON, so the markdown-fence fallback
// in extract() is purely defensive.

const { SYSTEM_PROMPT, EXTRACT_USER_PROMPT } = require('./schema');

// Guard the SDK require so a not-yet-installed package disables this provider
// rather than crashing the whole server.
let GoogleGenAI = null;
try {
    ({ GoogleGenAI } = require('@google/genai'));
} catch (e) {
    console.warn('⚠️  `@google/genai` package not installed — Gemini provider disabled. Run `npm install`.');
}

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

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

    async extract(image) {
        // Parse the data URL so we send the correct mime type (canvas exports JPEG).
        const m = /^data:(.+?);base64,(.*)$/s.exec(image);
        const mimeType = m ? m[1] : 'image/jpeg';
        const data = m ? m[2] : image.split(',')[1];

        const result = await genAI.models.generateContent({
            model: GEMINI_MODEL,
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

    async solve(equation) {
        const prompt = `You are a mathematical assistant. Solve the equation: ${equation}

Please provide a clear, concise solution. Don't use markdown formatting in your response.
Simply start with "The solution is:" followed by the answer.`;
        const result = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
        let solution = (result.text || '').trim();
        if (solution.includes('The solution is:')) {
            solution = solution.split('The solution is:')[1].trim();
        }
        return solution;
    },
};
