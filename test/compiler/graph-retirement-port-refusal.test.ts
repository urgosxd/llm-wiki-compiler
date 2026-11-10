/**
 * @file test/compiler/graph-retirement-port-refusal.test.ts
 * @description An unknown dimension name REFUSES the whole compile instead of
 * silently retiring nothing.
 *
 * ## The defect this pins
 *
 * `LLMWIKI_DIMENSIONS=nope` used to make graph retirement vanish: the pre-check
 * answered "no dimension enabled", the run retired nothing, and the operator got a
 * success. The reader and the resolver were pinned afterwards, but nothing drove the
 * COMPILE path — which is the seam this slice rewires, and the only one an operator
 * actually runs. A compiler that caught the activation error to "skip retirement when
 * the switch is odd" would keep every existing pin green.
 *
 * ## Why the run's own state file is asserted byte-for-byte
 *
 * A refusal that had already advanced the run's bookkeeping would be a rejection the
 * operator can only half trust. The project holds exactly one source deletion, so
 * "unchanged" is checkable exactly: the state file the run read comes back identical,
 * and no page was written.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { STATE_FILE } from "../../packages/wiki/src/utils/constants.js";
import { DimensionActivationError } from "../../packages/wiki/src/dimensions/activation.js";
import { captureProcessIo } from "../fixtures/process-io.js";
import { seedDeletedSourceProject } from "./retirement-port-project.js";

/**
 * The refusal, asserted as a prefix: the authority owns the sentence around it.
 *
 * The tail ("in LLMWIKI_DIMENSIONS. Known dimensions: wiki, kg.") belongs to
 * `activation.ts` and is asserted verbatim there. What this file owns is that the
 * COMPILE path raises the refusal instead of skipping the retirement.
 */
const UNKNOWN_NAME_REFUSAL = 'Unknown dimension "nope"';

/** The environment that names a dimension this build cannot write. */
const UNKNOWN_SWITCH_ENV: NodeJS.ProcessEnv = { LLMWIKI_DIMENSIONS: "nope" };

/** The reason `promise` rejected, or `undefined` when it resolved. */
async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe("an unknown dimension name on the compile path", () => {
  let root: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("refuses the run rather than retiring nothing in silence", async () => {
    root = await mkdtemp(path.join(tmpdir(), "retirement-refusal-"));
    await seedDeletedSourceProject(root);
    const stateBefore = await readFile(path.join(root, STATE_FILE), "utf-8");
    captureProcessIo();

    const failure = await settled(
      compileAndReport(root, { env: UNKNOWN_SWITCH_ENV, embeddings: false }),
    );

    expect(failure).toBeInstanceOf(DimensionActivationError);
    expect((failure as Error).message).toContain(UNKNOWN_NAME_REFUSAL);

    // The rejection left the project exactly as it was: same state bytes, no page.
    expect(await readFile(path.join(root, STATE_FILE), "utf-8")).toBe(stateBefore);
    expect(await readdir(path.join(root, "wiki", "concepts"))).toEqual([]);
  }, 60_000);
});
