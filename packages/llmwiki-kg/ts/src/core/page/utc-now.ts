/**
 * @file packages/llmwiki-kg/ts/src/core/page/utc-now.ts
 * @description The current instant as Pydantic serializes a `timestamptz`.
 *
 * Split out of `core/page_generator.ts` as its own unit because the page cache
 * stamps `generated_at` with it, and it is pure formatting with no dependency on
 * the graph or the cache.
 */

/**
 * The current instant as Pydantic serializes a `timestamptz`.
 *
 * Observed oracle output: `2026-10-22T05:12:39.060090Z` — six fractional digits
 * and a `Z`. A JavaScript `Date` holds milliseconds, so the last three digits are
 * genuinely zero; `db.ts` follows the same rule for stored timestamps.
 */
export function pydanticUtcNow(): string {
  const iso = new Date().toISOString();
  return `${iso.slice(0, -1)}000Z`;
}
