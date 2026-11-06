/**
 * @file test/dimensions/wiki-concept-resolution.test.ts
 * @description Identity is decided by EQUIVALENCE rules only; similarity is data,
 * never a verdict (S6, S14).
 *
 * The contract under test, in precedence order: `slug` (slugify equality),
 * `normalized` (canonical-concept-key equality), `alias` (a candidate name matches
 * an incumbent page's declared alias, or a candidate alias matches the incumbent's
 * canonical name). Nothing else may fold two names into one page.
 *
 * A dictated embedding port is still supplied in several cases — precisely to prove
 * that a score of 1.0 changes nothing about grouping and only shows up as a
 * proposal. That is the inversion this file pins: the old resolver let the cosine
 * score outrank the rules and merge "PostgreSQL" with "Postgres".
 */

import { describe, it, expect } from "vitest";

import {
  DEFAULT_PROPOSAL_THRESHOLD,
  resolveConceptIdentity,
  type ConceptEmbeddingPort,
  type ConceptEmbedOutcome,
  type ConceptIncumbentSnapshot,
} from "../../src/dimensions/wiki/concept-resolution.js";

/** Vectors placed on a plane so one cosine value can be requested directly. */
function vectorAtDegrees(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

/** The angle for one identity text, matched on its first line (the name). */
function angleFor(text: string, angles: Readonly<Record<string, number>>): number {
  return angles[text.split("\n")[0]] ?? 0;
}

/** A port whose score for a pair is dictated by the text it sees. */
function stubPort(angles: Readonly<Record<string, number>>): ConceptEmbeddingPort {
  return {
    fingerprint: "fp-test",
    async embed(texts: readonly string[]): Promise<ConceptEmbedOutcome> {
      return { ok: true, vectors: texts.map((text) => vectorAtDegrees(angleFor(text, angles))) };
    },
  };
}

/** A port that scores every pair as identical, i.e. cosine 1.0. */
const identicalPort: ConceptEmbeddingPort = {
  fingerprint: "fp-test",
  async embed(texts: readonly string[]): Promise<ConceptEmbedOutcome> {
    return { ok: true, vectors: texts.map(() => [1, 0]) };
  },
};

/** A port that records which identity texts it was asked to embed. */
function recordingPort(angles: Readonly<Record<string, number>>): {
  port: ConceptEmbeddingPort;
  embedded: string[];
} {
  const embedded: string[] = [];
  const inner = stubPort(angles);
  return {
    embedded,
    port: {
      fingerprint: inner.fingerprint,
      async embed(texts) {
        embedded.push(...texts.map((text) => text.split("\n")[0]));
        return inner.embed(texts);
      },
    },
  };
}

/** A failing port, for the reported-degradation path. */
const failingPort: ConceptEmbeddingPort = {
  fingerprint: "fp-test",
  async embed(): Promise<ConceptEmbedOutcome> {
    return { ok: false, degradation: { reason: "embeddings-failed", detail: "auth: denied" } };
  },
};

/** One incumbent page: the snapshot shape the identity stage builds from disk. */
interface IncumbentEntry {
  readonly slug: string;
  readonly canonicalName: string;
  readonly aliases?: readonly string[];
}

/** Build the incumbent snapshot identity resolution reads. */
function incumbents(entries: readonly IncumbentEntry[]): ConceptIncumbentSnapshot {
  return new Map(
    entries.map((entry) => [
      entry.slug,
      { canonicalName: entry.canonicalName, aliases: entry.aliases ?? [] },
    ]),
  );
}

describe("resolveConceptIdentity deterministic tiers", () => {
  it("folds names that share a slug at tier slug", async () => {
    const result = await resolveConceptIdentity([{ name: "Vector DB" }, { name: "vector-db" }]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].tier).toBe("slug");
    expect(result.aliases).toEqual([
      { aliasSlug: "vector-db", canonicalSlug: "vector-db", tier: "slug" },
    ]);
  });

  it("folds a plural/acronym variant at tier normalized, with no embedding port", async () => {
    const result = await resolveConceptIdentity([{ name: "Vector Database" }, { name: "Vector DB" }]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].canonicalName).toBe("Vector DB");
    expect(result.groups[0].tier).toBe("normalized");
  });

  it("keeps unrelated concepts in separate groups", async () => {
    const result = await resolveConceptIdentity([{ name: "Baking Bread" }, { name: "Vector Database" }]);
    expect(result.groups).toHaveLength(2);
  });
});

describe("resolveConceptIdentity: equivalence is not similarity", () => {
  it("keeps two differently-named concepts as two pages when their vectors are identical", async () => {
    // Cosine 1.0 is the strongest score a provider can return. It must not merge
    // them: nothing in the names says these are the same referent.
    const result = await resolveConceptIdentity(
      [{ name: "Vector Search" }, { name: "Vector Indexing" }],
      { embed: identicalPort },
    );
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((group) => group.canonicalName)).toEqual([
      "Vector Indexing",
      "Vector Search",
    ]);
    expect(result.aliases).toHaveLength(0);
  });

  it("returns similarity as proposal data with its score and folds nothing", async () => {
    const result = await resolveConceptIdentity(
      [{ name: "Vector Search", summary: "ANN indexes" }, { name: "Vector Indexing", summary: "ANN indexes" }],
      { embed: identicalPort },
    );
    expect(result.similarities).toEqual([
      { leftName: "Vector Indexing", rightName: "Vector Search", score: 1 },
    ]);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) => group.members.length === 1)).toBe(true);
  });

  it("keeps a synonym that shares no token separate even at cosine 1.0", async () => {
    // The inverted defect-pin: this pair used to merge at tier "auto".
    const result = await resolveConceptIdentity(
      [{ name: "PostgreSQL" }, { name: "Postgres" }],
      { embed: identicalPort },
    );
    expect(result.groups).toHaveLength(2);
    expect(result.aliases).toHaveLength(0);
    expect(result.similarities).toHaveLength(1);
    expect(result.similarities[0].score).toBe(1);
  });

  it("scores only pairs that no deterministic tier already folded together", async () => {
    const { port, embedded } = recordingPort({ "Vector DB": 20, "PostgreSQL": 0 });
    const result = await resolveConceptIdentity(
      [{ name: "Vector Database" }, { name: "Vector DB" }, { name: "Postgres" }],
      { embed: port },
    );
    // "Vector Database"/"Vector DB" folded by the normalized rule, so only the two
    // pairs involving "Postgres" were worth comparing.
    expect(embedded.sort()).toEqual(["Postgres", "Vector DB", "Vector Database"]);
    expect(result.groups).toHaveLength(2);
    expect(result.similarities).toHaveLength(2);
    expect(result.similarities.map((pair) => pair.leftName)).toEqual(["Postgres", "Postgres"]);
  });

  it("publishes the proposal floor as a named constant above the identity rules", () => {
    // A proposal floor is a REPORTING choice; it can never fold anything because no
    // code path consumes it for grouping.
    expect(DEFAULT_PROPOSAL_THRESHOLD).toBeGreaterThan(0.5);
    expect(DEFAULT_PROPOSAL_THRESHOLD).toBeLessThan(1);
  });

  it("does not even propose two concepts whose tag sets are disjoint", async () => {
    // A disjoint tag set is positive evidence that two concepts differ, so the
    // comparison would be uninforming — a behaviour the tag gate already had.
    const tagged = [
      { name: "Vector Search", tags: ["storage"] },
      { name: "Vector Indexing", tags: ["cooking"] },
    ];
    const result = await resolveConceptIdentity(tagged, { embed: identicalPort });
    expect(result.groups).toHaveLength(2);
    expect(result.similarities).toHaveLength(0);
  });
});

describe("resolveConceptIdentity alias tier", () => {
  it("folds a candidate whose name matches an incumbent page's declared alias", async () => {
    const result = await resolveConceptIdentity([{ name: "pgvector store" }], {
      incumbents: incumbents([
        { slug: "vector-db", canonicalName: "Vector DB", aliases: ["pgvector store"] },
      ]),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].canonicalName).toBe("Vector DB");
    expect(result.groups[0].tier).toBe("alias");
    expect(result.aliases).toEqual([
      { aliasSlug: "pgvector-store", canonicalSlug: "vector-db", tier: "alias" },
    ]);
  });

  it("folds a candidate whose OWN alias matches an incumbent's canonical name", async () => {
    const result = await resolveConceptIdentity([{ name: "Postgres", aliases: ["PostgreSQL Database"] }], {
      incumbents: incumbents([{ slug: "postgresql-database", canonicalName: "PostgreSQL Database" }]),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].canonicalName).toBe("PostgreSQL Database");
    expect(result.groups[0].tier).toBe("alias");
    expect(result.aliases[0]).toEqual({
      aliasSlug: "postgres",
      canonicalSlug: "postgresql-database",
      tier: "alias",
    });
  });

  it("compares aliases on canonical keys rather than raw strings", async () => {
    // "Vector Indexes" only equals "vector index" after plural stemming, so a
    // raw-string comparison would miss this fold entirely.
    const result = await resolveConceptIdentity([{ name: "vector index" }], {
      incumbents: incumbents([
        { slug: "vector-store", canonicalName: "Vector Store", aliases: ["Vector Indexes"] },
      ]),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].canonicalName).toBe("Vector Store");
    expect(result.groups[0].tier).toBe("alias");
    expect(result.aliases[0].canonicalSlug).toBe("vector-store");
  });

  it("never moves a candidate that already owns its own page", async () => {
    // Both names already have a page, which is the state an alias split leaves
    // behind. The deterministic tie-break must still pick the canonical page, or
    // every compile would rename a live page and orphan the other one.
    const result = await resolveConceptIdentity(
      [{ name: "Vector Database" }, { name: "Vector DB" }],
      {
        incumbents: incumbents([
          { slug: "vector-db", canonicalName: "Vector DB" },
          { slug: "vector-database", canonicalName: "Vector Database" },
        ]),
      },
    );
    expect(result.groups[0].canonicalName).toBe("Vector DB");
    expect(result.groups[0].tier).toBe("normalized");
    expect(result.aliases[0].canonicalSlug).toBe("vector-db");
  });

  it("leaves a candidate separate when no incumbent alias matches it", async () => {
    const result = await resolveConceptIdentity([{ name: "Baking Bread" }], {
      incumbents: incumbents([{ slug: "vector-db", canonicalName: "Vector DB", aliases: ["pgvector"] }]),
    });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].canonicalName).toBe("Baking Bread");
    expect(result.aliases).toHaveLength(0);
  });
});

describe("resolveConceptIdentity canonical name", () => {
  it("keeps the name of the concept already present in the wiki", async () => {
    const result = await resolveConceptIdentity(
      [{ name: "Vector DB", confidence: 0.9 }, { name: "Vector Database", confidence: 0.1 }],
      { incumbents: incumbents([{ slug: "vector-db", canonicalName: "Vector DB" }]) },
    );
    expect(result.groups[0].canonicalName).toBe("Vector DB");
  });

  it("prefers the most confident name when nothing is incumbent", async () => {
    const result = await resolveConceptIdentity([
      { name: "Vector DB", confidence: 0.3 },
      { name: "Vector Database", confidence: 0.9 },
    ]);
    expect(result.groups[0].canonicalName).toBe("Vector Database");
  });

  it("breaks a confidence tie by code-unit name order, independent of locale", async () => {
    const result = await resolveConceptIdentity([
      { name: "Vector Database", confidence: 0.5 },
      { name: "Vector DB", confidence: 0.5 },
    ]);
    expect(result.groups[0].canonicalName).toBe("Vector DB");
  });
});

describe("resolveConceptIdentity degradation", () => {
  const pair = [{ name: "Vector Search" }, { name: "Vector Indexing" }];

  it("resolves deterministically and reports an unconfigured port", async () => {
    const result = await resolveConceptIdentity(pair);
    expect(result.degradation?.reason).toBe("embeddings-unconfigured");
    expect(result.groups).toHaveLength(2);
    expect(result.similarities).toHaveLength(0);
  });

  it("resolves deterministically and reports a failing provider", async () => {
    const result = await resolveConceptIdentity(pair, { embed: failingPort });
    expect(result.degradation?.reason).toBe("embeddings-failed");
    expect(result.degradation?.detail).toContain("auth");
    expect(result.groups).toHaveLength(2);
    expect(result.similarities).toHaveLength(0);
  });

  it("reports no degradation when a single concept needs no comparison", async () => {
    const result = await resolveConceptIdentity([{ name: "Baking Bread" }]);
    expect(result.degradation).toBeUndefined();
  });
});

describe("resolveConceptIdentity invariants", () => {
  const candidates = [
    { name: "Vector Database" },
    { name: "Vector DB" },
    { name: "HNSW Index" },
    { name: "Baking Bread" },
  ];

  it("produces the same grouping regardless of input order", async () => {
    const forward = await resolveConceptIdentity(candidates);
    const reversed = await resolveConceptIdentity([...candidates].reverse());
    expect(reversed.groups.map((group) => group.canonicalName).sort())
      .toEqual(forward.groups.map((group) => group.canonicalName).sort());
  });

  it("is a fixpoint: resolving canonical names changes nothing", async () => {
    const first = await resolveConceptIdentity(candidates);
    const second = await resolveConceptIdentity(
      first.groups.map((group) => ({ name: group.canonicalName })),
    );
    expect(second.groups.map((group) => group.canonicalName).sort())
      .toEqual(first.groups.map((group) => group.canonicalName).sort());
    expect(second.aliases).toHaveLength(0);
  });
});
