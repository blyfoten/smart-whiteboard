// src/cad/expr.js — tiny arithmetic expression evaluator for CAD parameters.
//
// Dimensions and named parameters accept expressions like "w / 2 + 5" or
// "2 * sqrt(r)". Deliberately small (recursive descent, no dependencies) so it
// can live in the bundle without dragging mathjs in, and pure so it's
// unit-testable in Node. Throws on any syntax error or unknown name.

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
};

const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|([+\-*/^(),]))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) {
      // Trailing whitespace only?
      if (/^\s*$/.test(src.slice(pos))) break;
      throw new Error(`Unexpected character '${src[pos]}' in expression`);
    }
    if (m[1] !== undefined) tokens.push({ t: 'num', v: parseFloat(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'name', v: m[2] });
    else tokens.push({ t: m[3] });
    pos = re.lastIndex;
  }
  return tokens;
}

// evaluateExpression('w / 2', { w: 100 }) -> 50. Throws with a readable message
// on bad syntax, unknown names, or a non-finite result.
export function evaluateExpression(src, scope = {}) {
  if (typeof src === 'number') return src;
  const tokens = tokenize(String(src));
  if (!tokens.length) throw new Error('Empty expression');
  let i = 0;
  const peek = () => tokens[i];
  const eat = (t) => {
    if (!tokens[i] || tokens[i].t !== t) throw new Error(`Expected '${t}' in expression`);
    return tokens[i++];
  };

  function primary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression');
    if (tok.t === 'num') { i++; return tok.v; }
    if (tok.t === '(') {
      i++;
      const v = expr();
      eat(')');
      return v;
    }
    if (tok.t === 'name') {
      i++;
      if (peek() && peek().t === '(') {
        const fn = FUNCS[tok.v];
        if (!fn) throw new Error(`Unknown function '${tok.v}'`);
        i++; // '('
        const args = [expr()];
        while (peek() && peek().t === ',') { i++; args.push(expr()); }
        eat(')');
        return fn(...args);
      }
      if (Object.prototype.hasOwnProperty.call(scope, tok.v)) return Number(scope[tok.v]);
      if (Object.prototype.hasOwnProperty.call(CONSTS, tok.v)) return CONSTS[tok.v];
      throw new Error(`Unknown parameter '${tok.v}'`);
    }
    throw new Error(`Unexpected '${tok.t}' in expression`);
  }

  function unary() {
    if (peek() && peek().t === '-') { i++; return -unary(); }
    if (peek() && peek().t === '+') { i++; return unary(); }
    return power();
  }

  // '^' binds tighter than unary minus on its left: -2^2 = -4, and is
  // right-associative: 2^3^2 = 512.
  function power() {
    const base = primary();
    if (peek() && peek().t === '^') {
      i++;
      return base ** unary();
    }
    return base;
  }

  function term() {
    let v = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = tokens[i++].t;
      const rhs = unary();
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }

  function expr() {
    let v = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[i++].t;
      const rhs = term();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }

  const result = expr();
  if (i < tokens.length) throw new Error('Unexpected trailing input in expression');
  if (!Number.isFinite(result)) throw new Error('Expression is not a finite number');
  return result;
}
