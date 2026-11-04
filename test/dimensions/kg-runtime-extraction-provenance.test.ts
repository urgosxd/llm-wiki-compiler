/**
 * @file test/dimensions/kg-runtime-extraction-provenance.test.ts
 * @description The model the kg dimension RECORDS for a row must be the model
 * that produced that row, never the configured default.
 *
 * ## The defect this pins, measured rather than imagined
 *
 * A live ingest driven by an injected chat backend sent its extraction request
 * with the descriptor's model and then wrote `extracted_by_model` as
 * `claude-sonnet-4-5`, the configured default. Every row asserted provenance
 * that was false, and nothing failed: the graph was correct, only its
 * attribution lied.
 *
 * ## Why this is a runtime suite and not a unit test of the readers
 *
 * The override is SCOPED PER CALL. `prepare` extracts inside the chat scope and
 * returns a handle; `commit` writes the graph afterwards, when the scope is
 * already closed. A unit test that installed the backend itself and then called
 * `consolidateEntityRows` would prove the reader and stay green while the real
 * path kept recording the default — the exact trap `L12` records for the
 * embedding descriptor. So this drives `prepare` and `commit` UNMOCKED, stubs
 * only the network edge, and asks Postgres what it actually stored.
 *
 * Both directions live here on purpose: the injected case proves the descriptor
 * wins, and the un-injected case proves today's behaviour is untouched. Without
 * the second, "the descriptor's model" and "the configured model" could agree by
 * accident and the first case would prove nothing.
 *
 * Every credential below is an obvious fake, and no value is ever printed.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import { testDatabaseUrl } from "../fixtures/test-database.js";

const harness = await createKgPostgresHarness("kg-provenance");
const { db, stackId, reachable } = harness;

afterAll(async () => {
  await harness.cleanup();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The chat backend under test: what the wiki provider resolved for CHAT. */
const CHAT = {
  baseURL: "https://wiki-chat.invalid/api/v1",
  apiKey: "test-key-not-real-chat",
  model: "wiki-chat-model-not-real",
} as const;

/** The model a KG-side configuration names for itself. */
const ENV_MODEL = "env-configured-model-not-real";

/**
 * The embedding half, which this suite is not about but the dimension needs.
 *
 * Deliberately the KG namespace's own gateway, so the embedding path stays on
 * today's env-derived rules and cannot install a descriptor that would confuse
 * which service the assertions are reading.
 */
const EMBEDDING_ENV: Record<string, string> = {
  EMBEDDING_PROVIDER: "gateway",
  GATEWAY_URL: "https://gateway.invalid/v1",
  GATEWAY_API_KEY: "test-key-not-a-credential",
  EMBEDDING_MODEL: "hf:nomic-ai/nomic-embed-text-v1.5",
  EMBEDDING_DIM: "768",
};

/**
 * An environment in which the KG side configured NO extraction backend.
 *
 * `EXTRACTION_PROVIDER` is absent rather than `""`: the schema applies its
 * default to an unset variable and REJECTS an explicitly empty provider name.
 * `EXTRACTION_MODEL` is absent for the same reason plus a sharper one — leaving
 * it out is what makes `config.EXTRACTION_MODEL` the schema default, which is the
 * value the defect recorded.
 */
const NO_KG_CHAT_ENV: Record<string, string | undefined> = {
  ...EMBEDDING_ENV,
  EXTRACTION_PROVIDER: undefined,
  EXTRACTION_MODEL: undefined,
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
};

/** One document body, short enough to produce exactly one chunk. */
const BODY = "The gateway routes embedding traffic. Nomic Embed produces vectors for every chunk.";

/** A 768-wide vector, so the kg column and the stub agree on the width. */
const VECTOR = Array.from({ length: 768 }, (_, index) => (index % 7) / 7);

/** One request the stubbed network edge saw. */
interface Captured {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A well-formed tool call naming one triplet between two entities. */
function extractionPayload(subject: string, object: string): unknown {
  return {
    triplets: [
      {
        subject: { name: subject, type: "TECHNOLOGY" },
        relation: { type: "USES" },
        object: { name: object, type: "TECHNOLOGY" },
      },
    ],
  };
}

/**
 * Replace `fetch`, answering both provider calls the dimension makes.
 *
 * The real code path from this boundary inward is shipped code: the real
 * chunker, prompt, tool schema, triplet parser, consolidation SQL and foreign
 * keys. Only the network is fake, which is the one cut that leaves the behaviour
 * under test intact.
 *
 * @param payload - What the model "returns" for the extraction call.
 * @returns Every request the stub saw, in order.
 */
function stubNetwork(payload: unknown): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>;
      captured.push({ url, body });

      if (url.endsWith("/embeddings")) {
        const inputs = (body["input"] as string[] | undefined) ?? [];
        return jsonResponse({
          data: inputs.map((_, index) => ({ index, embedding: VECTOR })),
        });
      }
      if (url.endsWith("/chat/completions")) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "KGSchema", arguments: JSON.stringify(payload) },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ error: { message: `unexpected url ${url}` } }, 404);
    },
  );
  return captured;
}

/** A JSON response, shaped the way the vendored readers expect. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fresh module graph resolved under `env`.
 *
 * `vi.resetModules()` is required, not stylistic: the vendored `config` parses
 * `process.env` ONCE at import time, so an environment stated per case is only
 * seen by a fresh graph. The same applies to the dimension, which reads that
 * config through the barrel.
 *
 * @param env - Environment for this case; every value must be fake.
 * @returns The dimension factory and the config singleton that case resolved.
 */
async function loadDimension(
  env: Record<string, string | undefined>,
): Promise<{
  createKgDimension: typeof import("../../src/dimensions/kg/index.js").createKgDimension;
  config: typeof import("../../packages/llmwiki-kg/ts/src/config.js").config;
}> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const [dimension, configModule] = await Promise.all([
    import("../../src/dimensions/kg/index.js"),
    import("../../packages/llmwiki-kg/ts/src/config.js"),
  ]);
  return { createKgDimension: dimension.createKgDimension, config: configModule.config };
}

/** The one document input every case ingests. */
function input(source: string, title: string) {
  return { source, title, document: `---\ntitle: ${title}\n---\n`, body: BODY };
}

/** The `extracted_by_model` stored for the entity of this exact name. */
async function entityModel(name: string): Promise<string | null> {
  const rows = (await db.execute(
    `select extracted_by_model from ontology_entities
       where stack_id = '${stackId}' and lower(name) = lower('${name}')`,
  )) as { extracted_by_model: string | null }[];
  return rows[0]?.extracted_by_model ?? null;
}

/** The `extracted_by_model` stored for the edge leaving the named entity. */
async function relationshipModel(fromName: string): Promise<string | null> {
  const rows = (await db.execute(
    `select r.extracted_by_model
       from ontology_relationships r
       join ontology_entities f on f.id = r.from_entity_id
      where r.stack_id = '${stackId}' and lower(f.name) = lower('${fromName}')`,
  )) as { extracted_by_model: string | null }[];
  return rows[0]?.extracted_by_model ?? null;
}

describe("the kg dimension records the model that produced each row", () => {
  it.skipIf(!reachable)(
    "stores the descriptor's model on entities and edges when a chat backend is installed",
    async () => {
      const captured = stubNetwork(extractionPayload("Alpha", "Beta"));
      const { createKgDimension, config } = await loadDimension(NO_KG_CHAT_ENV);
      const dimension = () =>
        createKgDimension({
          stackId,
          stackName: "kg-provenance",
          databaseUrl: testDatabaseUrl(),
          // No embedding descriptor: the KG namespace's own gateway drives the
          // embedding half, so the only override in play is the chat one.
          describeEmbeddingBackend: () => undefined,
          describeChatBackend: () => CHAT,
        });

      const committed = await dimension().commit(
        await dimension().prepare(input(`https://provenance.test/${stackId}/injected.md`, "Injected")),
      );

      expect(committed.summary).toContain("2 entities");

      // The wire, so the recorded value has something independent to match.
      const chat = captured.find((entry) => entry.url.endsWith("/chat/completions"));
      expect(chat?.url).toBe(`${CHAT.baseURL}/chat/completions`);
      expect(chat?.body["model"]).toBe(CHAT.model);

      // The rows. Both columns the defect wrote wrong.
      expect(await entityModel("Alpha")).toBe(CHAT.model);
      expect(await entityModel("Beta")).toBe(CHAT.model);
      expect(await relationshipModel("Alpha")).toBe(CHAT.model);

      // And the value the defect stored instead, so a green result can never come
      // from the descriptor and the config default agreeing by coincidence.
      expect(config.EXTRACTION_MODEL).not.toBe(CHAT.model);
    },
    60_000,
  );

  it.skipIf(!reachable)(
    "keeps recording config.EXTRACTION_MODEL when no chat backend is installed",
    async () => {
      const captured = stubNetwork(extractionPayload("Gamma", "Delta"));
      const { createKgDimension, config } = await loadDimension({
        ...EMBEDDING_ENV,
        EXTRACTION_PROVIDER: "gateway",
        EXTRACTION_MODEL: ENV_MODEL,
        ANTHROPIC_API_KEY: "",
      });
      const dimension = () =>
        createKgDimension({
          stackId,
          stackName: "kg-provenance",
          databaseUrl: testDatabaseUrl(),
          describeEmbeddingBackend: () => undefined,
        });

      await dimension().commit(
        await dimension().prepare(input(`https://provenance.test/${stackId}/env.md`, "Env")),
      );

      // The KG side named its own backend, so nothing was injected and the
      // configured model is what the wire and the rows must carry.
      const chat = captured.find((entry) => entry.url.endsWith("/chat/completions"));
      expect(chat?.url).toBe(`${EMBEDDING_ENV["GATEWAY_URL"]}/chat/completions`);
      expect(chat?.body["model"]).toBe(config.EXTRACTION_MODEL);

      expect(await entityModel("Gamma")).toBe(config.EXTRACTION_MODEL);
      expect(await entityModel("Delta")).toBe(config.EXTRACTION_MODEL);
      expect(await relationshipModel("Gamma")).toBe(config.EXTRACTION_MODEL);
    },
    60_000,
  );
});
