/**
 * @file packages/llmwiki-kg/ts/src/core/identity/resolve.test.ts
 * @description Resolving a batch of mentions against the identities a Stack already holds.
 *
 * WHY THIS FILE EXISTS. The three outcomes are the whole contract: a mention
 * either joins an existing identity (and must hand back that identity's own key,
 * so the caller updates the same row), becomes a new identity, or stays
 * UNDECIDED. The last one is not an error path — it is how separation survives
 * when the evidence cannot tell two entities apart, and every test that asserts
 * it also asserts that nothing was merged.
 */

import { describe, expect, it } from "vitest";

import { resolveIdentities } from "./resolve.js";
import type { ExtractedMention, KnownIdentity } from "./types.js";

const LEGAL_JORDAN: KnownIdentity = { id: "uuid-legal", identityKey: "jordan#ctx:legal", name: "Jordan" };
const ENGINEERING_JORDAN: KnownIdentity = {
  id: "uuid-eng",
  identityKey: "jordan#ctx:engineering",
  name: "Jordan",
};

/** A mention of `Jordan` disambiguated by a context label. */
function jordanIn(context: string, ref = "m1"): ExtractedMention {
  return { ref, name: "Jordan", disambiguator: { kind: "mentionContext", context } };
}

describe("resolveIdentities — separation", () => {
  it("gives two homonyms with different disambiguators two identities", () => {
    const [legal, engineering] = resolveIdentities([jordanIn("legal", "m1"), jordanIn("engineering", "m2")], {
      known: [],
    });
    expect(legal).toEqual({ status: "new", ref: "m1", identityKey: "jordan#ctx:legal" });
    expect(engineering).toEqual({ status: "new", ref: "m2", identityKey: "jordan#ctx:engineering" });
  });

  it("leaves a bare mention undecided when its name is claimed by two homonyms", () => {
    const [resolution] = resolveIdentities([{ ref: "m3", name: "Jordan" }], {
      known: [LEGAL_JORDAN, ENGINEERING_JORDAN],
    });
    expect(resolution).toEqual({ status: "undecided", ref: "m3", reason: "insufficient_context" });
    expect(resolution !== undefined && "identityKey" in resolution).toBe(false);
  });

  it("never merges a bare mention into the only disambiguated identity of that name", () => {
    const [resolution] = resolveIdentities([{ ref: "m4", name: "jordan" }], { known: [LEGAL_JORDAN] });
    expect(resolution).toEqual({ status: "undecided", ref: "m4", reason: "insufficient_context" });
  });

  it("never merges a disambiguated mention into a bare identity of the same name", () => {
    const [resolution] = resolveIdentities([jordanIn("legal")], {
      known: [{ id: "uuid-bare", identityKey: "jordan", name: "Jordan" }],
    });
    expect(resolution).toEqual({ status: "new", ref: "m1", identityKey: "jordan#ctx:legal" });
  });

  it("keeps a contested alias undecided instead of picking one canonical identity", () => {
    const [resolution] = resolveIdentities([{ ref: "a1", name: "J. Smith" }], {
      known: [{ id: "uuid-a", identityKey: "jordan smith#id:p7", name: "Jordan Smith" }, { id: "uuid-b", identityKey: "joan smith#id:p9", name: "Joan Smith" }],
      aliasLinks: [
        { alias: "J. Smith", canonicalIdentityId: "uuid-a" },
        { alias: "J. Smith", canonicalIdentityId: "uuid-b" },
      ],
    });
    expect(resolution).toEqual({ status: "undecided", ref: "a1", reason: "ambiguous_alias" });
  });
});

describe("resolveIdentities — stability", () => {
  it("resolves the same mention to the same existing identity on a second pass", () => {
    const [resolution] = resolveIdentities([jordanIn("legal")], {
      known: [{ id: "uuid-new", identityKey: "jordan#ctx:legal", name: "Jordan" }],
    });
    expect(resolution).toEqual({
      status: "matched",
      ref: "m1",
      identityId: "uuid-new",
      identityKey: "jordan#ctx:legal",
      matchedVia: "identity_key",
    });
  });

  it("resolves one mention seen twice in one batch to one key", () => {
    const resolutions = resolveIdentities([{ ref: "m1", name: "  Jordan Smith " }, { ref: "m2", name: "jordan smith" }], {
      known: [],
    });
    expect(resolutions.map((outcome) => outcome.status)).toEqual(["new", "new"]);
    expect(new Set(resolutions.map((outcome) => (outcome.status === "new" ? outcome.identityKey : outcome.ref))).size).toBe(1);
  });

  it("returns the pre-existing key of a matched identity, not a re-derived one", () => {
    const [resolution] = resolveIdentities([{ ref: "m1", name: "Billing Service" }], {
      known: [{ id: "uuid-legacy", identityKey: "billing service", name: "Billing  Service" }],
    });
    expect(resolution).toEqual({
      status: "matched",
      ref: "m1",
      identityId: "uuid-legacy",
      identityKey: "billing service",
      matchedVia: "identity_key",
    });
  });

  it("treats case and whitespace variants of a new mention as one identity", () => {
    const [fresh] = resolveIdentities([{ ref: "m1", name: "Gateway" }], { known: [] });
    expect(fresh).toEqual({ status: "new", ref: "m1", identityKey: "gateway" });
    const [again] = resolveIdentities([{ ref: "m2", name: " GATEWAY " }], {
      known: [{ id: "uuid-gw", identityKey: "gateway", name: "Gateway" }],
    });
    expect(again).toEqual({ status: "matched", ref: "m2", identityId: "uuid-gw", identityKey: "gateway", matchedVia: "identity_key" });
  });
});

describe("resolveIdentities — aliases", () => {
  const CANONICAL: KnownIdentity = { id: "uuid-person", identityKey: "jordan smith#id:p7", name: "Jordan Smith" };

  it("keeps an alias mention separate while no alias link exists", () => {
    const [resolution] = resolveIdentities([{ ref: "a1", name: "J. Smith" }], { known: [CANONICAL] });
    expect(resolution).toEqual({ status: "new", ref: "a1", identityKey: "j. smith" });
  });

  it("normalizes an alias mention to the canonical identity once the link exists", () => {
    const [resolution] = resolveIdentities([{ ref: "a1", name: "J. Smith" }], {
      known: [CANONICAL],
      aliasLinks: [{ alias: "j. smith", canonicalIdentityId: "uuid-person" }],
    });
    expect(resolution).toEqual({
      status: "matched",
      ref: "a1",
      identityId: "uuid-person",
      identityKey: "jordan smith#id:p7",
      matchedVia: "alias",
    });
  });
});
