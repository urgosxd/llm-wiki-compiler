/**
 * @file test/fixtures/search-embedding-corpus.ts
 * @description A Stack-backed corpus WITH embeddings, and the scripted embedding
 * double, shared by the MCP `search_pages` and SDK `search` suites.
 *
 * ## Why this is a fixture and not two local copies
 *
 * Both suites need the identical thing: page rows whose stored chunk hashes match
 * the LIVE rows, a v3 header stamped with the ACTIVE embedding configuration, and
 * a provider that answers with a vector instead of reaching the network. Written
 * twice, the copies drift -- and the one that drifts keeps passing for the wrong
 * reason (a stale hash makes the freshness walk return nothing).
 *
 * ## Why the hashes are READ BACK and never invented
 *
 * `walkFreshChunks` drops a ranked hit whose `contentHash` no longer matches the
 * live body, so a fixture with a guessed hash produces zero hits and a suite that
 * asserts "not index" would pass while asserting nothing. `seedEmbeddedCorpus`
 * therefore reads each page's live hashes through the same registry source the
 * product uses and stamps them into the store.
 *
 * ## Why the corpus has no `wiki/` tree
 *
 * The suites callers use `scratchProjectRoot`, which creates `sources/` only. With
 * no page files, any ref that comes back provably came from rows -- which is the
 * whole question the suites exist to answer.
 */

import { vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { rm } from "node:fs/promises";
import * as embeddingProvider from "../../packages/wiki/src/utils/embedding-provider.js";
import { createPageWriteSink } from "../../packages/wiki/src/dimensions/wiki/page-write-sink.js";
import { createRegistryPageSource } from "../../packages/wiki/src/dimensions/wiki/page-registry-source.js";
import { writeEmbeddingStoreToDb } from "../../packages/wiki/src/utils/embeddings-database-write.js";
import {
  resolveEmbeddingFingerprint,
  resolveEmbeddingModel,
} from "../../packages/wiki/src/utils/embeddings-store.js";
import type {
  ChunkEmbeddingV3,
  EmbeddingStoreV3,
} from "../../packages/wiki/src/utils/embeddings-store.js";
import { buildNamespaceDirs } from "../../packages/wiki/src/utils/page-registry.js";
import { testDatabaseUrl } from "./test-database.js";
import { provisionStack } from "./stack-harness.js";
import { scratchProjectRoot } from "./host-scratch.js";
import type { KgPostgresHarness } from "./kg-postgres.js";

/** Dimensions of every vector here; matches the shipped column width. */
export const DIMS = 768;

/** The two pages the corpus holds, at descending similarity. */
export const EMBEDDED_PAGES = [
  { slug: "alpha", title: "Alpha", seed: 0.9 },
  { slug: "beta", title: "Beta", seed: 0.8 },
] as const;

/**
 * A 768-dimension vector pointing mostly along one axis.
 *
 * Cosine order over these follows `seed`, so the expected ranking is stated in
 * the suite rather than compared between two black boxes. The fill is `0.5`
 * because it is exactly representable in the `float4` pgvector column; `0.01`
 * accumulates error above the comparisons these suites make (see
 * `test/dimensions/wiki-rank-chunks-parity.test.ts`).
 *
 * @param seed - Component that decides the similarity order.
 * @returns The query or chunk vector.
 */
export function vector(seed: number): number[] {
  const values = new Array<number>(DIMS).fill(0.5);
  values[0] = seed;
  return values;
}

/**
 * A v3 store carrying the given chunks, stamped with the ACTIVE configuration.
 *
 * Model and fingerprint are RESOLVED, never hardcoded: the read path gates a store
 * built by another configuration as `embedding-index-outdated`, so a literal would
 * make every case assert a degraded outcome in an environment that differs.
 *
 * @param chunks - Chunk entries to store; `entries` stays empty on purpose.
 * @returns A store the search gate accepts.
 */
export function storeOf(chunks: ChunkEmbeddingV3[]): EmbeddingStoreV3 {
  return {
    version: 3,
    model: resolveEmbeddingModel(),
    fingerprint: resolveEmbeddingFingerprint(),
    dimensions: DIMS,
    entries: [],
    chunks,
  };
}

/** The `kind` of every ref a payload carries, in returned order. */
export function refKinds(payload: unknown): string[] {
  const refs = (payload as { refs?: Array<{ kind: string }> }).refs ?? [];
  return refs.map((ref) => ref.kind);
}

/** The `slug` of every ref a payload carries, in returned order. */
export function refSlugs(payload: unknown): string[] {
  const refs = (payload as { refs?: Array<{ slug: string }> }).refs ?? [];
  return refs.map((ref) => ref.slug);
}

/** The `code` of every warning a payload carries, in returned order. */
export function warningCodes(payload: unknown): string[] {
  const warnings = (payload as { warnings?: Array<{ code: string }> }).warnings ?? [];
  return warnings.map((warning) => warning.code);
}

/** The one provider method these suites count, so the per-call cost is observable. */
export type EmbeddingDouble = Mock<() => Promise<number[]>>;

/**
 * What a search suite needs: the Stack, a root with no page files, and teardown.
 */
export interface SearchStackFixture {
  /** The provisioned Stack. */
  readonly harness: KgPostgresHarness;
  /** Project root with no `wiki/` tree, so any returned ref came from rows. */
  readonly root: string;
  /** Environment addressing this Stack on this database. */
  env(): NodeJS.ProcessEnv;
  /**
   * The scripted query embedding. Counted rather than merely stubbed: ranking from
   * embeddings is what bills a provider request per search, and a suite that cannot
   * see the count cannot say whether that new cost is real.
   */
  readonly embed: EmbeddingDouble;
}

/**
 * Register beforeEach/afterEach for a search suite bound to its own Stack.
 *
 * The lifecycle is shared rather than written per suite for the reason the
 * codebase's other fixtures are: two copies drift, and the copy that drifts keeps
 * passing (a forgotten teardown leaks a Stack the next suite trips over; a missing
 * environment restore lets a tenant leak between files).
 *
 * @param label - Short suite name, suffixed with a random id by the harness.
 * @param rootPrefix - Temp-dir prefix for the scratch project.
 * @returns A getter for the fixture of the CURRENT test.
 */
export function useSearchStackFixture(
  label: string,
  rootPrefix: string,
): () => SearchStackFixture {
  let current: SearchStackFixture | undefined;
  let savedEnv: NodeJS.ProcessEnv = {};
  let release: () => Promise<void> = async () => {};
  beforeEach(async () => {
    const provisioned = await provisionStack(label);
    release = provisioned.release;
    savedEnv = bindSearchEnvironment();
    const embed = stubEmbeddingProvider();
    const root = await scratchProjectRoot(rootPrefix);
    const stackId = provisioned.harness.stackId;
    current = {
      harness: provisioned.harness,
      root,
      embed,
      env: () => ({ ...process.env, AKS_STACK_ID: stackId, AKS_DATABASE_URL: testDatabaseUrl() }),
    };
  });
  afterEach(async () => {
    process.env = savedEnv;
    vi.restoreAllMocks();
    const fixture = current;
    current = undefined;
    if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true });
    await release();
  });
  return () => {
    if (current === undefined) throw new Error("useSearchStackFixture used outside a test");
    return current;
  };
}

/**
 * Point the process environment at the per-run database with a keyless provider.
 *
 * The credential door runs before either retrieval branch, so a suite needs SOME
 * provider; `ollama` needs no key, and no real provider is reached because
 * {@link stubEmbeddingProvider} replaces the embedding one. The ambient Stack is
 * deleted so it cannot leak in from the shell or from a sibling suite.
 *
 * @returns The environment as it was, for the caller to restore.
 */
export function bindSearchEnvironment(): NodeJS.ProcessEnv {
  const saved = { ...process.env };
  process.env.AKS_DATABASE_URL = testDatabaseUrl();
  process.env.LLMWIKI_PROVIDER = "ollama";
  delete process.env.LLMWIKI_EMBEDDING_PROVIDER;
  delete process.env.AKS_STACK_ID;
  return saved;
}

/**
 * Replace the embedding transport with a scripted one; no network, no timing.
 *
 * @returns The `embed` mock, so a caller can count the per-call embedding requests.
 */
export function stubEmbeddingProvider(): EmbeddingDouble {
  const embed = vi.fn(async () => vector(0.95));
  vi.spyOn(embeddingProvider, "getEmbeddingProvider").mockReturnValue({
    embed,
    embedBatch: async (texts: string[]) => texts.map(() => vector(0.95)),
  } as unknown as ReturnType<typeof embeddingProvider.getEmbeddingProvider>);
  return embed;
}

/** Write the corpus's page rows, WITHOUT any embedding rows. */
export async function seedPages(harness: KgPostgresHarness): Promise<void> {
  const write = createPageWriteSink(harness.db, harness.stackId);
  for (const page of EMBEDDED_PAGES) {
    const body = `${page.title} body.`;
    await write({
      directory: "concepts",
      slug: page.slug,
      body: `---\ntitle: ${page.title}\nsummary: ${page.slug} summary\n---\n\n${body}\n`,
    });
  }
}

/**
 * One chunk entry per page, with the hash the LIVE row actually produces.
 *
 * @param harness - Stack that owns the pages.
 * @returns Chunk entries the freshness walk will accept.
 */
export async function liveChunks(harness: KgPostgresHarness): Promise<ChunkEmbeddingV3[]> {
  const namespaceDirs = buildNamespaceDirs();
  const registry = createRegistryPageSource(harness.db as never, harness.stackId);
  const chunks: ChunkEmbeddingV3[] = [];
  for (const page of EMBEDDED_PAGES) {
    const pageId = `concepts/${page.slug}`;
    const live = await registry.liveEntry(pageId, namespaceDirs);
    if (live === null) throw new Error(`fixture: ${pageId} has no live row`);
    chunks.push({
      pageId,
      title: page.title,
      chunkIndex: 0,
      contentHash: live.chunkHashes[0] as string,
      text: `${page.title} body.`,
      vector: vector(page.seed),
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  return chunks;
}

/** Page rows plus a v3 chunk store whose hashes match the LIVE rows. */
export async function seedEmbeddedCorpus(harness: KgPostgresHarness): Promise<void> {
  await seedPages(harness);
  await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeOf(await liveChunks(harness)));
}
