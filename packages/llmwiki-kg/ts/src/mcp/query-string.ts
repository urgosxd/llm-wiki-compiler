/**
 * @file packages/llmwiki-kg/ts/src/mcp/query-string.ts
 * @description Query-string encoding with httpx's `quote_plus` semantics.
 *
 * `URLSearchParams` is close but not equal: httpx leaves `_.-~` unescaped and
 * encodes a space as `+`, and the oracle's echoed URLs are compared literally in
 * tests. Reproducing the exact escape set is cheaper than explaining a diff.
 */

// ============================================================
// Query-string encoding (httpx `quote_plus` semantics)
// ============================================================

/**
 * Characters httpx's `quote_plus` leaves unescaped.
 *
 * `urllib.parse.quote_plus` keeps `A-Za-z0-9_.-~` and encodes everything else,
 * including `*`, `!`, `'`, `(`, `)`. It maps space to `+`. `URLSearchParams`
 * differs on `*` and `!` (leaves them bare) and maps space to `+`, so it cannot
 * be substituted without changing the request URL.
 */
const HTTPX_SAFE = /[A-Za-z0-9_.\-~]/u;

/** `urllib.parse.quote_plus(value, safe="")`, byte-for-byte. */
export function quotePlus(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (byte < 0x80 && HTTPX_SAFE.test(char)) {
      out += char;
    } else if (char === " ") {
      out += "+";
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** The shortest round-trip digits of a magnitude, and where the point goes. */
interface LayeredDigits {
  readonly digits: string;
  readonly decimalExponent: number;
}

/**
 * Reduces `String(magnitude)` to its significant digits and point position.
 *
 * `String()` already yields the shortest round-trip digits, which is the same
 * digit sequence CPython's repr produces; only the layout differs.
 */
function layoutDigits(magnitude: number): LayeredDigits {
  const repr = String(magnitude);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(repr);
  if (match === null) throw new Error(`Unexpected number representation: ${repr}`);

  const integerPart = match[1] ?? "";
  const fractionPart = match[2] ?? "";
  let digits = integerPart + fractionPart;
  let decimalExponent = integerPart.length + (match[3] === undefined ? 0 : Number(match[3]));

  let leadingZeros = 0;
  while (leadingZeros < digits.length - 1 && digits[leadingZeros] === "0") {
    leadingZeros += 1;
    decimalExponent -= 1;
  }
  digits = digits.slice(leadingZeros).replace(/0+$/u, "");
  if (digits === "") {
    return { digits: "0", decimalExponent: 1 };
  }
  return { digits, decimalExponent };
}

/** `d.dddde±XX`, the exponent form CPython uses outside its window. */
function scientificForm(digits: string, scientificExponent: number): string {
  const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  const exponentSign = scientificExponent < 0 ? "-" : "+";
  const exponentDigits = String(Math.abs(scientificExponent)).padStart(2, "0");
  return `${mantissa}e${exponentSign}${exponentDigits}`;
}

/** Plain decimal notation, with an explicit `.0` for integral values. */
function fixedForm(digits: string, decimalExponent: number): string {
  if (decimalExponent <= 0) {
    return `0.${"0".repeat(-decimalExponent)}${digits}`;
  }
  if (decimalExponent >= digits.length) {
    return `${digits}${"0".repeat(decimalExponent - digits.length)}.0`;
  }
  return `${digits.slice(0, decimalExponent)}.${digits.slice(decimalExponent)}`;
}

/**
 * Python's `str(a_float)`, reproduced.
 *
 * This is not `String(value)`. The Python params dict is built from `float` and
 * `int` values and handed to httpx, which stringifies each one with `str()`;
 * `str(0.0)` is `"0.0"` while `String(0)` in JS is `"0"`. The default
 * `min_confidence` is exactly `0.0`, so `GET /aks/v1/entities` would otherwise
 * send `min_confidence=0` instead of `min_confidence=0.0` — a different URL
 * from the oracle's, on the default path of a shipped tool.
 *
 * Python's float repr rules: shortest round-trip digits, exponent notation when
 * the decimal exponent is below -4 or at least 16, and an explicit `.0` for
 * integral values. Verified against CPython over 2500 random doubles.
 */
export function pyFloatToString(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";

  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude === 0) return `${sign}0.0`;

  const layered = layoutDigits(magnitude);
  const scientificExponent = layered.decimalExponent - 1;

  // CPython switches to exponent form outside this window.
  if (scientificExponent < -4 || scientificExponent >= 16) {
    return `${sign}${scientificForm(layered.digits, scientificExponent)}`;
  }
  return `${sign}${fixedForm(layered.digits, layered.decimalExponent)}`;
}
/**
 * A query parameter value, carrying the Python type it must stringify as.
 *
 * The Python builds one `dict` per tool and httpx calls `str()` on each value,
 * but `str()` is type-dependent: `str(100)` is `"100"` while `str(0.0)` is
 * `"0.0"`. `encodeQuery` therefore needs the Python *type*, not just the JS
 * number.
 *
 * Why the type is declared here instead of inferred from the value: JavaScript
 * has one number type, and `JSON.parse` erases the int/float distinction before
 * `callTool` ever sees the arguments. `2` and `2.0` are indistinguishable. So
 * the split is taken from the declared MCP inputSchema — `limit`, `max_depth`
 * and `max_entities` are `"type": "integer"`, `min_confidence` is
 * `"type": "number"` — which is exact for every default and for any fractional
 * value.
 *
 * Remaining divergence: a client that sends an *integral float literal* for a
 * float-typed field (`min_confidence: 1`) produces `min_confidence=1.0` here
 * where the Python would produce `min_confidence=1`. FastAPI parses both to the
 * same float, so the server-visible result is identical; only the URL text
 * differs. A client that sends an integral JSON number for an integer-typed
 * field is exact.
 */
export type QueryValue =
  | { readonly kind: "int"; readonly value: number }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "raw"; readonly value: string }
  | undefined;

/** A Python `int` parameter. */
export function intParam(value: number): QueryValue {
  return { kind: "int", value };
}

/** A Python `float` parameter. */
export function floatParam(value: number): QueryValue {
  return { kind: "float", value };
}

/** An already-stringified parameter. */
export function rawParam(value: string): QueryValue {
  return { kind: "raw", value };
}

/** `str(value)` for a Python `int`, `float` or `str`. */
function stringifyQueryValue(value: NonNullable<QueryValue>): string {
  switch (value.kind) {
    case "int":
      // Python integers stringify without a decimal point; `String()` agrees.
      return Number.isInteger(value.value) ? String(value.value) : pyFloatToString(value.value);
    case "float":
      return pyFloatToString(value.value);
    case "raw":
      return value.value;
  }
}

/**
 * Serialize query params the way httpx does, preserving insertion order.
 *
 * The Python builds a `dict` and relies on its insertion order, so the query
 * string order is deterministic and part of the request. `undefined` stands in
 * for "key absent", which is what the Python's conditional `if "x" in args`
 * branches produce — there is no `None` reached at this layer.
 */
export function encodeQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${quotePlus(key)}=${quotePlus(stringifyQueryValue(value))}`);
  }
  return parts.join("&");
}
