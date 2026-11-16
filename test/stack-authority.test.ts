/**
 * @file test/stack-authority.test.ts
 * @description The one Stack authority: which Stack a run works on, decided ONCE,
 * with the file-backed mode a named value instead of an empty string.
 *
 * ## What these cases pin
 *
 * The precedence, in its order, and the fourth case that is the whole point: a
 * configured database that answers no Stack must FAIL, not silently degrade to the
 * file backend the guards degraded to. The defect these cases exist for is a
 * masquerade — "no Stack" meaning both "this wiki is file-backed" and "a Stack is
 * missing" — so the file case asserts a named kind, never a falsy value, and the
 * missing case asserts that no authority came back at all.
 *
 * ## Why every case names an environment instead of reading process.env
 *
 * The test runner seeds `AKS_DATABASE_URL` for every worker (see `vitest.config.ts`),
 * so a case that inherited the process environment would be "a database is
 * configured" by accident. Each case therefore states the presence or absence it
 * means, and the file-mode cases pass `{}`.
 */

import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@repo/foundation";

import { createKgPostgresHarness } from "./fixtures/kg-postgres.js";
import { AKS_DATABASE_URL_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";
import { DEFAULT_STACK_DOMAIN } from "../packages/wiki/src/dimensions/stack-selection.js";
import {
  NO_DATABASE_CONFIGURED,
  StackAuthorityError,
  requireStackId,
  resolveStackAuthority,
  resolveStackAuthorityWithoutLookup,
  stackIdOf,
  type StackAuthority,
} from "../packages/wiki/src/dimensions/stack-authority.js";
import { isolatedCases } from "./fixtures/stack-rollback.js";

const CALLER_STACK = "22222222-2222-2222-2222-222222222222";

/** A DSN nothing answers: "configured" without reaching any server. */
const UNREACHABLE_DSN = "postgresql://unused:unused@127.0.0.1:1/unused";

const harness = await createKgPostgresHarness("stack-authority");
const { db, reachable } = harness;

afterAll(() => harness.cleanup());

/** A handle whose only transaction fails, standing in for an unreachable database. */
function refusingDatabase(): DatabaseHandle {
  const refuse = async (): Promise<never> => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  };
  return { transaction: refuse } as unknown as DatabaseHandle;
}

/** The isolated case runner: a free default domain, and everything rolled back. */
const isolated = isolatedCases(db);

/** The error a synchronous call throws, so its exact message can be pinned. */
function thrownBy(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** Ids of every row claiming the default domain, read through `tx`. */
async function defaultStackIds(tx: DatabaseHandle): Promise<readonly string[]> {
  const rows = await tx.execute<{ id: string }>(
    `select id from stacks where domain = '${DEFAULT_STACK_DOMAIN}'`,
  );
  return rows.map((row) => row.id);
}

describe("resolveStackAuthority: the caller's Stack id", () => {
  it("wins and never consults the database", async () => {
    const authority = await resolveStackAuthority({
      stackId: CALLER_STACK,
      env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN },
    });

    expect(authority).toEqual({ kind: "stack", stackId: CALLER_STACK });
  });

  it("is read as absent when blank, so resolution falls through", async () => {
    const authority = await resolveStackAuthority({ stackId: "   ", env: {} });

    expect(authority).toEqual({ kind: "file", reason: NO_DATABASE_CONFIGURED });
  });
});

describe("resolveStackAuthority: the explicit file-backed mode", () => {
  it("is named when no database is configured", async () => {
    const authority = await resolveStackAuthority({ env: {} });

    expect(authority.kind).toBe("file");
    expect(authority).toEqual({ kind: "file", reason: "no-database-configured" });
  });

  it("is named when the configured database URL is blank", async () => {
    const authority = await resolveStackAuthority({ env: { [AKS_DATABASE_URL_ENV_VAR]: "  " } });

    expect(authority).toEqual({ kind: "file", reason: NO_DATABASE_CONFIGURED });
  });
});

describe("resolveStackAuthority: a configured database", () => {
  it("fails loudly instead of returning a file authority when no Stack resolves", async () => {
    const outcome = await resolveStackAuthority({
      env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN },
      db: refusingDatabase(),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(outcome instanceof StackAuthorityError)) {
      throw new Error(`expected a StackAuthorityError, received ${String(outcome)}`);
    }
    expect(outcome.message).toContain(DEFAULT_STACK_DOMAIN);
    expect(outcome.message).toContain(AKS_DATABASE_URL_ENV_VAR);
  });

  it("fails loudly when a database is configured and no handle was supplied", async () => {
    const outcome = await resolveStackAuthority({
      env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(outcome).toBeInstanceOf(StackAuthorityError);
  });

  it("resolves the database-backed default Stack when the caller named none", async () => {
    if (!reachable) return;
    const observed = await isolated(async (tx) => ({
      authority: await resolveStackAuthority({
        env: { [AKS_DATABASE_URL_ENV_VAR]: harness.url },
        db: tx,
      }),
      rows: await defaultStackIds(tx),
    }));

    expect(observed.authority).toEqual({ kind: "stack", stackId: observed.rows[0] });
  });
});

describe("resolveStackAuthorityWithoutLookup: what a synchronous caller can settle", () => {
  it("returns an authority the caller already resolved as-is, database or not", () => {
    const settled: StackAuthority = { kind: "file", reason: NO_DATABASE_CONFIGURED };

    const authority = resolveStackAuthorityWithoutLookup(
      { authority: settled, env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN } },
      "a synchronous caller",
    );

    expect(authority).toBe(settled);
  });

  it("answers the caller's Stack id when nothing was resolved", () => {
    const authority = resolveStackAuthorityWithoutLookup(
      { stackId: `  ${CALLER_STACK}  `, env: {} },
      "a synchronous caller",
    );

    expect(authority).toEqual({ kind: "stack", stackId: CALLER_STACK });
  });

  it("names the file mode when no database is configured", () => {
    const authority = resolveStackAuthorityWithoutLookup(
      { stackId: "   ", env: {} },
      "a synchronous caller",
    );

    expect(authority).toEqual({ kind: "file", reason: NO_DATABASE_CONFIGURED });
  });

  it("refuses, in resolvePageSeams' own words, when a database is configured and nothing was supplied", () => {
    const outcome = thrownBy(() =>
      resolveStackAuthorityWithoutLookup(
        { env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN } },
        "resolvePageSeams",
      ),
    );

    expect(outcome).toBeInstanceOf(StackAuthorityError);
    expect((outcome as Error).message).toBe(
      `${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack, but resolvePageSeams ` +
        `was given no resolved authority and cannot ask the database resolver itself. ` +
        `Pass the authority the run resolved, or name the Stack in AKS_STACK_ID.`,
    );
  });
});

describe("stackIdOf", () => {
  it("converts a resolved Stack to its id", () => {
    expect(stackIdOf({ kind: "stack", stackId: CALLER_STACK })).toBe(CALLER_STACK);
  });

  it("converts the file-backed mode to no id", () => {
    expect(stackIdOf({ kind: "file", reason: NO_DATABASE_CONFIGURED })).toBeUndefined();
  });
});

describe("requireStackId", () => {
  it("returns the id of a resolved Stack", () => {
    expect(requireStackId({ kind: "stack", stackId: CALLER_STACK }, "the page store")).toBe(
      CALLER_STACK,
    );
  });

  it("refuses a row-mandatory contract in the file-backed mode", () => {
    const refuse = (): string =>
      requireStackId({ kind: "file", reason: NO_DATABASE_CONFIGURED }, "the page store");

    expect(refuse).toThrowError(StackAuthorityError);
    expect(refuse).toThrowError(/the page store requires a Stack/);
  });
});
