// providers/index.js — registry mapping a provider/model name to its module.
// Each provider implements: name, isConfigured(), extract(image), solve(equation).

const openai = require('./openai');
const gemini = require('./gemini');
const { validateExtraction } = require('./schema');

// Accepts UI model names ('gpt', 'gemini') and canonical provider names.
function get(name) {
    switch (name) {
        case 'openai':
        case 'gpt':
            return openai;
        case 'gemini':
            return gemini;
        default:
            return null;
    }
}

module.exports = { get, validateExtraction };
