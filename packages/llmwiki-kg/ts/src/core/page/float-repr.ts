/**
 * @file packages/llmwiki-kg/ts/src/core/page/float-repr.ts
 * @description CPython's `repr()` for a float, and the error its callers raise.
 *
 * Split out of `core/page_generator.ts` as its own unit because the graph-version
 * hash is built from Python *representations*: if this port formatted a float
 * differently, two servers sharing one `entity_pages` table would invalidate each
 * other's cache on every read.
 */

/** Raised when a jsonb text form cannot be re-emitted faithfully. */
export class PythonFormatError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PythonFormatError";
  }
}

/**
 * Python's `repr()` for a float, i.e. `str(float(value))`.
 *
 * CPython's short-repr algorithm emits the shortest digit string that
 * round-trips, then chooses fixed or exponential notation by the decimal point
 * position `decpt` (the value is `0.<digits> x 10**decpt`): exponential when
 * `decpt <= -4` or `decpt > 16`, fixed otherwise, and a trailing `.0` when the
 * fixed form has no fractional digits.
 *
 * Every threshold below is measured, not guessed:
 *
 * | value | Python |
 * |---|---|
 * | `0.0001` | `0.0001` (fixed, decpt = -3) |
 * | `1e-05` | `1e-05` (exponential, decpt = -4) |
 * | `1234567890123456.0` | `1234567890123456.0` (fixed, decpt = 16) |
 * | `1e+16` | `1e+16` (exponential, decpt = 17) |
 * | `2.0` | `2.0` |
 * | `-0.0` | `-0.0` |
 *
 * `Number.prototype.toExponential()` with no argument produces the same shortest
 * digit string, which is what makes this a formatting problem rather than an
 * arithmetic one.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "inf";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-inf";
  }
  if (value === 0) {
    return Object.is(value, -0) ? "-0.0" : "0.0";
  }

  const sign = value < 0 ? "-" : "";
  const exponential = Math.abs(value).toExponential();
  const separator = exponential.indexOf("e");
  const mantissaText = exponential.slice(0, separator);
  const exponent = Number.parseInt(exponential.slice(separator + 1), 10);
  const digits = mantissaText.replace(".", "");

  // `value == 0.<digits> * 10**decimalPoint`.
  const decimalPoint = exponent + 1;

  if (decimalPoint <= -4 || decimalPoint > 16) {
    const head = digits.slice(0, 1);
    const tail = digits.slice(1);
    const mantissa = tail === "" ? head : `${head}.${tail}`;
    const power = decimalPoint - 1;
    const powerText = `${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
    return `${sign}${mantissa}e${powerText}`;
  }

  if (decimalPoint <= 0) {
    return `${sign}0.${"0".repeat(-decimalPoint)}${digits}`;
  }

  if (digits.length <= decimalPoint) {
    return `${sign}${digits}${"0".repeat(decimalPoint - digits.length)}.0`;
  }

  return `${sign}${digits.slice(0, decimalPoint)}.${digits.slice(decimalPoint)}`;
}
