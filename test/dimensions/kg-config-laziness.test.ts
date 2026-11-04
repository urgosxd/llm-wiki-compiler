/**
 * @file test/dimensions/kg-config-laziness.test.ts
 * @description The vendored KG core must not snapshot `process.env` at import.
 *
 * `config.ts` parsed the environment while it was being imported, and `db.ts`
 * built its pool from `config.DATABASE_URL` at import too. llmwiki loads the
 * project `.env` after its module graph is evaluated (and its externalized
 * `@atomicstrata/llmwiki-core` chunk snapshots even earlier), so a user who
 * configured the shared embedding credential in `.env` reached the KG with an
 * environment that had not been read yet.
 *
 * Each case imports the module FIRST, writes the environment SECOND and only
 * then touches the value: that is the `.env` ordering, reproduced.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const CONFIG_MODULE = "../../packages/llmwiki-kg/ts/src/config.js";
const DB_MODULE = "../../packages/llmwiki-kg/ts/src/db.js";
const BRIDGE_MODULE = "../../packages/llmwiki-kg/ts/src/wiki-credential-fallback.js";

/** Never dialled: only the resolved client's options are read. */
const LATE_DSN = "postgresql://lazy-probe@127.0.0.1:6543/first-access-db";
/** A second DSN that must never replace the memoized one. */
const LATER_DSN = "postgresql://lazy-probe@127.0.0.1:6543/second-access-db";

/** The exact S4 message: the fix must not change what a user is told. */
const NO_KEY_MESSAGE =
  "EMBEDDING_PROVIDER=openai but no API key is configured. " +
  "Set OPENAI_API_KEY, or OPENAI_EMBEDDINGS_API_KEY to reuse the wiki dimension's credential.";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the KG config resolves on first access", () => {
  it("honors an env value written after import but before first access", async () => {
    vi.resetModules();
    const { config } = await import(CONFIG_MODULE);
    vi.stubEnv("EMBEDDING_PROVIDER", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("OPENAI_EMBEDDINGS_API_KEY", "test-key-not-real");
    expect(config.OPENAI_API_KEY).toBe("test-key-not-real");
    expect(config.EMBEDDING_PROVIDER).toBe("openai");
  });

  it("resolves once and never re-reads a later change", async () => {
    vi.resetModules();
    const { config } = await import(CONFIG_MODULE);
    vi.stubEnv("OPENAI_API_KEY", "first-key-not-real");
    expect(config.OPENAI_API_KEY).toBe("first-key-not-real");
    vi.stubEnv("OPENAI_API_KEY", "second-key-not-real");
    expect(config.OPENAI_API_KEY).toBe("first-key-not-real");
  });

  it("keeps the S4 message when no credential is reachable", async () => {
    vi.resetModules();
    const { config } = await import(CONFIG_MODULE);
    const { findEmbeddingCredentialProblem } = await import(BRIDGE_MODULE);
    vi.stubEnv("EMBEDDING_PROVIDER", "openai");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_EMBEDDINGS_API_KEY", "");
    vi.stubEnv("LLMWIKI_EMBEDDING_PROVIDER", "openai");
    expect(findEmbeddingCredentialProblem(config, process.env)).toBe(NO_KEY_MESSAGE);
  });
});

describe("the KG database pool is built on first use", () => {
  it("uses the DSN present at first access, not the one at import", async () => {
    vi.resetModules();
    const { client } = await import(DB_MODULE);
    vi.stubEnv("DATABASE_URL", LATE_DSN);
    expect(client.options.database).toBe("first-access-db");
  });

  it("builds the pool once and ignores a later DSN change", async () => {
    vi.resetModules();
    const { client } = await import(DB_MODULE);
    vi.stubEnv("DATABASE_URL", LATE_DSN);
    expect(client.options.database).toBe("first-access-db");
    vi.stubEnv("DATABASE_URL", LATER_DSN);
    expect(client.options.database).toBe("first-access-db");
  });
});
