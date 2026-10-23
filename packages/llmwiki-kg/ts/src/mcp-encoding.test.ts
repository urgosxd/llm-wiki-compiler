/**
 * @file packages/llmwiki-kg/ts/src/mcp-encoding.test.ts
 * @description Query-string encoding, float stringification and auth headers.
 */

import { describe, expect, it } from "vitest";
import { authHeaders, encodeQuery, floatParam, intParam, pyFloatToString, quotePlus, rawParam } from "./mcp.js";

describe("quotePlus / encodeQuery", () => {
  it("escapes `*` and `!`, which URLSearchParams leaves bare", () => {
    // httpx uses quote_plus, which percent-encodes both. Verified against
    // httpx 0.28.1: "a!b'c(d)e*f~g" -> "a%21b%27c%28d%29e%2Af~g".
    const httpxExpected = "a%21b%27c%28d%29e%2Af~g";
    expect(quotePlus("a!b'c(d)e*f~g")).toBe(httpxExpected);
    // Documents the trap: URLSearchParams is NOT equivalent.
    expect(new URLSearchParams({ q: "a!b'c(d)e*f~g" }).toString()).not.toBe(`q=${httpxExpected}`);
  });

  it("maps space to `+` and keeps `-`, `_`, `.`, `~` unescaped", () => {
    expect(quotePlus("Payment Service")).toBe("Payment+Service");
    expect(quotePlus("a-b_c.d~e")).toBe("a-b_c.d~e");
    expect(quotePlus("requires,triggers")).toBe("requires%2Ctriggers");
  });

  it("percent-encodes UTF-8 multibyte characters byte by byte", () => {
    expect(quotePlus("é")).toBe("%C3%A9");
    expect(quotePlus("→")).toBe("%E2%86%92");
  });

  it("serializes params in insertion order and inserts no leading `?`", () => {
    expect(encodeQuery({ start: rawParam("Payment Service"), max_depth: intParam(2) })).toBe(
      "start=Payment+Service&max_depth=2",
    );
  });

  it("drops undefined entries, matching the Python's `if 'x' in args` guards", () => {
    expect(
      encodeQuery({
        min_confidence: floatParam(0),
        limit: intParam(100),
        domain: undefined,
        type: undefined,
      }),
    ).toBe("min_confidence=0.0&limit=100");
  });

  it("stringifies a Python float differently from a Python int", () => {
    // The heart of the httpx-parity problem: `str(0.0)` is "0.0" but
    // `str(0)`/`str(100)` is "0"/"100". The Python builds `min_confidence` as a
    // float and `limit` as an int in the same dict, so the same JS number must
    // not produce the same text for both.
    expect(encodeQuery({ min_confidence: floatParam(0), limit: intParam(100) })).toBe(
      "min_confidence=0.0&limit=100",
    );
    expect(encodeQuery({ min_confidence: floatParam(0.85) })).toBe("min_confidence=0.85");
    expect(encodeQuery({ max_depth: intParam(2) })).toBe("max_depth=2");
  });
});

describe("pyFloatToString", () => {
  it("always keeps a decimal point, unlike String()", () => {
    expect(pyFloatToString(0)).toBe("0.0");
    expect(pyFloatToString(1)).toBe("1.0");
    expect(pyFloatToString(100)).toBe("100.0");
    // This is exactly the divergence that broke the default entities URL.
    expect(String(0)).toBe("0");
  });

  it("matches CPython's str() across magnitudes", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0.5, "0.5"],
      [0.85, "0.85"],
      [0.125, "0.125"],
      [1e21, "1e+21"],
      [1e-7, "1e-07"],
      [0.0001, "0.0001"],
      [0.00001, "1e-05"],
      [1e16, "1e+16"],
      [1e15, "1000000000000000.0"],
      [-1.25, "-1.25"],
      [2.5e-5, "2.5e-05"],
    ];
    for (const [input, expected] of cases) {
      expect(pyFloatToString(input), `str(${String(input)})`).toBe(expected);
    }
  });

  it("keeps the sign on negative zero, as Python does", () => {
    expect(pyFloatToString(-0)).toBe("-0.0");
  });
});

describe("authHeaders", () => {
  it("sends no header at all when no key is configured", () => {
    // Python returns {} rather than {"X-API-Key": ""}: the header is absent.
    expect(authHeaders("")).toEqual({});
    expect(Object.hasOwn(authHeaders(""), "X-API-Key")).toBe(false);
  });

  it("sends the configured key verbatim", () => {
    expect(authHeaders("secret-key")).toEqual({ "X-API-Key": "secret-key" });
  });
});
