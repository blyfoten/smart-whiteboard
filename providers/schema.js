// providers/schema.js — the shared extraction contract (prompt + validation).
// Both vision providers (OpenAI, Gemini) use these so the JSON shape stays in
// one place instead of being duplicated per endpoint.

const SYSTEM_PROMPT = `You read handwritten mathematics from an image and return it as structured JSON for math.js.

Return JSON with exactly this schema:
{
  "dependentVariable": "string", // the plotted output, e.g. "y"
  "expression": "string",        // math.js source for it, e.g. "x^2 + 3*x"
  "scope": { "variableName": number },           // one sample value per variable, e.g. {"x": 0}
  "ranges": { "variableName": [number, number] } // plot window per variable, e.g. {"x": [-10, 10]}
}

TRANSCRIBE, DON'T CORRECT. Write down what is actually on the board, even if it
looks wrong or unfinished. Never simplify, solve, or "fix" the maths here.

PUTTING IT IN THE SCHEMA:
- Written as "y = f(x)": dependentVariable is that left-hand variable, expression is the right side.
- No dependent variable ("x^2 - 4 = 0", or a bare expression): use "y" as dependentVariable and
  put the other side in expression, so plotting it shows the roots.
- Variables on both sides ("2x + 3 = x - 1"): move everything to one side —
  expression becomes "(2*x + 3) - (x - 1)" — and use "y". Its zeros are the solutions.
- Several variables: still pick one dependentVariable; give every remaining variable an entry
  in both scope and ranges.

MATH.JS SYNTAX: explicit * for multiplication ("3x" is "3*x", "2(x+1)" is "2*(x+1)"),
^ for powers, sqrt(), abs(), sin/cos/tan (radians), log() natural and log10(), pi and e.
A horizontal bar with terms above and below is a fraction: (numerator)/(denominator).
A raised number after a term is an exponent, not a digit ("x2" written small and high is "x^2").

READING HANDWRITING: distinguish x from a multiplication cross, 1 from l, 0 from O,
2 from z, and a minus sign from a fraction bar. Ignore doodles, arrows, axis labels
and other marks that are not part of the equation.

CHOOSING scope AND ranges: scope is any value where the expression is defined (0 usually,
but 1 for something like 1/x). Pick ranges that actually show the interesting behaviour —
real roots, a vertex, or one full period — rather than always [-10, 10]; that is only the
fallback when nothing suggests a better window.

Return ONLY valid JSON — no markdown fences, no commentary.
If the handwriting cannot be read as mathematics, return exactly:
{"error": "Unable to interpret the handwritten equation. Please ensure the handwriting is clear."}`;

const EXTRACT_USER_PROMPT = 'Extract the equation from this image as JSON.';

// Returns an error message string if invalid, or null when the payload is good.
function validateExtraction(data) {
  if (!data || typeof data !== 'object') return 'Empty or invalid response.';
  if (data.error) return data.error;
  if (!data.expression || !data.dependentVariable || !data.scope || !data.ranges) {
    return 'Invalid response format: missing required fields.';
  }
  return null;
}

module.exports = { SYSTEM_PROMPT, EXTRACT_USER_PROMPT, validateExtraction };
