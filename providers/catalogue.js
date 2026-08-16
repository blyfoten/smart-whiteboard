// providers/catalogue.js — the model tiers each provider offers.
//
// Every provider ships the same three-step ladder, so the UI can present one
// "Model tier" control regardless of which provider is selected:
//
//   fast     — cheapest / lowest latency   (Luna · Flash-Lite · Haiku)
//   balanced — the everyday workhorse      (Terra · Flash     · Sonnet)
//   max      — deepest reasoning           (Sol   · Pro       · Opus)
//
// The catalogue lives on the server and the client only ever sends a TIER KEY.
// Model ids are never accepted from the browser: an attacker (or a stray bug)
// could otherwise point the app at an arbitrary — or arbitrarily expensive —
// model on the account's key.
//
// Every id is individually env-overridable (e.g. GEMINI_MODEL_MAX=…), which is
// also the escape hatch when a vendor renames or retires one: no code change,
// just an env var. The older single-model pins (OPENAI_VISION_MODEL etc.) still
// win when set, so existing deployments keep their exact behaviour.

const TIERS = ['fast', 'balanced', 'max'];
const DEFAULT_TIER = 'fast'; // cheapest by default — raise it per task in the UI

const CATALOGUE = {
    gpt: {
        label: 'OpenAI',
        tiers: {
            fast: { name: 'Luna', model: process.env.OPENAI_MODEL_FAST || 'gpt-5.6-luna' },
            balanced: { name: 'Terra', model: process.env.OPENAI_MODEL_BALANCED || 'gpt-5.6-terra' },
            max: { name: 'Sol', model: process.env.OPENAI_MODEL_MAX || 'gpt-5.6-sol' },
        },
        legacy: { vision: 'OPENAI_VISION_MODEL', solve: 'OPENAI_SOLVE_MODEL' },
    },
    gemini: {
        label: 'Gemini',
        tiers: {
            fast: { name: 'Flash-Lite', model: process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite' },
            balanced: { name: 'Flash', model: process.env.GEMINI_MODEL_BALANCED || 'gemini-3.7-flash' },
            max: { name: 'Pro', model: process.env.GEMINI_MODEL_MAX || 'gemini-3.1-pro' },
        },
        legacy: { vision: 'GEMINI_MODEL', solve: 'GEMINI_MODEL' },
    },
    claude: {
        label: 'Claude',
        tiers: {
            fast: { name: 'Haiku', model: process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001' },
            balanced: { name: 'Sonnet', model: process.env.CLAUDE_MODEL_BALANCED || 'claude-sonnet-5' },
            max: { name: 'Opus', model: process.env.CLAUDE_MODEL_MAX || 'claude-opus-5' },
        },
        legacy: { vision: 'CLAUDE_VISION_MODEL', solve: 'CLAUDE_SOLVE_MODEL' },
    },
};

// Provider aliases used by the UI / older endpoints.
function canonical(provider) {
    if (provider === 'openai') return 'gpt';
    return provider;
}

function isValidTier(tier) {
    return TIERS.includes(tier);
}

// The model id to call for (provider, tier, kind). `kind` is 'vision' | 'solve'
// and only matters for the legacy single-model env pins. Unknown provider →
// null; unknown tier → the default tier.
function resolveModel(provider, tier, kind = 'solve') {
    const entry = CATALOGUE[canonical(provider)];
    if (!entry) return null;
    const pin = entry.legacy && entry.legacy[kind] && process.env[entry.legacy[kind]];
    if (pin) return pin;
    const step = entry.tiers[isValidTier(tier) ? tier : DEFAULT_TIER];
    return step ? step.model : null;
}

// What the browser needs to render the tier picker: per provider, the tier keys
// in ladder order with their vendor-facing names and resolved model ids.
function publicCatalogue() {
    const providers = {};
    for (const [key, entry] of Object.entries(CATALOGUE)) {
        providers[key] = {
            label: entry.label,
            tiers: TIERS.map((tier) => ({
                tier,
                name: entry.tiers[tier].name,
                model: resolveModel(key, tier),
            })),
        };
    }
    return { tiers: TIERS, defaultTier: DEFAULT_TIER, providers };
}

module.exports = { TIERS, DEFAULT_TIER, canonical, isValidTier, resolveModel, publicCatalogue };
