/**
 * @file packages/llmwiki-kg/ts/src/mcp/py-format.ts
 * @description Python numeric formatting, reproduced for wire parity.
 *
 * The reference server is a Python oracle, and its JSON carries floats the way
 * Python writes them — `1.0`, not `1`. A client comparing responses byte for
 * byte needs the same text, so these helpers reproduce Python's formatting
 * rather than using `String(number)`.
 */

// ============================================================
// Python numeric formatting
// ============================================================

/**
 * Python's `format(value, ".2f")`, reproduced bit-exactly.
 *
 * This cannot be `toFixed(2)` or `Intl.NumberFormat`. Python rounds the exact
 * binary value with round-half-to-even, while `toFixed` rounds half away from
 * zero and `Intl` with `roundingMode: "halfEven"` still rounds the *shortest
 * decimal representation* rather than the stored double. The three disagree on
 * real inputs:
 *
 * | value | Python `.2f` | `toFixed(2)` | `Intl` halfEven |
 * |-------|--------------|--------------|-----------------|
 * | 0.125 | `0.12`       | `0.13`       | `0.12`          |
 * | 2.675 | `2.67`       | `2.67`       | `2.68`          |
 * | 0.995 | `0.99`       | `0.99`       | `1.00`          |
 *
 * A confidence of exactly `0.125` is reachable — extraction emits round
 * confidences, and `0.125` is a normal one — so this is a live contract risk,
 * not a pedantic one. The implementation decodes the IEEE-754 bits and does the
 * rounding in exact integer arithmetic. Verified against CPython over 3000
 * random doubles (see `mcp.test.ts`).
 */
export function formatFixed2(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Number.POSITIVE_INFINITY) return "inf";
  if (value === Number.NEGATIVE_INFINITY) return "-inf";

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);

  const negative = hi >>> 31 === 1;
  const sign = negative ? "-" : "";

  const exponentBits = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exponent: bigint;

  if (exponentBits === 0) {
    // Subnormal: no implicit leading bit.
    exponent = -1074n;
  } else {
    mantissa |= 1n << 52n;
    exponent = BigInt(exponentBits) - 1075n;
  }

  // `format(-0.0, ".2f")` is "-0.00" in Python, so the sign is kept.
  if (mantissa === 0n) return `${sign}0.00`;

  // Compute round-half-even(|value| * 100) in exact integer arithmetic.
  const numerator = mantissa * 100n;
  let units: bigint;
  if (exponent >= 0n) {
    units = numerator << exponent;
  } else {
    const divisor = 1n << -exponent;
    const quotient = numerator / divisor;
    const remainder = numerator % divisor;
    const twiceRemainder = remainder * 2n;
    if (twiceRemainder > divisor) {
      units = quotient + 1n;
    } else if (twiceRemainder < divisor) {
      units = quotient;
    } else {
      units = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const whole = units / 100n;
  const fraction = units % 100n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}
