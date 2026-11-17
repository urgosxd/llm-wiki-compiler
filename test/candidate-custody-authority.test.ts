/**
 * @file test/candidate-custody-authority.test.ts
 * @description The candidate custody branch follows the AUTHORITY the run resolved,
 * never the ambient `AKS_STACK_ID`.
 *
 * ## The defect this pins
 *
 * `assertCandidateMutationAccess` asked the ENVIRONMENT which backend the candidate
 * queue uses, so a run that had already resolved its Stack from the database still took
 * the FILE branch and demanded a `.llmwiki/candidates` DIRECTORY of a row-backed queue.
 *
 * ## Why the ambient variable is deleted rather than set
 *
 * Two sources answer this question here and they disagree: the ambient read answers
 * "file" once the variable is gone, and the authority answers "stack". Stripping the
 * variable is what makes the difference observable — a reader that still consults the
 * environment cannot satisfy case T1.a, and no assertion about wording is involved.
 *
 * ## No database is needed
 *
 * The row branch is a pure early return: it binds no inode and opens no connection, so
 * the headline case is observable without Postgres. Case T1.b is the touched-behaviour
 * pin — file mode keeps working, as a NAMED mode rather than as an absence.
 */

import { lstat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCandidateMutationAccess,
  CandidateCustodyUnavailableError,
} from "../packages/wiki/src/compiler/candidate-custody.js";
import type { StackAuthority } from "../packages/wiki/src/dimensions/stack-authority.js";
import { useTempRoot } from "./fixtures/temp-root.js";

/** A run that resolved its Stack from the database, handed down as a value. */
const STACK: StackAuthority = { kind: "stack", stackId: "9f1d3c2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f" };

/** The named file mode: no database is configured at all. */
const FILE: StackAuthority = { kind: "file", reason: "no-database-configured" };

/** A project root with no `.llmwiki` directory, so only a row backend can proceed. */
const root = useTempRoot();

/** The ambient Stack id as this file found it, so the strip below is undone. */
let ambientStackId: string | undefined;

beforeEach(() => {
  ambientStackId = process.env.AKS_STACK_ID;
  delete process.env.AKS_STACK_ID;
});

afterEach(() => {
  if (ambientStackId === undefined) delete process.env.AKS_STACK_ID;
  else process.env.AKS_STACK_ID = ambientStackId;
});

describe("the candidate custody branch follows the resolved authority", () => {
  it("T1.a a Stack resolved from the database needs no candidate directory", async () => {
    await expect(assertCandidateMutationAccess(root.dir, true, STACK)).resolves.toBeUndefined();
    // The guard proved the row backend without creating the file one on the way.
    await expect(lstat(path.join(root.dir, ".llmwiki"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("T1.b file mode still refuses by name and binds no directory", async () => {
    await expect(assertCandidateMutationAccess(root.dir, true, FILE))
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    await expect(assertCandidateMutationAccess(root.dir, true, FILE))
      .rejects.toThrow(/^candidate custody is unavailable$/);
    // A refused input leaves the store exactly as it was: nothing created, nothing bound.
    await expect(lstat(path.join(root.dir, ".llmwiki"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
