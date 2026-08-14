// Plain-Node checks for the model-tier catalogue (providers/catalogue.js).
// Run: node test/catalogue.test.mjs
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalogue = require('../providers/catalogue.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

check('every provider offers the full tier ladder', () => {
  const pub = catalogue.publicCatalogue();
  for (const key of ['gpt', 'gemini', 'claude']) {
    const entry = pub.providers[key];
    assert.ok(entry, `missing provider ${key}`);
    assert.deepEqual(entry.tiers.map((t) => t.tier), catalogue.TIERS);
    entry.tiers.forEach((t) => {
      assert.ok(t.name, `${key}/${t.tier} has no display name`);
      assert.ok(t.model, `${key}/${t.tier} has no model id`);
    });
  }
});

check('the default tier is the cheapest step', () => {
  assert.equal(catalogue.DEFAULT_TIER, 'fast');
  assert.equal(catalogue.TIERS[0], 'fast');
});

check('each provider resolves three distinct models', () => {
  for (const key of ['gpt', 'gemini', 'claude']) {
    const ids = catalogue.TIERS.map((t) => catalogue.resolveModel(key, t));
    assert.equal(new Set(ids).size, 3, `${key} tiers collide: ${ids.join(', ')}`);
  }
});

check('an unknown or missing tier falls back to the default', () => {
  const fallback = catalogue.resolveModel('gpt', 'fast');
  assert.equal(catalogue.resolveModel('gpt', 'bogus'), fallback);
  assert.equal(catalogue.resolveModel('gpt', undefined), fallback);
  assert.equal(catalogue.resolveModel('gpt', null), fallback);
  // A client sending a model id instead of a tier key gets the default, never
  // the id it asked for — the browser must not be able to name a model.
  assert.equal(catalogue.resolveModel('gpt', 'gpt-5.6-sol'), fallback);
});

check('unknown providers resolve to null', () => {
  assert.equal(catalogue.resolveModel('nope', 'fast'), null);
  assert.equal(catalogue.resolveModel(undefined, 'fast'), null);
});

check("the 'openai' alias maps onto the gpt entry", () => {
  assert.equal(catalogue.resolveModel('openai', 'max'), catalogue.resolveModel('gpt', 'max'));
  assert.equal(catalogue.canonical('openai'), 'gpt');
});

check('isValidTier accepts only ladder keys', () => {
  assert.ok(catalogue.isValidTier('fast'));
  assert.ok(catalogue.isValidTier('max'));
  assert.ok(!catalogue.isValidTier('cheapest'));
  assert.ok(!catalogue.isValidTier(''));
});

check('legacy single-model env pins still win when set', () => {
  // Re-require with the legacy pin set, in a clean module registry.
  const req = createRequire(import.meta.url);
  delete req.cache[req.resolve('../providers/catalogue.js')];
  process.env.OPENAI_SOLVE_MODEL = 'gpt-legacy-pin';
  const pinned = req('../providers/catalogue.js');
  assert.equal(pinned.resolveModel('gpt', 'max', 'solve'), 'gpt-legacy-pin');
  // ...but only for the operation it pins.
  assert.equal(pinned.resolveModel('gpt', 'max', 'vision'), 'gpt-5.6-sol');
  delete process.env.OPENAI_SOLVE_MODEL;
  delete req.cache[req.resolve('../providers/catalogue.js')];
});

check('per-tier env overrides replace a single step', () => {
  const req = createRequire(import.meta.url);
  delete req.cache[req.resolve('../providers/catalogue.js')];
  process.env.GEMINI_MODEL_MAX = 'gemini-custom-pro';
  const custom = req('../providers/catalogue.js');
  assert.equal(custom.resolveModel('gemini', 'max'), 'gemini-custom-pro');
  assert.equal(custom.resolveModel('gemini', 'fast'), 'gemini-3.5-flash-lite');
  delete process.env.GEMINI_MODEL_MAX;
  delete req.cache[req.resolve('../providers/catalogue.js')];
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
