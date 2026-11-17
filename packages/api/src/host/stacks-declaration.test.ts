/**
 * @file packages/api/src/host/stacks-declaration.test.ts
 * @description Proves the `--stacks-declaration` boot flag seeds Stacks, and that seeding is the
 * ONLY thing it does.
 *
 * ## Why these cases spawn the bundle instead of importing the loader
 *
 * The claim is about a boot: which rows exist once the process has started, what the process exits
 * with when it refuses, and whether a listener answered. All three are observable at the process
 * boundary and none of them is observable from a unit call — a mocked database would let the
 * transaction and the row-level-security binding be wrong while every assertion passed. So each case
 * spawns `dist/api.js` exactly as `main.test.ts` does, through the shared launcher harness.
 *
 * ## Why the row assertions use SQL rather than the product
 *
 * The question is what the BOOT WROTE. Asking the product — `GET /stacks`, a repository helper —
 * would let the code under test answer for itself, and a bug that wrote the wrong row would be read
 * back through the same bug.
 *
 * ## Why these cases live here and not in `main.test.ts`
 *
 * They cover ONE flag's contract, they need the same throwaway database three times, and
 * `main.test.ts` is already at the length the lint ratchet allows. The flag's own
 * cross-subcommand rejection stays with the other flags, in `main-subcommand-flags.test.ts`.
 *
 * ## The seed-only case is the point of the file
 *
 * S2 of `odd/tasks/stack-authority-per-request.md` — "1 solo semilla no se modificara" — says a
 * declared domain that already exists is a NO-OP, so an operator's later edits through
 * `PATCH /stacks/:id` survive a restart. That guarantee had no test at all: the assertion that used
 * to pin it lived in the `default-stack` suite, which the deletion of the default Stack removed.
 * The case named "SEEDS ONLY" is that pin, restored against the surface an operator actually uses.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
  type DimensionsDatabase,
} from "../../../../packages/wiki/src/dimensions/activation.js";
import {
  healthStatus,
  launch,
  runToExit,
  waitForReady,
  type Running,
} from "../../../../test/fixtures/launcher-harness.js";
import { createSuiteDatabase, type SuiteDatabase } from "../../../../test/fixtures/per-run-database.js";

/**
 * The environment of a boot pointed at `databaseUrl` that names NO Stack of its own.
 *
 * The shape an unattended deployment has when its Stacks arrive in a declaration instead of from a
 * `POST /stacks`: a database is configured, and nothing in the environment claims a Stack.
 *
 * @param databaseUrl - The throwaway database the boot is pointed at.
 * @returns The child's environment.
 */
function declaredEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return { ...process.env, [AKS_DATABASE_URL_ENV_VAR]: databaseUrl, [AKS_STACK_ID_ENV_VAR]: "" };
}

/** The columns of `public.stacks` these cases read; every other column is the table's own default. */
type DeclaredStackRow = {
  /** The Stack's display name. */
  readonly name: string;
  /** The Stack's unique slug. */
  readonly domain: string;
  /** The Stack's description, or `null` when the declaration named none. */
  readonly description: string | null;
};

/**
 * Every row `public.stacks` holds, ordered by domain so two runs compare equal.
 *
 * @param dimensions - Handle on the database the boots were pointed at.
 * @returns The rows, in domain order.
 */
async function stackRows(dimensions: DimensionsDatabase): Promise<readonly DeclaredStackRow[]> {
  return await dimensions.db.execute<DeclaredStackRow>(
    "select name, domain, description from public.stacks order by domain",
  );
}

/**
 * How many rows `public.stacks` holds right now, counted through SQL.
 *
 * @param dimensions - Handle on the database the boots were pointed at.
 * @returns The row count.
 */
async function countStacks(dimensions: DimensionsDatabase): Promise<number> {
  const [row] = await dimensions.db.execute<{ n: number }>("select count(*)::int as n from public.stacks");
  return Number(row?.n);
}

/**
 * Write one declaration file into the case's own checkout and return its path.
 *
 * A real file in a real directory, because the flag names a PATH: the refusal cases are about what
 * the boot does with a file it cannot accept, and a stubbed reader would let the case pass without
 * ever proving the file was opened.
 *
 * @param checkout - The case's throwaway working directory.
 * @param declaration - The JSON document to write, verbatim.
 * @returns The absolute path the boot is handed.
 */
async function writeDeclaration(checkout: string, declaration: unknown): Promise<string> {
  const declarationPath = path.join(checkout, "stacks.json");
  await writeFile(declarationPath, JSON.stringify(declaration));
  return declarationPath;
}

/**
 * Require that `running` announced a listener and that the listener answers `/health`.
 *
 * An announcement proves the process decided to serve; a 200 proves the socket behind it is bound.
 * The two are inseparable in every case that needs one. `waitForReady` is the harness's own wait, so
 * a boot that never binds is reported with the child's stderr rather than as a timeout.
 *
 * @param running - The spawned child.
 * @param label - Which boot this is, so a failure names the right one.
 */
async function expectListener(running: Running, label: string): Promise<void> {
  const announced = await waitForReady(running);
  expect(await healthStatus(announced), `${label} must answer /health; child stderr: ${running.stderr()}`).toBe(200);
}

/**
 * Boot the launcher with `args`, require a live listener, then stop it.
 *
 * @param args - argv after `host --port 0`, so each case supplies only its own flag.
 * @param checkout - The working directory the child runs in.
 * @param env - The child's environment.
 * @param label - Which boot this is, for the failure messages.
 */
async function boot(
  args: readonly string[],
  checkout: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<void> {
  const running = launch(["host", "--port", "0", ...args], checkout, env);
  try {
    await expectListener(running, label);
  } finally {
    running.terminate();
    await running.exited;
  }
}

/**
 * Run one case against a throwaway database, dropped whatever the case did.
 *
 * @param label - The per-run database's name, for the case's own identity.
 * @param run - The case body, given the suite database and a handle on it.
 */
async function withSuiteDatabase(
  label: string,
  run: (suite: SuiteDatabase, dimensions: DimensionsDatabase) => Promise<void>,
): Promise<void> {
  const suite = await createSuiteDatabase(label);
  const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
  try {
    await run(suite, dimensions);
  } finally {
    await dimensions.close();
    await suite.drop();
  }
}

let checkout: string;

beforeEach(async () => {
  checkout = await mkdtemp(path.join(tmpdir(), "api-stacks-declaration-"));
});

afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

it("creates exactly the Stacks the declaration names, and nothing else", async () => {
  await withSuiteDatabase("stack-declaration-two", async (suite, dimensions) => {
    // Measured, never assumed: a case that began from a populated database would prove nothing
    // about the two rows the declaration is supposed to produce.
    expect(await countStacks(dimensions), "the throwaway database must start with ZERO Stacks").toBe(0);
    const declaration = await writeDeclaration(checkout, {
      stacks: [
        { name: "First", domain: "first", description: "The first tenant" },
        { name: "Second", domain: "second" },
      ],
    });
    await boot(["--stacks-declaration", declaration], checkout, declaredEnv(suite.url), "a two-Stack boot");
    // Field by field, in domain order: a seeding path that dropped `description`, or defaulted a
    // column differently from `POST /stacks`, would show up here and nowhere else.
    expect(
      await stackRows(dimensions),
      "the declaration's two Stacks must exist, carrying exactly the fields it declared",
    ).toEqual([
      { name: "First", domain: "first", description: "The first tenant" },
      { name: "Second", domain: "second", description: null },
    ]);
  });
});

it("SEEDS ONLY: an existing domain keeps the row it already has, and gains no second one", async () => {
  await withSuiteDatabase("stack-declaration-seed-only", async (suite, dimensions) => {
    const first = await writeDeclaration(checkout, {
      stacks: [{ name: "First", domain: "tenant-x", description: "declared once" }],
    });
    await boot(["--stacks-declaration", first], checkout, declaredEnv(suite.url), "the first boot");
    expect(await stackRows(dimensions), "the first boot must have created the ONE declared Stack").toEqual([
      { name: "First", domain: "tenant-x", description: "declared once" },
    ]);
    // The SAME domain declared under a different name and description — exactly what an operator's
    // later edits look like from a declaration's point of view. S2 says the row must not move: a
    // seeding path is a seed, never an upsert, so a restart cannot revert what the operator wrote.
    const second = await writeDeclaration(checkout, {
      stacks: [{ name: "Second", domain: "tenant-x", description: "declared twice" }],
    });
    await boot(["--stacks-declaration", second], checkout, declaredEnv(suite.url), "the second boot");
    expect(
      await stackRows(dimensions),
      "a declared domain that already exists must be a NO-OP: the existing row survives untouched and no second row appears",
    ).toEqual([{ name: "First", domain: "tenant-x", description: "declared once" }]);
  });
});

it("refuses the boot on an invalid declaration, and seeds NOTHING", async () => {
  await withSuiteDatabase("stack-declaration-invalid", async (suite, dimensions) => {
    const declaration = await writeDeclaration(checkout, {
      stacks: [
        { name: "Valid", domain: "valid" },
        { name: "Bad Domain", domain: "Not A Slug" },
      ],
    });
    const settled = await runToExit(
      ["host", "--port", "0", "--stacks-declaration", declaration],
      checkout,
      declaredEnv(suite.url),
    );
    expect(settled.code, "an invalid element must refuse the boot instead of starting partially seeded").toBe(1);
    expect(settled.stdout, "a refused boot must never announce a listener").not.toContain("Host ready at");
    expect(settled.stderr, "the refusal must name the element it could not accept").toContain("stacks[1].domain");
    expect(
      await countStacks(dimensions),
      "the whole declaration is ONE transaction: the valid element before the bad one must not have been written",
    ).toBe(0);
  });
});

it("accepts an EMPTY declaration as the statement it is: zero Stacks, and a bound listener", async () => {
  await withSuiteDatabase("stack-declaration-empty", async (suite, dimensions) => {
    const declaration = await writeDeclaration(checkout, { stacks: [] });
    await boot(["--stacks-declaration", declaration], checkout, declaredEnv(suite.url), "an empty-declaration boot");
    expect(await countStacks(dimensions), "an empty declaration seeds nothing, and is not an error").toBe(0);
  });
});

it("refuses a declaration when no database is configured, because there is nowhere to seed it", async () => {
  // Stated the way production reads it — PRESENT and blank — so no loader can refill the variable
  // (see `test/fixtures/file-mode.ts`). A declaration that cannot be applied is refused rather than
  // silently dropped, which is the same rule a declaration that cannot be PARSED meets.
  const declaration = await writeDeclaration(checkout, { stacks: [{ name: "First", domain: "first" }] });
  const settled = await runToExit(["host", "--port", "0", "--stacks-declaration", declaration], checkout, {
    ...process.env,
    [AKS_DATABASE_URL_ENV_VAR]: "",
    [AKS_STACK_ID_ENV_VAR]: "",
  });
  expect(settled.code, "a declaration with no database to seed has to refuse the boot").toBe(1);
  expect(settled.stdout, "a refused boot must never announce a listener").not.toContain("Host ready at");
  expect(settled.stderr, "the refusal must name the variable that would have pointed at a database").toContain(
    AKS_DATABASE_URL_ENV_VAR,
  );
});
