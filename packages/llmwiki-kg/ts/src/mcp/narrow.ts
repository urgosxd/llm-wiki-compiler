/**
 * @file packages/llmwiki-kg/ts/src/mcp/narrow.ts
 * @description Narrowing helpers for untyped JSON responses.
 *
 * Every response arrives as `unknown`. These predicates and accessors keep the
 * formatters readable without spreading `as` casts through them; a wrong shape
 * surfaces as a described error rather than `undefined` leaking into text.
 */

// ============================================================
// JSON narrowing
// ============================================================

/**
 * The formatters receive parsed JSON, whose real shape is only known at
 * runtime. These helpers narrow `unknown` to the fields each formatter reads,
 * so no formatter indexes an unchecked cast.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `data[key]` where the Python would raise `KeyError` on absence. */
export function requireField(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) {
    throw new Error(`Response is missing required field '${key}'`);
  }
  return record[key];
}

/** `str(value)` for the scalar types the endpoints emit. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "None";
  return JSON.stringify(value);
}

/** `value` used directly as a formatted confidence. */
export function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Response field '${field}' is not a number`);
  }
  return value;
}
