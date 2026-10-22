/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-formatting.test.ts
 * @description Python float/JSON formatting and the `graph_version` hash.
 */

import { describe, expect, it , vi } from "vitest";
import { compareCodePoints, computeGraphVersion, formatFixed2, pythonFloatRepr, pythonJsonDumps } from "../core/page_generator.js";
import { entityRow, relationshipRow, useDomainPrefix } from "./pages-harness.js";

// The provider env and the `complete` stub must be in place before the modules
// under test are imported; `vi.hoisted`/`vi.mock` are hoisted above imports.
vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

const completeMock = vi.hoisted(() => ({
  /** When false, the real `complete` is called. */
  enabled: true,
  /** Calls the stub intercepted, in order. */
  calls: [] as { prompt: string; maxTokens: number | undefined }[],
  /** Text the stub returns. */
  reply: "",
}));

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    complete: async (prompt: string, maxTokens?: number): Promise<string> => {
      if (!completeMock.enabled) {
        return actual.complete(prompt, maxTokens);
      }
      completeMock.calls.push({ prompt, maxTokens });
      return completeMock.reply;
    },
  };
});

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("formatting");

describe("python float formatting", () => {
  /**
   * Every case is a value read back from CPython's own `str(float(x))`.
   *
   * The thresholds are the whole point: `decpt <= -4` and `decpt > 16` switch to
   * exponential. A naive `String(value)` gets `1e16` and `1e-5` wrong, and a
   * naive `toFixed` gets the rounding of `0.005` and `0.125` wrong.
   */
  it("reproduces CPython's short repr, including the exponential thresholds", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0, "0.0"],
      [1, "1.0"],
      [0.7, "0.7"],
      [0.35, "0.35"],
      [0.12345679, "0.12345679"],
      [1e-5, "1e-05"],
      [1e-4, "0.0001"],
      [1e16, "1e+16"],
      [1.5e16, "1.5e+16"],
      [1e15, "1000000000000000.0"],
      [1234567890123456.0, "1234567890123456.0"],
      [12345678901234567.0, "1.2345678901234568e+16"],
      [123456789012345.6, "123456789012345.6"],
      [2.5, "2.5"],
      [-0.5, "-0.5"],
      [5e-324, "5e-324"],
      [1e300, "1e+300"],
      [1.7976931348623157e308, "1.7976931348623157e+308"],
    ];

    for (const [value, expected] of cases) {
      expect(pythonFloatRepr(value), `repr(${String(value)})`).toBe(expected);
    }
  });

  it("renders negative zero and the non-finite values the way Python does", () => {
    expect(pythonFloatRepr(-0)).toBe("-0.0");
    expect(pythonFloatRepr(Number.POSITIVE_INFINITY)).toBe("inf");
    expect(pythonFloatRepr(Number.NEGATIVE_INFINITY)).toBe("-inf");
    expect(pythonFloatRepr(Number.NaN)).toBe("nan");
  });

  /**
   * `f"{value:.2f}"` rounds the *exact binary value* half-to-even, which is
   * neither `toFixed` (ties away from zero) nor `Intl` (rounds the shortest
   * repr). These five values are where all three disagree.
   */
  it("reproduces f-string .2f rounding, which neither toFixed nor Intl matches", () => {
    const cases: readonly (readonly [number, string])[] = [
      [0.125, "0.12"],
      [0.375, "0.38"],
      [0.625, "0.62"],
      [0.875, "0.88"],
      [1.125, "1.12"],
      [0.005, "0.01"],
      [0.015, "0.01"],
      [0.025, "0.03"],
      [0.0625, "0.06"],
      [0.0025, "0.00"],
      [2.675, "2.67"],
      [0.7, "0.70"],
      [0.75, "0.75"],
      [0.675, "0.68"],
      [0.5512, "0.55"],
      [0.5, "0.50"],
      [1, "1.00"],
      [0, "0.00"],
      [-0.005, "-0.01"],
    ];

    for (const [value, expected] of cases) {
      expect(formatFixed2(value), `.2f of ${String(value)}`).toBe(expected);
    }
  });

  it("diverges from toFixed and Intl in the places each of them is wrong", () => {
    // Stated so the doc comment cannot rot. These are the values where the naive
    // implementations are wrong, and each one is wrong differently: `toFixed`
    // ties away from zero, `Intl` rounds the shortest decimal repr.
    expect((0.125).toFixed(2)).toBe("0.13");
    expect(formatFixed2(0.125)).toBe("0.12");

    expect((0.005).toFixed(2)).toBe("0.01");
    const halfEven = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: false,
      roundingMode: "halfEven",
    });
    expect(halfEven.format(0.005)).toBe("0.00");
    expect(formatFixed2(0.005)).toBe("0.01");

    expect(halfEven.format(2.675)).toBe("2.68");
    expect(formatFixed2(2.675)).toBe("2.67");
  });
});

describe("python json.dumps for graph_version", () => {
  it("keeps int/float identity, which JavaScript would collapse", () => {
    // jsonb text `1.0` / `1` / `1e16` -> Python `float` / `int` / `int`.
    expect(pythonJsonDumps('{"a": 1, "b": 1.0, "c": 10000000000000000}')).toBe(
      '{"a": 1, "b": 1.0, "c": 10000000000000000}',
    );
  });

  it("sorts keys by code point and emits Python's separators", () => {
    expect(pythonJsonDumps('{"z": 1, "a": [1, 2.5], "f": 0.7, "t": true, "n": null}')).toBe(
      '{"a": [1, 2.5], "f": 0.7, "n": null, "t": true, "z": 1}',
    );
  });

  it("escapes non-ASCII with ensure_ascii, including surrogate pairs", () => {
    expect(pythonJsonDumps('{"s": "é", "e": "🙂"}')).toBe('{"e": "\\ud83d\\ude42", "s": "\\u00e9"}');
  });

  it("keeps an integer larger than 2^53 verbatim", () => {
    // `JSON.parse` would round this to 123456789012345680000; Python's `int` has
    // no precision limit, so the digits must survive as text.
    expect(pythonJsonDumps('{"n": 123456789012345678901234567890}')).toBe(
      '{"n": 123456789012345678901234567890}',
    );
  });

  it("applies Python's `or {}` truthiness rule", () => {
    // Every one of these is falsy in Python, so `properties or {}` yields `{}`.
    for (const text of [null, "{}", "[]", "null", '""', "0", "-0.0", "false"]) {
      expect(pythonJsonDumps(text), `dumps(${String(text)})`).toBe("{}");
    }
  });

  it("emits a truthy non-object as itself, because Python does", () => {
    // Measured on the oracle: a hand-written scalar `properties` hashes as that
    // scalar. Rejecting it here would diverge from the other server's cache key.
    expect(pythonJsonDumps("5")).toBe("5");
    expect(pythonJsonDumps('"x"')).toBe('"x"');
    expect(pythonJsonDumps("1.5")).toBe("1.5");
    expect(pythonJsonDumps("[1, 2]")).toBe("[1, 2]");
    expect(pythonJsonDumps("true")).toBe("true");
  });

  it("sorts strings by code point, not by UTF-16 code unit", () => {
    // U+1F642 (a surrogate pair) must sort *after* U+FFFD; `<` on code units
    // would put it before.
    expect(compareCodePoints("🙂", "\uFFFD")).toBe(1);
    expect(["🙂", "\uFFFD", "a"].sort(compareCodePoints)).toEqual(["a", "\uFFFD", "🙂"]);
  });
});

describe("graph_version hashing", () => {
  /**
   * These three digests were produced by the oracle's own interpreter, from the
   * exact inputs each case builds. They are the only absolute values in this file
   * that come from the Python side, and they are what makes the port's
   * formatting decisions load-bearing instead of decorative.
   */
  it("matches the oracle's digest for a full entity", () => {
    const digest = computeGraphVersion(
      entityRow({ properties_text: '{"retries": 2, "tier": "edge"}' }),
      [
        relationshipRow({ type: "USED_BY", confidence: 0.75, other_name: "Payment Gateway" }),
        relationshipRow({ type: "HAS", confidence: 0.55, other_name: "Rate Limit", other_type: "CONCEPT" }),
      ],
      [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    );
    expect(digest).toBe("b51717ed2eda3996");
  });

  it("matches the oracle's digest for an entity with no description, properties or edges", () => {
    const digest = computeGraphVersion(
      entityRow({
        name: "Gateway",
        description: null,
        properties_text: null,
        confidence: 1,
      }),
      [],
      [],
    );
    expect(digest).toBe("ac52cf38802ba9ec");
  });

  it("matches the oracle's digest when properties carry jsonb int/float distinction", () => {
    // `1e16` arrives from jsonb as an integer, `1e-5` as a float. Getting that
    // wrong changes the hash and would invalidate the other server's cache.
    const digest = computeGraphVersion(
      entityRow({
        name: "N",
        description: null,
        confidence: 0.7,
        properties_text:
          '{"big": 10000000000000000, "k": 0.00001, "w": 0.7}',
      }),
      [],
      [],
    );
    expect(digest).toBe("8c0b7a9e18d685e1");
  });

  it("matches the oracle's digest for non-ASCII input", () => {
    const digest = computeGraphVersion(
      entityRow({
        name: "Ünïcode",
        description: "héllo",
        confidence: 1,
        properties_text: '{"e": "\\ud83d\\ude42", "s": "\\u00e9"}',
      }),
      [],
      [],
    );
    expect(digest).toBe("58e6c1f0f76d8a9a");
  });

  it("is stable across repeated calls with the same input", () => {
    const entity = entityRow();
    const relationships = [relationshipRow()];
    const first = computeGraphVersion(entity, relationships, ["doc-a"]);
    const second = computeGraphVersion(entity, relationships, ["doc-a"]);
    expect(first).toBe(second);
    expect(first).toHaveLength(16);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * Each input the hash consumes must be able to change it on its own.
   *
   * That is the entire cache-invalidation contract: a change the hash cannot see
   * is a stale page served forever. Asserted one field at a time so a missing
   * `h.update(...)` names the field it belongs to.
   */
  it("changes when any hashed input changes", () => {
    const base = computeGraphVersion(entityRow(), [relationshipRow()], ["doc-a"]);

    expect(computeGraphVersion(entityRow({ name: "Other" }), [relationshipRow()], ["doc-a"])).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ description: "changed" }), [relationshipRow()], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ confidence: 0.71 }), [relationshipRow()], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow({ properties_text: '{"tier": "core"}' }), [relationshipRow()], [
        "doc-a",
      ]),
    ).not.toBe(base);

    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ type: "HAS" })], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ other_name: "Other" })], ["doc-a"]),
    ).not.toBe(base);
    expect(
      computeGraphVersion(entityRow(), [relationshipRow({ confidence: 0.76 })], ["doc-a"]),
    ).not.toBe(base);

    expect(computeGraphVersion(entityRow(), [relationshipRow()], ["doc-b"])).not.toBe(base);
    expect(computeGraphVersion(entityRow(), [relationshipRow()], ["doc-a", "doc-b"])).not.toBe(base);
    expect(computeGraphVersion(entityRow(), [], ["doc-a"])).not.toBe(base);
  });

  /**
   * Edges are hashed in sorted representation order, so the *order* the database
   * returned them in cannot change the hash. Without the sort, a plan change in
   * Postgres (or an added index) would invalidate every page in the Stack.
   */
  it("is independent of relationship order", () => {
    const first = relationshipRow({ type: "USES", other_name: "Alpha", confidence: 0.5 });
    const second = relationshipRow({ type: "HAS", other_name: "Beta", confidence: 0.6 });
    const third = relationshipRow({ type: "CAPS", other_name: "Gamma", confidence: 0.7 });

    const forward = computeGraphVersion(entityRow(), [first, second, third], ["doc-a", "doc-b"]);
    const reversed = computeGraphVersion(entityRow(), [third, first, second], ["doc-b", "doc-a"]);

    expect(reversed).toBe(forward);
  });

  it("truncates the digest to 16 hex characters, like the oracle", () => {
    // `h.hexdigest()[:16]` — a full SHA-256 hex digest would be 64 characters.
    expect(computeGraphVersion(entityRow(), [], [])).toHaveLength(16);
  });
});
