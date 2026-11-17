/**
 * @file test/candidate-custody-authority-ambient-disagreement.test.ts
 * @description Two properties the candidate custody seam needs beyond "a file-mode run
 * with no store is refused": the resolved authority must be REQUIRED at the delete entry
 * points, and it must WIN over a disagreeing ambient `AKS_STACK_ID`.
 *
 * ## What the earlier pin could not see
 *
 * The T1 pin proves only that the file branch REFUSES a missing candidate store. A branch
 * that refused everything, or one wired with the wrong polarity, stayed green against it.
 * Case T1b.b is the acceptance half: file mode must also ACCEPT a provisioned store.
 *
 * ## Why the ambient variable is SET rather than deleted
 *
 * The other half of the same question. Here the two sources disagree in the opposite
 * direction: the ambient variable names a Stack while the authority says file mode. A reader
 * that still consults the environment takes the row branch and proceeds; the authority must
 * make it refuse instead. The assertion is where the result lands — an acceptance versus a
 * typed refusal — never the wording of a message.
 *
 * ## Why the omission pin is a type
 *
 * `deleteCandidate` is the entry point that used to DEFAULT its authority to the file
 * branch, so a caller could omit it and silently re-open the question the run had already
 * answered. A default cannot be observed at run time without constructing the omission the
 * shipped code no longer permits, so the pin is the compiler's: `typecheck:tests` reports an
 * unused `@ts-expect-error` directive the moment the default returns.
 */

import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCandidateMutationAccess,
  CandidateCustodyUnavailableError,
} from "../packages/wiki/src/compiler/candidate-custody.js";
import { deleteCandidate } from "../packages/wiki/src/compiler/candidates.js";
import { AKS_STACK_ID_ENV_VAR } from "../packages/wiki/src/dimensions/activation.js";
import {
  NO_DATABASE_CONFIGURED,
  type StackAuthority,
} from "../packages/wiki/src/dimensions/stack-authority.js";
import { CANDIDATES_ARCHIVE_DIR, LLMWIKI_DIR } from "../packages/wiki/src/utils/constants.js";
import { useTempRoot } from "./fixtures/temp-root.js";

/** The named file mode: nothing configured a database. */
const FILE: StackAuthority = { kind: "file", reason: NO_DATABASE_CONFIGURED };

/** A Stack id the ambient environment names, standing in for a foreign tenant binding. */
const AMBIENT_STACK_ID = "9f1d3c2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f";

/** A project root with no `.llmwiki` directory until a case creates one. */
const root = useTempRoot();

/** The ambient Stack id as this file found it, so the strip below is undone. */
let ambientStackId: string | undefined;

beforeEach(() => {
  ambientStackId = process.env[AKS_STACK_ID_ENV_VAR];
  delete process.env[AKS_STACK_ID_ENV_VAR];
});

afterEach(() => {
  if (ambientStackId === undefined) delete process.env[AKS_STACK_ID_ENV_VAR];
  else process.env[AKS_STACK_ID_ENV_VAR] = ambientStackId;
});

describe("the required authority and the ambient disagreement", () => {
  it("T1b.a a caller cannot omit the authority at the delete entry point", () => {
    // The arrow is DECLARED and never invoked: invoking it would exercise the very omission
    // the type now forbids, and the pin would then observe a runtime TypeError instead of
    // the compile-time requirement it exists to state.
    // @ts-expect-error - the authority is required; a default would silently pick the file branch
    const omitted = () => deleteCandidate(root.dir, {}, "candidate-id", {});
    expect(omitted).toBeTypeOf("function");
  });

  it("T1b.b file mode accepts a provisioned candidate store", async () => {
    await mkdir(path.join(root.dir, CANDIDATES_ARCHIVE_DIR), { recursive: true });

    await expect(assertCandidateMutationAccess(root.dir, true, FILE)).resolves.toBeUndefined();
  });

  it("T1b.c the authority beats a disagreeing ambient AKS_STACK_ID", async () => {
    process.env[AKS_STACK_ID_ENV_VAR] = AMBIENT_STACK_ID;

    await expect(assertCandidateMutationAccess(root.dir, true, FILE))
      .rejects.toBeInstanceOf(CandidateCustodyUnavailableError);
    // The refusal bound nothing: the ambient Stack named no directory to create.
    await expect(lstat(path.join(root.dir, LLMWIKI_DIR))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
