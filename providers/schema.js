// providers/schema.js — the shared extraction contract (prompt + validation).
// Both vision providers (OpenAI, Gemini) use these so the JSON shape stays in
// one place instead of being duplicated per endpoint.

const SYSTEM_PROMPT = `You are an AI specialized in interpreting handwritten mathematical equations from images and converting them into structured JSON suitable for math.js.

Analyze the image, extract the mathematical equation, and return JSON with this schema exactly:
{
  "dependentVariable": "string", // Variable on the left side (e.g., "y")
  "expression": "string",        // Right side in math.js format (e.g., "x^2 + 3*x")
  "scope": { "variableName": number },           // sample value per variable, e.g. {"x": 0}
  "ranges": { "variableName": [number, number] } // min/max per variable, e.g. {"x": [-10, 10]}
}

Return ONLY valid JSON — no markdown fences or extra text.
If you cannot interpret the equation, return exactly:
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
