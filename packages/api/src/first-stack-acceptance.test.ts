/**
 * @file packages/api/src/first-stack-acceptance.test.ts
 * @description T11 of `odd/tasks/stack-authority-per-request.md`: the acceptance story of the
 * whole feature, proven end to end on one running process.
 *
 * ## The story, and why it can only be proven here
 *
 * A host boots with a database configured, an EMPTY `public.stacks` and no declaration template.
 * It BINDS (S6, S9). Someone creates the first Stack over `POST /stacks` with the full complex
 * body — the way the human said they wanted to create it ("me tienta la forma de yo crear el
 * primero via API") — and the VERY NEXT request uses that Stack with no restart. That last
 * sentence is the point of the whole change: authority is a request input now, so a Stack that
 * did not exist at boot must be servable immediately after it exists.
 *
 * Every other suite pins one mechanism. This one pins the OUTCOME an operator gets, and it does
 * so through public surfaces only: a spawned `dist/api.js host`, its announced listener, and HTTP.
 *
 * ## Why the starting count is measured, never assumed
 *
 * A `1` after the action cannot tell "the feature created it" from "it was already there". So
 * {@link withEmptyDatabase} asserts the count is `0` BEFORE the case body runs, for every case.
 * The count is read through SQL, never through the product: the question is what the PROCESS
 * wrote, and asking the code under test would let a bug answer for itself.
 *
 * ## Why the test owns its database
 *
 * `createSuiteDatabase` creates a private per-run database and this file drops it in `finally`.
 * Nobody else's row can satisfy these cases, so nothing here needs a caveat about shared state.
 *
 * ## What this file deliberately does NOT assert
 *
 * The frozen viewer snapshot reflecting a Stack created after boot. `buildViewerSnapshot` is a
 * process-level read model (S14) and making it per-Stack is T14's, so a case that needed it would
 * belong to T14 rather than here. `/api/reviews` is asserted instead, because that surface
 * resolves its Stack per request (T5).
 *
 * ## Two boots, because one pass cannot show "seed only"
 *
 * The second case boots a SECOND host against the SAME database with a `--stacks-declaration`
 * (T8). That is the only way to show the seed semantics an operator depends on: the row created
 * over HTTP keeps every column it had, the declared domain that already exists is a no-op, and
 * only a domain that was absent is created.
 *
 * ## Precondition: the build has run
 *
 * `test/global-setup.ts` builds `dist/` once before any file loads; the launch names that
 * precondition instead of reporting a bare `ENOENT` from the spawn.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AKS_DATABASE_URL_ENV_VAR, AKS_STACK_ID_ENV_VAR, createDimensionsDatabase, type DimensionsDatabase } from "../../../packages/wiki/src/dimensions/activation.js";
import { healthStatus, launch, waitForReady, type Running } from "../../../test/fixtures/launcher-harness.js";
import { createSuiteDatabase } from "../../../test/fixtures/per-run-database.js";

/**
 * The DSN variable the KG graph sub-app reads.
 *
 * `POST /stacks` is the graph app's route and it resolves its OWN pool from this variable, not
 * from the dimensions layer's `AKS_DATABASE_URL`. A story that pointed only the dimensions layer
 * at the throwaway database would measure a 500 from a route that never reached it, so both are
 * set to the same per-run database.
 */
const KG_DATABASE_URL_ENV_VAR = "DATABASE_URL";

/** The API key the graph routes read. Blank is the vendored fail-OPEN mode. */
const KG_API_KEY_ENV_VAR = "AKS_API_KEY";

/** The key this file's guard case configures, and sends. */
const API_KEY = "acceptance-key";

/** `INVALID_API_KEY_DETAIL` (`packages/llmwiki-kg/ts/src/auth.ts:23`), asserted byte for byte. */
const INVALID_API_KEY_DETAIL = "Invalid or missing API key. Provide it in the X-API-Key header.";

/**
 * The one wording of `stack_unnamed`, as the whole envelope.
 *
 * Written out rather than imported so the assertion is a public contract instead of a value
 * compared with itself: this is what a client branching on the code sees on the wire.
 */
const UNNAMED_REFUSAL = {
  error: {
    code: "stack_unnamed",
    message: "This request named no Stack, and a database is configured: name one with ?stackId=.",
  },
};

/** Enough text to clear the minimum length the ingest enforces. */
const SOURCE_BODY = "A document the acceptance story offers to the Stack the previous request created.";

/**
 * The FIRST Stack, as its owner creates it: the full complex body of `POST /stacks`.
 *
 * Every field is supplied, `ontology` included, because "not simple, complex, as if I were
 * creating it over HTTP" is the shape the human asked for. A body that omitted half the columns
 * could pass while the route quietly dropped them.
 */
const COMPLEX_STACK = {
  name: "First Stack",
  domain: "acceptance-first",
  description: "The Stack the first request creates over HTTP",
  scope: "workspace",
  compilation_strategy: "global",
  synthesize_descriptions: true,
  ontology: {
    entityTypes: ["ORGANIZATION", "STARTUP", "PERSON"],
    relationshipTypes: ["EMPLOYS"],
    subtypes: [{ child: "STARTUP", parent: "ORGANIZATION" }],
    relationships: [{ type: "EMPLOYS", domains: ["ORGANIZATION"], ranges: ["PERSON"] }],
  },
} as const;

/** The Stack `POST /stacks` answered with — the part of `StackResponse` this file asserts. */
interface CreatedStack {
  /** The id the row was given, which every later request names. */
  readonly id: string;
  /** The display name the request sent. */
  readonly name: string;
  /** The unique slug the request sent, and the domain the declaration keys on later. */
  readonly domain: string;
  /** The description the request sent. */
  readonly description: string | null;
  /** The scope the request sent. */
  readonly scope: string;
  /** The compilation strategy the request sent. */
  readonly compilation_strategy: string;
  /** The flag the request sent. */
  readonly synthesize_descriptions: boolean;
  /** False when retired; a Stack created a moment ago must be usable now. */
  readonly active: boolean;
  /** The normalised ontology the row stores, or `null` when none was declared. */
  readonly ontology: { readonly entityTypes?: readonly string[] } | null;
}

/** What one booted child and the listener it announced look like to a case. */
interface BootedHost {
  /** The spawned child, for the case's `finally` block to stop. */
  readonly running: Running;
  /** The base URL it announced. */
  readonly base: string;
}

/**
 * How many rows `public.stacks` holds right now, counted through SQL.
 *
 * @param dimensions - Handle on the case's throwaway database.
 * @returns The row count of `public.stacks`.
 */
async function countStacks(dimensions: DimensionsDatabase): Promise<number> {
  const [row] = await dimensions.db.execute<{ n: number }>("select count(*)::int as n from public.stacks");
  return Number(row?.n);
}

/**
 * Every column of the one `public.stacks` row that owns `domain`, read through SQL.
 *
 * A whole-row read rather than a count, because "the seed did not overwrite my edits" is a claim
 * about CONTENT: a seeding path that updated the row would keep the count at two and change what
 * the row holds, and only the row itself can see that. Read twice — before and after the second
 * boot — and compared.
 *
 * @param dimensions - Handle on the case's throwaway database.
 * @param domain - The Stack's unique domain.
 * @returns The row, or `undefined` when no row owns that domain.
 */
async function stackRow(dimensions: DimensionsDatabase, domain: string): Promise<unknown> {
  const [row] = await dimensions.db.execute(`select * from public.stacks where domain = '${domain}'`);
  return row;
}

/**
 * A private, EMPTY database one case owns until it releases it.
 *
 * Handed out as a value, with its own `release`, so a case's `finally` is one line and the
 * emptiness assertion cannot be forgotten: it runs inside the factory, before the case can act.
 */
interface OwnedSuite {
  /** Handle on the database the case reads and writes through SQL. */
  readonly dimensions: DimensionsDatabase;
  /** The URL both layers must be pointed at: the dimensions layer and the graph sub-app. */
  readonly url: string;
  /** Closes the handle and drops the database; called from the case's `finally`. */
  release(): Promise<void>;
}

/**
 * Create a case's own database, assert it starts EMPTY, and hand it over.
 *
 * The `0` is measured here rather than in each body on purpose: it is the requirement every case
 * shares, and a case that skipped it could report a `1` the feature never earned. `label` names
 * the database, so a failure says whose starting state was wrong.
 *
 * @param label - The per-run database's name, which is also the failure message's subject.
 * @returns The owned database, empty and measured.
 */
async function emptySuiteDatabase(label: string): Promise<OwnedSuite> {
  const suite = await createSuiteDatabase(label);
  const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
  expect(
    await countStacks(dimensions),
    `${label} must start with ZERO Stacks, measured before the case acts`,
  ).toBe(0);
  return {
    dimensions,
    url: suite.url,
    release: async (): Promise<void> => {
      await dimensions.close();
      await suite.drop();
    },
  };
}

/**
 * Boot `host` against `url` with NO Stack named, require the listener it announced to answer
 * `/health`, and hand both back.
 *
 * S9's own claim, measured on every case: the process binds and answers with no Stack identity,
 * because `POST /stacks` cannot require being a Stack. `extra` carries the environment a specific
 * case needs on top — the API key, in this file — so no case re-implements the launch.
 *
 * @param url - The case's throwaway database, given to both layers.
 * @param args - Extra argv after `host --port 0`; the declaration flag, in this file.
 * @param extra - Variables layered over the base environment.
 * @returns The running child and the base URL it announced.
 */
async function bootHost(
  url: string,
  args: readonly string[] = [],
  extra: NodeJS.ProcessEnv = {},
): Promise<BootedHost> {
  const running = launch(["host", "--port", "0", ...args], root, {
    ...process.env,
    [AKS_DATABASE_URL_ENV_VAR]: url,
    [KG_DATABASE_URL_ENV_VAR]: url,
    [AKS_STACK_ID_ENV_VAR]: "",
    [KG_API_KEY_ENV_VAR]: "",
    ...extra,
  });
  const base = await waitForReady(running);
  expect(await healthStatus(base), `the announced listener must answer /health; child stderr: ${running.stderr()}`).toBe(
    200,
  );
  return { running, base };
}

/**
 * Send the one request that must be refused BECAUSE it names no Stack.
 *
 * This is the "before" half of the story and the anti-loosening half of it: before the Stack
 * exists the refusal proves the request had nothing to be served from, and after it exists the
 * same refusal proves the feature did not make per-request authority work by accepting a request
 * that names none.
 *
 * @param base - The base URL the child announced.
 * @param when - Which point of the story this is, for the failure message.
 */
async function expectUnnamedRefusal(base: string, when: string): Promise<void> {
  const response = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "/tmp/none.md", compile: false }),
  });
  expect(response.status, `an unnamed ingest must be refused ${when}`).toBe(409);
  expect(await response.json(), `the unnamed refusal must keep its one wording ${when}`).toEqual(UNNAMED_REFUSAL);
}

/**
 * Send the request that names a Stack id no row carries, which is what a request naming this
 * feature's Stack was answered with BEFORE that Stack existed.
 *
 * The id `POST /stacks` will assign is unknown in advance, so the pre-state is measured with an
 * id that names nothing: the same surface, the same validation, the same 404.
 *
 * @param base - The base URL the child announced.
 */
async function expectAbsentStackRefused(base: string): Promise<void> {
  const absent = randomUUID();
  const response = await fetch(`${base}/api/reviews?stackId=${encodeURIComponent(absent)}`);
  expect(response.status, "a Stack id that names no row must be refused before it exists").toBe(404);
  expect(await response.json()).toEqual({
    error: { code: "unknown_stack", message: `No Stack '${absent}' exists.` },
  });
}

/**
 * Create the first Stack over HTTP, with the full complex body, and require it usable.
 *
 * @param base - The base URL the child announced.
 * @param headers - Extra request headers; the guard case sends the API key through this.
 * @returns The Stack the route answered with.
 */
async function createStackOverHttp(
  base: string,
  headers: Record<string, string> = {},
): Promise<CreatedStack> {
  const response = await fetch(`${base}/stacks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(COMPLEX_STACK),
  });
  expect(response.status, "POST /stacks must create the first Stack on a host that serves none").toBe(201);
  const created = (await response.json()) as CreatedStack;
  expect(created.name).toBe(COMPLEX_STACK.name);
  expect(created.domain).toBe(COMPLEX_STACK.domain);
  expect(created.description).toBe(COMPLEX_STACK.description);
  expect(created.scope).toBe(COMPLEX_STACK.scope);
  expect(created.compilation_strategy).toBe(COMPLEX_STACK.compilation_strategy);
  expect(created.synthesize_descriptions).toBe(true);
  expect(created.ontology?.entityTypes, "the declared ontology must be stored, not dropped").toEqual([
    "ORGANIZATION",
    "STARTUP",
    "PERSON",
  ]);
  expect(created.active, "a Stack created over HTTP must be usable immediately, not retired").toBe(true);
  return created;
}

/**
 * Require that the NEXT requests are served by the Stack the previous one created, with no
 * restart in between: one on the write/mutation surface and one on the review surface.
 *
 * Both are proven on the same process that booted with zero Stacks. The mutation surface
 * validates the named id through `stackExists` per request; `/api/reviews` resolves it per request
 * since T5. A Stack that only became visible at the next boot would fail both.
 *
 * @param base - The base URL the child announced.
 * @param created - The Stack the previous request created.
 * @param checkout - The checkout the child runs in; the ingest source is written there.
 */
async function expectServedByCreatedStack(
  base: string,
  created: CreatedStack,
  checkout: string,
): Promise<void> {
  const source = path.join(checkout, "offered.md");
  await writeFile(source, SOURCE_BODY);
  const ingest = await fetch(`${base}/api/ingest?stackId=${encodeURIComponent(created.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, compile: false }),
  });
  expect(ingest.status, "the next request must be served BY the Stack the previous one created").toBe(200);
  expect((await ingest.json()) as { filename?: string }).toMatchObject({ filename: "offered.md" });
  const reviews = await fetch(`${base}/api/reviews?stackId=${encodeURIComponent(created.id)}`);
  expect(reviews.status, "the review surface must resolve the Stack this request names").toBe(200);
  expect(await reviews.json(), "the new Stack's queue is empty, and that is an answer, not a refusal").toEqual({
    reviews: [],
    total: 0,
  });
}

/**
 * Stop a child the case is finished with, and wait for it to be gone.
 *
 * @param booted - The child {@link bootHost} returned.
 */
async function stop(booted: BootedHost): Promise<void> {
  booted.running.terminate();
  await booted.running.exited;
}

/** The throwaway checkout a case's child runs in, made fresh for every case. */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "first-stack-acceptance-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a host booting with a database, zero Stacks and no declaration", () => {
  it("serves the Stack its very next request creates, with no restart", async () => {
    const suite = await emptySuiteDatabase("first-stack-acceptance");
    try {
      const first = await bootHost(suite.url);
      try {
        // The pre-state, on the same process that will serve the Stack: nothing to name yet.
        await expectUnnamedRefusal(first.base, "before any Stack exists");
        await expectAbsentStackRefused(first.base);
        const created = await createStackOverHttp(first.base);
        // The claim: the next request, on this process, served BY that Stack.
        await expectServedByCreatedStack(first.base, created, root);
        // Still refused: per-request authority works by resolving the request's Stack, not by
        // accepting a request that names none.
        await expectUnnamedRefusal(first.base, "after the Stack exists");
        expect(await countStacks(suite.dimensions), "the one Stack that exists is the one HTTP created").toBe(1);
      } finally {
        await stop(first);
      }
    } finally {
      await suite.release();
    }
  }, 180_000);
});

describe("a second run against the database the first run was serving", () => {
  it("seeds only the domain that is absent, and leaves the Stack created over HTTP untouched", async () => {
    const suite = await emptySuiteDatabase("first-stack-second-run");
    try {
      const first = await bootHost(suite.url);
      let created: CreatedStack;
      try {
        created = await createStackOverHttp(first.base);
      } finally {
        await stop(first);
      }
      expect(await countStacks(suite.dimensions), "the first run must hold the ONE Stack HTTP created").toBe(1);
      const beforeRestart = await stackRow(suite.dimensions, created.domain);
      // A REAL file in the checkout, because `--stacks-declaration` names a PATH and the second run
      // opens it. The declaration names the FIRST Stack's domain under a different name — exactly
      // what an operator's later edits through HTTP look like from a declaration's point of view —
      // plus one domain that does not exist yet, so "seeds" and "never updates" are both
      // observable.
      const declarationPath = path.join(root, "stacks.json");
      await writeFile(
        declarationPath,
        JSON.stringify({
          stacks: [
            { name: "Declared Over The First Stack", domain: created.domain, description: "declared" },
            { name: "Second Tenant", domain: "acceptance-second" },
          ],
        }),
      );
      await stop(await bootHost(suite.url, ["--stacks-declaration", declarationPath]));
      expect(
        await countStacks(suite.dimensions),
        "the declaration must create ONLY the domain that was absent, never a second row for the one that exists",
      ).toBe(2);
      expect(
        await stackRow(suite.dimensions, created.domain),
        "SEED ONLY: the Stack created over HTTP must survive the restart byte for byte",
      ).toEqual(beforeRestart);
    } finally {
      await suite.release();
    }
  }, 180_000);
});

describe("the bootstrap route's API-key guard, on a host serving no Stack", () => {
  it("refuses an unauthenticated POST /stacks, and still creates the Stack when the key is sent", async () => {
    const suite = await emptySuiteDatabase("first-stack-api-key");
    try {
      const guarded = await bootHost(suite.url, [], { [KG_API_KEY_ENV_VAR]: API_KEY });
      try {
        // S9: creating a Stack cannot require BEING a Stack, and it still requires the key —
        // dropping that guard would let any reachable client mint tenants.
        const refused = await fetch(`${guarded.base}/stacks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(COMPLEX_STACK),
        });
        expect(refused.status, "an unauthenticated POST /stacks must be refused").toBe(401);
        expect(await refused.json()).toEqual({ detail: INVALID_API_KEY_DETAIL });
        expect(await countStacks(suite.dimensions), "a refused POST must write NO row").toBe(0);
        // The same request WITH the key, so the refusal above is the guard and not a broken route.
        const created = await createStackOverHttp(guarded.base, { "x-api-key": API_KEY });
        expect(created.active).toBe(true);
        expect(await countStacks(suite.dimensions), "the authenticated POST must have created the Stack").toBe(1);
      } finally {
        await stop(guarded);
      }
    } finally {
      await suite.release();
    }
  }, 180_000);
});
