/**
 * @file packages/llmwiki-kg/ts/src/core/identity/key.test.ts
 * @description Deriving the stored identity key from a name and a disambiguator.
 *
 * WHY THIS FILE EXISTS. `identity_key` is `NOT NULL` with `unique (stack_id,
 * identity_key)`, so the key is the only thing standing between two homonyms and
 * a silent merge. Every case below is an observable property of the key: two
 * disambiguators must produce two keys, one disambiguator must produce one key
 * regardless of spelling, and a blank disambiguator must not invent a second
 * identity out of nothing.
 */

import { describe, expect, it } from "vitest";

import { deriveIdentityKey, isDisambiguatedIdentityKey } from "./key.js";

const LEGAL = { kind: "mentionContext", context: "  Legal " } as const;

describe("deriveIdentityKey", () => {
  it("derives the bare key from the name alone, folding case and surrounding space", () => {
    expect(deriveIdentityKey({ name: "  Billing Service " })).toBe("billing service");
    expect(deriveIdentityKey({ name: "BILLING SERVICE" })).toBe("billing service");
  });

  it("gives two homonyms with different contexts two different keys", () => {
    const legal = deriveIdentityKey({ name: "Jordan", disambiguator: LEGAL });
    const engineering = deriveIdentityKey({
      name: "Jordan",
      disambiguator: { kind: "mentionContext", context: "engineering" },
    });
    expect(legal).toBe("jordan#ctx:legal");
    expect(engineering).toBe("jordan#ctx:engineering");
    expect(legal).not.toBe(engineering);
  });

  it("folds case, surrounding space and hyphen runs of a context label", () => {
    expect(deriveIdentityKey({ name: "Jordan", disambiguator: LEGAL })).toBe(
      deriveIdentityKey({
        name: "JORDAN",
        disambiguator: { kind: "mentionContext", context: "legal" },
      }),
    );
  });

  it("keeps a canonical id verbatim, so two ids never fold into one key", () => {
    expect(
      deriveIdentityKey({ name: "Gateway", disambiguator: { kind: "canonicalId", id: " Aks-1 " } }),
    ).toBe("gateway#id:Aks-1");
    expect(
      deriveIdentityKey({ name: "Gateway", disambiguator: { kind: "canonicalId", id: "Aks_1" } }),
    ).not.toBe(
      deriveIdentityKey({ name: "Gateway", disambiguator: { kind: "canonicalId", id: "Aks-1" } }),
    );
  });

  it("derives an alias mention's key from its target, so the alias lands on that identity", () => {
    const target = { name: "Jordan Smith", disambiguator: { kind: "canonicalId", id: "p7" } } as const;
    expect(deriveIdentityKey({ name: "J. Smith", disambiguator: { kind: "aliasTarget", target } })).toBe(
      deriveIdentityKey(target),
    );
    expect(
      deriveIdentityKey({
        name: "J. Smith",
        disambiguator: { kind: "aliasTarget", target: { name: "J. Doe" } },
      }),
    ).not.toBe(deriveIdentityKey({ name: "J. Smith", disambiguator: { kind: "aliasTarget", target } }));
  });

  it("falls back to the bare key when the disambiguator carries no information", () => {
    expect(deriveIdentityKey({ name: "Jordan", disambiguator: { kind: "mentionContext", context: "  " } })).toBe(
      "jordan",
    );
    expect(deriveIdentityKey({ name: "Jordan", disambiguator: { kind: "canonicalId", id: "" } })).toBe("jordan");
  });
});

describe("isDisambiguatedIdentityKey", () => {
  it("reports a bare key and a disambiguated key apart", () => {
    expect(isDisambiguatedIdentityKey("jordan")).toBe(false);
    expect(isDisambiguatedIdentityKey("jordan#ctx:legal")).toBe(true);
    expect(isDisambiguatedIdentityKey("gateway#9f2a4c1e-0000-4000-8000-000000000000")).toBe(true);
  });
});
