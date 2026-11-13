/**
 * @file test/embeddings-store-inputs.test.ts
 * @description `wiki.embedding_store_meta` must be SELF-DESCRIBING: a digest alone
 * cannot be read back, so a corpus whose provider default moved on becomes
 * unanalysable — the values that would reproduce its fingerprint are recorded nowhere.
 *
 * ## What these cases are actually pinning
 *
 * The inputs are resolved from the ACTIVE configuration at write time, and the only
 * reason they may land in the row is that their digest IS the fingerprint already
 * stored. Each case is one half of that contract:
 *
 *  - what is written when the digest checks out;
 *  - what must NOT be written when the digest belongs to another environment (NULL,
 *    which says "unknown" rather than guessing);
 *  - that a POPULATED row never stands in for the comparison the gate makes —
 *    recording an input must not become a way to relax the gate;
 *  - that an operator-supplied endpoint cannot smuggle a credential into a column
 *    that, unlike the fingerprint, is stored in cleartext.
 *
 * Split from `embeddings-database.test.ts` because that file is already at the
 * project's size limit.
 *
 * ## Why there is no `skipIf` here
 *
 * A database-backed suite must FAIL when no database can be obtained: a skip reports as a
 * pass while asserting nothing. `createKgPostgresHarness` already throws for that case
 * (unless the one documented opt-out is set), so the provisioning step in `beforeEach` is
 * the whole rule -- and a local reachability probe here would be a second copy of it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { KgPostgresHarness } from "./fixtures/kg-postgres.js";
import { provisionStack } from "./fixtures/stack-harness.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";
import { databaseEmbeddingSource, splitPageId } from "../packages/wiki/src/utils/embeddings-database.js";
import { loadEmbeddingsForSearch } from "../packages/wiki/src/utils/embeddings-load.js";
import { writeEmbeddingStoreToDb } from "../packages/wiki/src/utils/embeddings-database-write.js";
import {
  resolveEmbeddingFingerprint,
  resolveEmbeddingModel,
  storeMatchesActiveEmbedding,
  type EmbeddingStoreV3,
} from "../packages/wiki/src/utils/embeddings-store.js";

/** The qualified page id these stores embed. */
const PAGE_ID = "concepts/alpha";

/** Vector width `wiki.page_embeddings.vector` declares. */
const DIMENSIONS = 768;

/** Env vars provider/fingerprint resolution reads, so no case leaks into the next. */
const EMBEDDING_ENV_KEYS = [
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OPENAI_BASE_URL",
  "OLLAMA_EMBEDDINGS_HOST",
  "OLLAMA_HOST",
] as const;

/** A local OpenAI-compatible endpoint with no credentials, so it is stored verbatim. */
const LOCAL_ENDPOINT_ENV = {
  LLMWIKI_PROVIDER: "openai",
  LLMWIKI_EMBEDDING_PROVIDER: "openai",
  OPENAI_EMBEDDINGS_BASE_URL: "http://localhost:8000/v1",
};

const { setEnv, restore } = createEnvSnapshot(EMBEDDING_ENV_KEYS);

/** The inputs a header row carries, as the columns actually persist them. */
interface HeaderInputs extends Record<string, unknown> {
  backend: string | null;
  endpoint: string | null;
  fingerprint: string | null;
  model: string;
}

/** The digest those three values produce, computed independently of the producer. */
function identityDigest(backend: string, model: string, endpoint: string): string {
  return createHash("sha256").update([backend, model, endpoint].join("\0"), "utf8").digest("hex");
}

/** Read the header inputs straight from the row this Stack's write produced. */
async function readHeaderInputs(harness: KgPostgresHarness): Promise<HeaderInputs> {
  const rows = await harness.db.execute<HeaderInputs>(
    `select backend, endpoint, fingerprint, model
       from wiki.embedding_store_meta where stack_id = '${harness.stackId}'`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("the write left no header row to inspect");
  return row;
}

/** One v3 store over a single page, stamped with `fingerprint` when given. */
function storeFor(fingerprint?: string): EmbeddingStoreV3 {
  return {
    version: 3,
    model: resolveEmbeddingModel(),
    dimensions: DIMENSIONS,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    entries: [{
      pageId: PAGE_ID,
      title: "Title",
      summary: "Summary",
      embeddingTextHash: "hash-1",
      vector: new Array<number>(DIMENSIONS).fill(0.01),
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    chunks: [],
  };
}

/** Write one store for this Stack, after inserting the page its foreign key needs. */
async function writeStamped(harness: KgPostgresHarness, fingerprint?: string): Promise<void> {
  const split = splitPageId(PAGE_ID);
  if (split === null) throw new Error(`fixture used a malformed page id: ${PAGE_ID}`);
  await harness.db.execute(
    `insert into wiki.pages (stack_id, page_directory, slug, title)
       values ('${harness.stackId}', '${split.pageDirectory}', '${split.slug}', 'T')`,
  );
  await writeEmbeddingStoreToDb(harness.db, harness.stackId, storeFor(fingerprint));
}

/** Load this Stack's store through the same seam the query path uses. */
async function load(harness: KgPostgresHarness): Promise<Awaited<ReturnType<typeof loadEmbeddingsForSearch>>> {
  return loadEmbeddingsForSearch("", databaseEmbeddingSource(harness.db, harness.stackId));
}

/** Provision a Stack whose active configuration is a local OpenAI-compatible server. */
async function freshStack(): Promise<KgPostgresHarness> {
  const harness = (await provisionStack("inputs")).harness;
  setEnv(LOCAL_ENDPOINT_ENV);
  return harness;
}

describe("the header records the fingerprint's inputs", () => {
  let harness: KgPostgresHarness;
  beforeEach(async () => { harness = await freshStack(); });
  afterEach(async () => { await harness.cleanup(); restore(); });

  it("writes inputs whose digest is the fingerprint it stored", async () => {
    await writeStamped(harness, resolveEmbeddingFingerprint());

    const row = await readHeaderInputs(harness);

    expect(`${row.backend}|${row.endpoint}`).toBe("openai|http://localhost:8000/v1");
    // The oracle is computed HERE from the persisted values, so a fingerprint that
    // stopped covering one of them would disagree instead of agreeing with itself.
    expect(row.fingerprint).toBe(identityDigest("openai", row.model, "http://localhost:8000/v1"));
  });

  it("records NULL for a digest it cannot vouch for, and still refuses it", async () => {
    await writeStamped(harness, "b".repeat(64));

    const row = await readHeaderInputs(harness);

    // NULL means "unknown": the honest answer for a digest another environment built.
    expect(row.backend).toBeNull();
    expect(row.endpoint).toBeNull();
    expect(row.fingerprint).toBe("b".repeat(64));
    expect((await load(harness)).store).toBeNull();
  });

  it("never stores credentials a configured endpoint carries", async () => {
    setEnv({
      ...LOCAL_ENDPOINT_ENV,
      OPENAI_EMBEDDINGS_BASE_URL: "https://user:hunter2@vllm.example.com/v1?api_key=hunter2",
    });
    await writeStamped(harness, resolveEmbeddingFingerprint());

    const row = await readHeaderInputs(harness);

    // The endpoint is operator-supplied free text, so it can carry userinfo or a token
    // in its query -- exactly why the fingerprint hashes it. This column is cleartext,
    // so the credential is stripped at this boundary.
    expect(row.endpoint).toBe("https://vllm.example.com/v1");
    // Consequence, asserted rather than assumed: these inputs no longer reproduce the
    // digest, so analysing this corpus needs the credential the reader was not given.
    expect(row.fingerprint).not.toBe(identityDigest("openai", row.model, "https://vllm.example.com/v1"));
  });
});

describe("recording an input never substitutes for the digest", () => {
  let harness: KgPostgresHarness;
  beforeEach(async () => { harness = await freshStack(); });
  afterEach(async () => { await harness.cleanup(); restore(); });

  it("still refuses a mismatched digest when the inputs are populated and would match", async () => {
    const elsewhere = "a".repeat(64);
    await writeStamped(harness, elsewhere);
    // A row whose columns were populated anyway -- by an older writer, a future one,
    // or by hand. They match the active configuration; the digest does not.
    await harness.db.execute(
      `update wiki.embedding_store_meta set backend = 'openai',
         endpoint = 'http://localhost:8000/v1' where stack_id = '${harness.stackId}'`,
    );

    const outcome = await load(harness);

    expect(outcome.store).toBeNull();
    expect(outcome.warnings.map((w) => w.code)).toContain("embedding-index-outdated");
    expect(storeMatchesActiveEmbedding({
      model: resolveEmbeddingModel(), fingerprint: elsewhere, backend: "openai",
      endpoint: "http://localhost:8000/v1",
    })).toBe(false);
  });

  it("keeps the model-name fallback for a store that never had a fingerprint", async () => {
    // The DEFAULT path on purpose: an explicit provider or endpoint override is what
    // the gate refuses to trust a bare model name under, so overriding here would test
    // the opposite rule.
    setEnv({ LLMWIKI_PROVIDER: "openai" });
    await writeStamped(harness);

    const row = await readHeaderInputs(harness);

    expect(row.fingerprint).toBeNull();
    expect(row.backend).toBeNull();
    // Untouched: no provenance and no override still matches on `model` alone, which is
    // what stops an upgrade from forcing a full re-embed of an existing wiki.
    expect((await load(harness)).store?.entries).toHaveLength(1);
  });
});
