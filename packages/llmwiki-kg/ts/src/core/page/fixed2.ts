/**
 * @file packages/llmwiki-kg/ts/src/core/page/fixed2.ts
 * @description Python's `f"{value:.2f}"`, rounded on the exact binary value.
 *
 * Split out of `core/page_generator.ts` as its own unit because neither
 * `toFixed` nor `Intl` reproduces CPython's half-to-even rounding, so this needs
 * IEEE-754 mantissa arithmetic that has nothing to do with the rest of the
 * generator.
 */

import { pythonFloatRepr } from "./float-repr.js";

/**
 * Python's `f"{value:.2f}"`, rounded on the **exact** binary value.
 *
 * Both JavaScript alternatives are wrong, in different places, measured against
 * CPython:
 *
 * | value | Python | `toFixed(2)` | `Intl` halfEven |
 * |---|---|---|---|
 * | `0.005` | `0.01` | `0.01` | `0.00` |
 * | `0.015` | `0.01` | `0.01` | `0.02` |
 * | `0.125` | `0.12` | `0.13` | `0.12` |
 * | `2.675` | `2.67` | `2.67` | `2.68` |
 * | `1.005` | `1.00` | `1.00` | `1.00` |
 *
 * Python rounds the double's exact binary expansion, half-to-even: `0.005` is
 * really `0.005000000000000000104…` so it rounds up, while `0.125` is an exact
 * tie and rounds to the even digit. `Intl` rounds the shortest *decimal* repr
 * instead, which turns both of those the wrong way, and `toFixed` breaks ties
 * away from zero. Neither is a fixable rounding mode; the only faithful
 * implementation is integer arithmetic on the IEEE-754 mantissa, which is what
 * this does.
 *
 * Used for the confidence values interpolated into the generation prompt.
 */
export function formatFixed2(value: number): string {
  if (!Number.isFinite(value)) {
    // Python prints `inf` / `-inf` / `nan` for these, not `Infinity`.
    return pythonFloatRepr(value);
  }

  const negative = value < 0 || Object.is(value, -0);

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);

  // Subnormals carry no implicit leading 1 and a fixed exponent of -1074.
  const mantissa = exponentBits === 0 ? fractionBits : fractionBits | (1n << 52n);
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;

  // `scaled` is the exact value of `|value| * 100`, as a rational
  // `mantissa * 100 * 2**exponent`.
  const numerator = mantissa * 100n;
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = numerator << BigInt(exponent);
  } else {
    const shift = BigInt(-exponent);
    const quotient = numerator >> shift;
    const remainder = numerator & ((1n << shift) - 1n);
    const half = 1n << (shift - 1n);
    if (remainder > half) {
      rounded = quotient + 1n;
    } else if (remainder < half) {
      rounded = quotient;
    } else {
      rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const digits = rounded.toString().padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
