// providers/index.js — registry mapping a provider/model name to its module.
// Each provider implements: name, isConfigured(), extract(image), solve(equation).

const openai = require('./openai');
const gemini = require('./gemini');
const claude = require('./claude');
const { validateExtraction } = require('./schema');

// Accepts UI model names ('gpt', 'gemini', 'claude') and canonical provider names.
function get(name) {
    switch (name) {
        case 'openai':
        case 'gpt':
            return openai;
        case 'gemini':
            return gemini;
        case 'claude':
            return claude;
        default:
            return null;
    }
}

module.exports = { get, validateExtraction };
