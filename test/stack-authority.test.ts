/**
 * @file test/stack-authority.test.ts
 * @description The one Stack authority: which Stack a run works on, decided ONCE,
 * with the file-backed mode a named value instead of an empty string.
 *
 * ## What these cases pin
 *
 * The precedence, in its order, and the fourth case that is the whole point: a
 * configured database with no Stack named must FAIL, not silently degrade to the
 * file backend, and must fail WITHOUT creating the Stack it says is missing. The
 * defect these cases exist for is a masquerade — "no Stack" meaning both "this wiki
 * is file-backed" and "a Stack is missing" — so the file case asserts a named kind,
 * never a falsy value, and the missing case asserts a refusal and an unchanged table.
 *
 * The fourth case is the reversal of a contract, on purpose (S1 and S12 of
 * `odd/tasks/stack-authority-per-request.md`): this file used to assert that the
 * authority RESOLVED a database-backed default Stack, and now asserts that it
 * refuses and leaves `public.stacks` empty. A refusal that provisions on its way out
 * is the defect the count exists to catch, so the count is taken after the throw.
 *
 * ## Why every case names an environment instead of reading process.env
 *
 * The test runner seeds `AKS_DATABASE_URL` for every worker (see `vitest.config.ts`),
 * so a case that inherited the process environment would be "a database is
 * configured" by accident. Each case therefore states the presence or absence it
 * means, and the file-mode cases pass `{}`.
 */

import { describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@repo/foundation";

import {
  AKS_DATABASE_URL_ENV_VAR,
  createDimensionsDatabase,
  type DimensionsDatabase,
} from "../packages/wiki/src/dimensions/activation.js";
import {
  NO_DATABASE_CONFIGURED,
  StackAuthorityError,
  requireStackId,
  resolveStackAuthority,
  resolveStackAuthorityWithoutLookup,
  stackIdOf,
  type StackAuthority,
} from "../packages/wiki/src/dimensions/stack-authority.js";
import { createSuiteDatabase } from "./fixtures/per-run-database.js";

const CALLER_STACK = "22222222-2222-2222-2222-222222222222";

/** A DSN nothing answers: "configured" without reaching any server. */
const UNREACHABLE_DSN = "postgresql://unused:unused@127.0.0.1:1/unused";

/** A handle whose only transaction fails, standing in for an unreachable database. */
function refusingDatabase(): DatabaseHandle {
  const refuse = async (): Promise<never> => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:1");
  };
  return { transaction: refuse } as unknown as DatabaseHandle;
}

/** The error a synchronous call throws, so its exact message can be pinned. */
function thrownBy(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

/** How many rows `public.stacks` holds in `dimensions` right now, read through SQL. */
async function countStacks(dimensions: DimensionsDatabase): Promise<number> {
  const [row] = await dimensions.db.execute<{ n: number }>("select count(*)::int as n from public.stacks");
  return Number(row?.n);
}

/** The refusal a promise-returning call produces, so its type and text can be pinned. */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => undefined,
    (error: unknown) => error,
  );
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
    const outcome = await refusalOf(
      resolveStackAuthority({
        env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN },
        db: refusingDatabase(),
      }),
    );

    if (!(outcome instanceof StackAuthorityError)) {
      throw new Error(`expected a StackAuthorityError, received ${String(outcome)}`);
    }
    expect(outcome.message).toContain(`${AKS_DATABASE_URL_ENV_VAR} is configured, so this run must have a Stack`);
    expect(outcome.message).toContain("POST /stacks");
  });

  it("fails loudly when a database is configured and no handle was supplied", async () => {
    const outcome = await refusalOf(
      resolveStackAuthority({ env: { [AKS_DATABASE_URL_ENV_VAR]: UNREACHABLE_DSN } }),
    );

    expect(outcome).toBeInstanceOf(StackAuthorityError);
  });

  it("refuses when the caller named none, and leaves public.stacks empty", async () => {
    const suite = await createSuiteDatabase("authority-refusal");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      // Measured, never assumed: a case that started from a populated database could
      // not tell "wrote nothing" apart from "wrote nothing new".
      expect(await countStacks(dimensions), "the throwaway database must start with ZERO Stacks").toBe(0);

      const outcome = await refusalOf(
        resolveStackAuthority({ env: { [AKS_DATABASE_URL_ENV_VAR]: suite.url }, db: dimensions.db }),
      );

      expect(outcome).toBeInstanceOf(StackAuthorityError);
      // The count is taken AFTER the throw on purpose: a refusal that creates the very
      // Stack it then reports as missing is the defect this case exists for.
      expect(
        await countStacks(dimensions),
        "resolving with no Stack named must create NO Stack, not even on its way out",
      ).toBe(0);
    } finally {
      await dimensions.close();
      await suite.drop();
    }
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
