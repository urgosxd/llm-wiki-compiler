/**
 * @file test/mcp/list-stacks-contract.test.ts
 * @description S3: ONE `list_stacks` contract, proven against BOTH servers.
 *
 * ## Why one test drives both dimensions
 *
 * The two dimensions are separate stdio servers, so "unified" cannot mean one shared
 * implementation. It means the SAME contract, implemented twice — and two implementations
 * are only unified if something compares them. Each dimension's own suite can stay green
 * while the pair drifts, because neither suite ever asks the other what it advertises.
 * So every case here connects a real `Client` to a real server over the SDK's in-memory
 * transport, once per dimension, and compares what came back.
 *
 * ## Why the schema is compared field by field and not with one `toEqual`
 *
 * The machine-readable half is compared exactly: the same property keys in the same
 * order, the same `type`, the same `minimum`/`maximum`, the same `limit` description,
 * and NO `required` list in either. The `stackId` description is the one field a
 * dimension is entitled to finish in its own words, because the omission rule genuinely
 * differs: the wiki deployment IS bound to a Stack and marks it, while the KG dimension
 * reads no Stack from its environment at all and therefore marks nothing. Forcing those
 * two sentences to be byte-identical would make one of them false, which is the
 * papering-over L11 refused. Both halves are asserted separately here — the shared
 * sentence byte for byte, then each dimension's own tail — so drift in either fails.
 *
 * ## Why the wiki side needs a database but asserts anyway
 *
 * The wiki `list_stacks` reads Postgres under a tenant policy, so the harness provisions
 * a real Stack and the process is bound to it. When no database is reachable the fixture
 * cannot provision one and the case returns early, the same convention the other
 * database-backed suites use.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { buildServer } from "../fixtures/mcp-test-env.js";
import { scratchProjectRoot } from "../fixtures/host-scratch.js";
import { createKgPostgresHarness } from "../fixtures/kg-postgres.js";
import type { KgPostgresHarness } from "../fixtures/kg-postgres.js";
import { createMcpServer } from "../../packages/llmwiki-kg/ts/src/mcp.js";
import {
  BASE_URL,
  CONTRACT_STACK_KEYS,
  ORACLE_STACKS_BODY,
  recordingFetch,
} from "../../packages/llmwiki-kg/ts/src/mcp-harness.js";

/** The `stackId` sentence both dimensions must share, byte for byte. */
const SHARED_STACK_ID_SENTENCE =
  "Stack to treat as the current one. This does NOT narrow the listing — " +
  "it only decides which entry is marked isCurrent.";

/** What the WIKI dimension adds: it IS bound to a Stack, so omission means that one. */
const WIKI_STACK_ID_TAIL = " Omit for the bound Stack.";

/** What the KG dimension adds: it is bound to nothing, so omission marks nothing. */
const KG_STACK_ID_TAIL = " Omit it to mark no entry current: this endpoint has no bound Stack.";

/** The `limit` description, identical in both dimensions. */
const LIMIT_DESCRIPTION = "How many Stacks to return (default 50, max 200).";

/** The runtime types each contract field may take; `null` is its own name here. */
const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  id: ["string"],
  name: ["string"],
  domain: ["string", "null"],
  description: ["string", "null"],
  scope: ["string"],
  compilationStrategy: ["string", "null"],
  synthesizeDescriptions: ["boolean"],
  createdAt: ["string"],
  updatedAt: ["string"],
  isCurrent: ["boolean"],
};

/** One property of the advertised schema. */
interface SchemaProperty {
  readonly type?: string;
  readonly description?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** The subset of the advertised `list_stacks` schema these cases compare. */
interface ListedSchema {
  readonly properties: Record<string, SchemaProperty>;
  readonly required?: string[];
}

/** The decoded `list_stacks` envelope. */
interface Payload {
  readonly stacks: ReadonlyArray<Record<string, unknown>>;
  readonly count: number;
}

/** One envelope, measured field by field so a failure names the axis. */
interface EnvelopeShape {
  readonly envelopeKeys: string[];
  readonly count: number;
  readonly size: number;
  readonly stackKeys: string[];
  readonly fieldTypes: Record<string, readonly string[]>;
}

/** The two server capabilities these cases use; both dimensions' builders qualify. */
interface Connectable {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

let root: string;
let stack: KgPostgresHarness;

beforeEach(async () => {
  root = await scratchProjectRoot("list-stacks-contract-");
  stack = await createKgPostgresHarness("list-stacks-contract");
  process.env.AKS_STACK_ID = stack.stackId;
});

afterEach(async () => {
  delete process.env.AKS_STACK_ID;
  await stack.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** Connect a real client to `server` and run `body` over the handshake. */
async function withClient<T>(server: Connectable, body: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "list-stacks-contract", version: "0" });
  await client.connect(clientTransport);
  try {
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

/** The KG server, over a stubbed `GET /stacks` answering the recorded body. */
function kgServer(): Connectable {
  const { fetchImpl } = recordingFetch({ status: 200, body: ORACLE_STACKS_BODY });
  return createMcpServer({ fetchImpl, baseUrl: BASE_URL, apiKey: "" });
}

/** The declared `list_stacks` schema, as the server advertises it. */
async function listedSchema(client: Client): Promise<ListedSchema> {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === "list_stacks");
  if (tool === undefined) throw new Error("list_stacks is not advertised");
  return tool.inputSchema as unknown as ListedSchema;
}

/** Decode a `tools/call` answer, refusing to proceed on a refusal envelope. */
function decode(result: unknown): Payload {
  const envelope = result as {
    isError?: boolean;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  };
  expect(envelope.isError ?? false, "list_stacks refused a call it must answer").toBe(false);
  const text = (envelope.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  return JSON.parse(text) as Payload;
}

/** One wiki-dimension `list_stacks` call, against the Stack the deployment is bound to. */
async function wikiPayload(args: Record<string, unknown>): Promise<Payload> {
  return withClient(buildServer(root), async (client) =>
    decode(await client.callTool({ name: "list_stacks", arguments: args })),
  );
}

/** One KG-dimension `list_stacks` call, against the stubbed `GET /stacks`. */
async function kgPayload(args: Record<string, unknown>): Promise<Payload> {
  return withClient(kgServer(), async (client) =>
    decode(await client.callTool({ name: "list_stacks", arguments: args })),
  );
}

/** `null` is a type of its own here: `typeof null` would say "object". */
function typeName(value: unknown): string {
  return value === null ? "null" : typeof value;
}

/** Measure one envelope: key order, `count`, each entry's keys, and per-field types. */
function shapeOf(payload: Payload): EnvelopeShape {
  const fieldTypes: Record<string, string[]> = {};
  for (const key of CONTRACT_STACK_KEYS) {
    const seen = payload.stacks.map((entry) => typeName(entry[key]));
    fieldTypes[key] = [...new Set(seen)].sort();
  }
  return {
    envelopeKeys: Object.keys(payload),
    count: payload.count,
    size: payload.stacks.length,
    stackKeys: [...new Set(payload.stacks.map((entry) => Object.keys(entry).join(",")))],
    fieldTypes,
  };
}

/** Assert one envelope satisfies the contract, naming the axis that failed. */
function expectContractShape(shape: EnvelopeShape): void {
  expect(shape.envelopeKeys).toEqual(["stacks", "count"]);
  expect(shape.count).toBe(shape.size);
  expect(shape.stackKeys).toHaveLength(1);
  expect(shape.stackKeys[0]).toBe([...CONTRACT_STACK_KEYS].join(","));
  for (const key of CONTRACT_STACK_KEYS) {
    for (const type of shape.fieldTypes[key] ?? []) {
      expect(ALLOWED_TYPES[key], `${key} may not be ${type}`).toContain(type);
    }
  }
}

describe("list_stacks declares one input schema across both dimensions", () => {
  it("declares the same property keys, in the same order, with the same types", async () => {
    const wiki = await withClient(buildServer(root), listedSchema);
    const kg = await withClient(kgServer(), listedSchema);

    expect(Object.keys(wiki.properties)).toEqual(["limit", "stackId"]);
    expect(Object.keys(kg.properties)).toEqual(Object.keys(wiki.properties));
    for (const key of Object.keys(wiki.properties)) {
      expect(kg.properties[key]?.type, key).toBe(wiki.properties[key]?.type);
    }
  });

  it("declares the same limit bounds, the same description and no required list", async () => {
    const wiki = await withClient(buildServer(root), listedSchema);
    const kg = await withClient(kgServer(), listedSchema);

    for (const [dimension, schema] of [["wiki", wiki], ["kg", kg]] as const) {
      expect(schema.properties["limit"], dimension).toEqual({
        description: LIMIT_DESCRIPTION,
        type: "integer",
        minimum: 1,
        maximum: 200,
      });
      // The exemption, in both: a discovery tool cannot demand the id it discovers.
      expect(schema.required ?? [], dimension).toHaveLength(0);
    }
  });

  it("shares the stackId sentence and states each dimension's own omission rule", async () => {
    const wiki = await withClient(buildServer(root), listedSchema);
    const kg = await withClient(kgServer(), listedSchema);

    for (const [dimension, schema, tail] of [
      ["wiki", wiki, WIKI_STACK_ID_TAIL],
      ["kg", kg, KG_STACK_ID_TAIL],
    ] as const) {
      const description = schema.properties["stackId"]?.description ?? "";
      // The shared half, byte for byte: drift in it fails here, not only in a comment.
      expect(description.startsWith(SHARED_STACK_ID_SENTENCE), dimension).toBe(true);
      expect(description.slice(SHARED_STACK_ID_SENTENCE.length), dimension).toBe(tail);
    }
    // The fact this dimension must not paper over: it is bound to no Stack.
    expect(kg.properties["stackId"]?.description ?? "").toContain("no bound Stack");
  });
});

describe("list_stacks answers one envelope across both dimensions", () => {
  it("answers `stacks` then `count` with the ten contract keys, field for field", async () => {
    if (!stack.reachable) return;
    const wiki = await wikiPayload({});
    const kg = await kgPayload({});

    for (const payload of [wiki, kg]) expectContractShape(shapeOf(payload));
    // And the two envelopes agree on the two axes the contract fixes: the envelope
    // keys and each entry's key list. Values are per-dimension data, not contract.
    expect(shapeOf(kg).envelopeKeys).toEqual(shapeOf(wiki).envelopeKeys);
    expect(shapeOf(kg).stackKeys).toEqual(shapeOf(wiki).stackKeys);
  });

  it("marks the Stack it was told about current, and sorts it first, in both", async () => {
    if (!stack.reachable) return;
    // The wiki dimension is bound to `stack.stackId`; the KG one is bound to nothing,
    // so it is TOLD which entry is current. Both must then answer the same way.
    const kgCurrent = "20efd96a-f6e1-4994-8812-65113f8db4db";
    const named: ReadonlyArray<readonly [Payload, string]> = [
      [await wikiPayload({ stackId: stack.stackId }), stack.stackId],
      [await kgPayload({ stackId: kgCurrent }), kgCurrent],
    ];

    for (const [payload, expectedId] of named) {
      const current = payload.stacks.filter((entry) => entry["isCurrent"] === true);
      expect(current).toHaveLength(1);
      expect(current[0]?.["id"]).toBe(expectedId);
      expect(payload.stacks[0]?.["id"]).toBe(expectedId);
    }
  });

  it("keeps the WIKI dimension exempt: no stackId is refused, the bound Stack answers", async () => {
    if (!stack.reachable) return;
    // Not refused — `decode` fails on an error envelope — and the omission means the
    // Stack this deployment is bound to, which is what its schema sentence says.
    const wiki = await wikiPayload({});
    const current = wiki.stacks.filter((entry) => entry["isCurrent"] === true);
    expect(current).toHaveLength(1);
    expect(current[0]?.["id"]).toBe(stack.stackId);
  });

  it("keeps the KG dimension exempt: no stackId is refused, and nothing is marked", async () => {
    // No database is needed here: this dimension answers from `GET /stacks` and reads
    // no Stack from its environment, so an omission cannot be a refusal or a guess.
    const kg = await kgPayload({});
    expect(kg.stacks.filter((entry) => entry["isCurrent"] === true)).toHaveLength(0);
  });
});
