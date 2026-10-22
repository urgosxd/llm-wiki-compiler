/**
 * @file packages/llmwiki-kg/ts/src/pydantic/uuid-text.ts
 * @description UUID text parsing, accepting exactly what Pydantic accepts.
 *
 * Zod's `z.uuid()` enforces RFC 9562 version and variant nibbles; Pydantic does
 * not. The oracle parses `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`, whose version
 * and variant nibbles are invalid under 9562, so a `z.uuid()`-based primitive
 * would reject input the reference server accepts. The text is parsed here by
 * hand with the same slack, including the simple 32-char form and the
 * `urn:uuid:` prefix.
 */

import { z } from "zod";

import { MISSING, UUID_TYPE, scalar, uuidParsing } from "./pydantic-meta.js";

const UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;
const UUID_SIMPLE_LENGTH = 32;
const UUID_HYPHENATED_LENGTH = 36;
const URN_UUID_PREFIX = "urn:uuid:";
const MAX_UUID_TEXT_LENGTH = 45;

const NON_HEX_RE = /[^0-9a-fA-F]/;

type UuidParse =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: string };

/** `8-4-4-4-12` from 32 bare hex characters, lowercased. */
function formatSimpleUuid(simple: string): string {
  return [
    simple.slice(0, 8),
    simple.slice(8, 12),
    simple.slice(12, 16),
    simple.slice(16, 20),
    simple.slice(20),
  ]
    .join("-")
    .toLowerCase();
}

/**
 * Reproduces the Rust `uuid` parser Pydantic delegates to, including the text of
 * its `Error` variants, because `uuid_parsing` embeds that text in both `msg` and
 * `ctx.error`.
 *
 * The dispatch matches all 212 probes taken against the live oracle:
 *
 * 1. longer than 45 characters -> `invalid length: found N`
 * 2. **at exactly 36 characters, skip step 3**: the strict hyphenated path is
 *    attempted on the raw text. This is why `{8-4-4-4-12}`-shaped input whose
 *    total length is 36 reports ``invalid character: found `{` at 0`` rather
 *    than a group count — the wrapper is never stripped.
 * 3. otherwise strip a `{...}` wrapper or an `urn:uuid:` prefix
 * 4. first character that is neither hex nor `-` ->
 *    ``invalid character: found `c` at N``, indexed against the *original*
 *    string so a wrapper's offset is included
 * 5. exactly five groups -> per-group length checks, then accept
 * 6. more than one group but not five -> `invalid group count`
 * 7. a bare 32 characters -> simple form
 * 8. a stripped input with one group -> `invalid group count: … found 1`
 * 9. otherwise -> `invalid length: found N`
 *
 * Accepted forms are therefore `32 hex`, `8-4-4-4-12`, `{8-4-4-4-12}` and
 * `urn:uuid:8-4-4-4-12`, matching Pydantic. Version and variant nibbles are not
 * constrained, unlike RFC-strict validators, because Pydantic does not constrain
 * them.
 */
/** Strip a `{...}` or `urn:uuid:` wrapper, returning the inner text and its offset. */
function stripUuidWrapper(input: string, originalLength: number): {
  inner: string;
  offset: number;
  stripped: boolean;
} {
  // Length 36 is attempted verbatim, before any wrapper is considered: the
  // strict hyphenated form is exactly 36 characters, so this refuses to strip a
  // wrapper off something that is already the right length.
  if (originalLength === UUID_HYPHENATED_LENGTH) {
    return { inner: input, offset: 0, stripped: false };
  }
  if (input.startsWith("{") && input.endsWith("}")) {
    return { inner: input.slice(1, -1), offset: 1, stripped: true };
  }
  if (input.startsWith(URN_UUID_PREFIX)) {
    return {
      inner: input.slice(URN_UUID_PREFIX.length),
      offset: URN_UUID_PREFIX.length,
      stripped: true,
    };
  }
  return { inner: input, offset: 0, stripped: false };
}

/** Report the first non-hex, non-hyphen character, or `null` when all are valid. */
function findInvalidCharacter(inner: string, offset: number): UuidParse | null {
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner.charAt(index);
    if (char !== "-" && NON_HEX_RE.test(char)) {
      return {
        ok: false,
        reason: `invalid character: found \`${char}\` at ${String(offset + index)}`,
      };
    }
  }
  return null;
}

/** Validate the five-group hyphenated form, returning its canonical value. */
function parseHyphenatedGroups(groups: readonly string[]): UuidParse | null {
  if (groups.length !== 5) return null;
  for (let group = 0; group < UUID_GROUP_LENGTHS.length; group += 1) {
    const expected = UUID_GROUP_LENGTHS[group] ?? 0;
    const found = groups[group]?.length ?? 0;
    if (found !== expected) {
      return {
        ok: false,
        reason: `invalid group length in group ${String(group)}: expected ${String(expected)}, found ${String(found)}`,
      };
    }
  }
  return { ok: true, value: groups.join("-").toLowerCase() };
}

/** Parse a single-group UUID: the 32-character simple form, or a failure. */
function parseSingleGroup(
  inner: string,
  originalLength: number,
  stripped: boolean,
): UuidParse {
  if (!stripped && originalLength === UUID_SIMPLE_LENGTH) {
    return { ok: true, value: formatSimpleUuid(inner) };
  }
  if (stripped || originalLength === UUID_HYPHENATED_LENGTH) {
    return { ok: false, reason: "invalid group count: expected 5, found 1" };
  }
  return { ok: false, reason: `invalid length: found ${String(originalLength)}` };
}

/**
 * Parse Pydantic's accepted UUID text forms.
 *
 * Tried in the order the oracle tries them: reject over-long input, strip a
 * wrapper, reject non-hex characters, then accept the five-group hyphenated form
 * or the 32-character simple form.
 */
function parseUuidText(input: string): UuidParse {
  const originalLength = input.length;
  if (originalLength > MAX_UUID_TEXT_LENGTH) {
    return { ok: false, reason: `invalid length: found ${String(originalLength)}` };
  }

  const { inner, offset, stripped } = stripUuidWrapper(input, originalLength);
  const invalid = findInvalidCharacter(inner, offset);
  if (invalid !== null) return invalid;

  const groups = inner.split("-");
  const hyphenated = parseHyphenatedGroups(groups);
  if (hyphenated !== null) return hyphenated;

  if (groups.length > 1) {
    return {
      ok: false,
      reason: `invalid group count: expected 5, found ${String(groups.length)}`,
    };
  }
  return parseSingleGroup(inner, originalLength, stripped);
}

/**
 * `uuid.UUID`.
 *
 * Resolves to the **canonical lowercase hyphenated** form, which is what
 * Pydantic serializes: the oracle answers
 * `/stacks/366173423b684ea781b95bc562bb81d3` with
 * `Stack 36617342-3b68-4ea7-81b9-5bc562bb81d3 not found`.
 */
export function pydanticUuid(): z.ZodType<string> {
  return scalar((value, failHere) => {
    if (value === undefined) {
      return failHere(MISSING);
    }
    if (typeof value !== "string") {
      return failHere(UUID_TYPE);
    }
    const parsed = parseUuidText(value);
    if (!parsed.ok) {
      return failHere(uuidParsing(parsed.reason));
    }
    return parsed.value;
  });
}
