/**
 * @file The probe-Stack gate and teardown the two-backend wiki suites share.
 *
 * ## What is shared here, and why it has to be ONE copy
 *
 * `test/dimensions/store-parity.test.ts` (the acceptance parity suite) and
 * `test/dimensions/row-store-of-record.test.ts` (the store-of-record suite) both need the
 * same three things before a single case can run: a probe Stack, a decision about what to
 * do when there is no database, and a teardown that removes the Stack and the suite's temp
 * root. Each suite carried its own copy and `fallow` reported two clone groups between
 * them. Duplication in tests is duplication of intent: a change to the no-database rule
 * would have had to be made twice, and the second copy is exactly where it gets forgotten.
 *
 * The fixtures layer is where the repository already puts this kind of sharing --
 * `category-rows.ts` was extracted for the same reason, when `fallow` reported five clone
 * groups between the two row-backed category suites.
 *
 * ## The rule this module enforces, and why it is NOT a skip
 *
 * A database-backed suite must FAIL when no database can be obtained: a skip is reported
 * as a pass while asserting nothing, and the acceptance test of a cross-backend feature is
 * the worst possible place for that. The wording and the decision belong to
 * `missingTestDatabase` (`test/fixtures/test-database-handoff.ts`), which THROWS unless the
 * one documented opt-out `LLMWIKI_TEST_ALLOW_NO_DATABASE=1` is set. Only with that opt-out
 * does the suite skip -- with the reason printed and the title annotated, so an offline run
 * says what it dropped instead of quietly reporting green.
 *
 * A Stack the harness could not provision is as unusable as a server that never answered,
 * and the two used to collapse into the same silent skip. Both are reported as evidence: the
 * provisioning failure's own message when there is one, and the harness's reachability
 * verdict otherwise.
 *
 * ## Why the teardown is one function and not two steps
 *
 * The Stack is a database domain matched by PREFIX when it is cleaned up, so a leaked one
 * deletes another suite's rows later; the temp root holds several real compiles' worth of
 * page, source and category files, so a suite that forgets it fills the host's `/tmp` one
 * run at a time. Both belong to one lifecycle step, and a suite that ran the first half
 * without the second is the bug this function exists to make unrepresentable.
 *
 * ## What the caller still owns
 *
 * The temp root and the environment snapshot: a suite decides when it exists and what it
 * saved, and this module only takes them away again. `probeStack()` is returned rather than
 * the harness so a suite installs the Stack's environment through the one accessor that
 * also explains, loudly, why there is no Stack.
 */

import { rm } from "node:fs/promises";
import { vi } from "vitest";
import { createProbeStack, type ProbeStack } from "../dimensions/harness-lifecycle.js";
import { missingTestDatabase } from "./test-database-handoff.js";

/** Lines that begin the shared advice a nested "no database" failure already carries. */
const ADVICE_MARKERS: readonly string[] = [
  "Database-backed suites must not skip here:",
  "Skipping is not an option here:",
  "Supply a database in any of these ways:",
];

/** Suffix that makes a skipped suite explain itself in the runner's output. */
const SKIPPED_SUFFIX = " — SKIPPED: no database, reason below";

/**
 * Register a suite: run its cases, or collect them as skips.
 *
 * Typed as the call signature rather than as `typeof describe`, because `describe.skip`
 * carries none of `describe`'s helpers and the suites only ever call it as a function.
 */
export type SuiteRegistrar = (title: string, body: () => void) => void;

/** What a suite must name so a failure points at that suite and not at this module. */
export interface ProbeSuiteOptions {
  /** Short suite name; prefixes the Stack so its rows are cleaned up under its own label. */
  readonly label: string;
  /** Where a failure says what needed a database: the CALLING suite's own path. */
  readonly databaseContext: string;
  /** The title the runner prints while the database is usable. */
  readonly title: string;
}

/** One suite's probe Stack, its no-database decision and its teardown. */
export interface ProbeSuite {
  /** This suite's Stack; reaching it without one throws, and says why. */
  readonly probeStack: () => ProbeStack;
  /** "" when the database is usable; otherwise the reason the skip reports. */
  readonly skipReason: string;
  /** The title to register, annotated when the opt-out turned the suite into skips. */
  readonly suiteTitle: string;
  /** `describe` while the database is usable, `describe.skip` otherwise. */
  readonly runSuite: SuiteRegistrar;
  /**
   * Undo everything the suite created: restore the saved environment, drop the mocked
   * modules, delete the temp root, then tear the probe Stack down.
   *
   * @param projectRoot - The suite's temp root, removed recursively.
   * @param savedEnv - The environment snapshot the suite took before it mutated anything.
   */
  teardown(projectRoot: string, savedEnv: NodeJS.ProcessEnv): Promise<void>;
}

/** A probe Stack, or the message explaining why there is none. */
type ProbeOutcome =
  | { readonly stack: ProbeStack }
  | { readonly failure: string };

/**
 * Provision a suite's probe Stack, keeping a provisioning failure as EVIDENCE.
 *
 * Letting the harness's error escape would report a randomly suffixed Stack label instead
 * of the suite, and would leave the suite with no statement of its own about the database
 * it needs.
 *
 * @param label - Short suite name the Stack is named after.
 * @returns The Stack, or the message that explains why there is none.
 */
async function provisionProbe(label: string): Promise<ProbeOutcome> {
  try {
    return { stack: await createProbeStack(label) };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The informative part of a caught "no database" failure, without its advice block.
 *
 * The harness message already ends in the shared "supply a database" advice, which
 * `missingTestDatabase` prints again in full; quoting it whole as the observed detail would
 * print that block twice, and a failure that repeats itself reads as two problems.
 *
 * @param message - The caught message.
 * @returns What was observed, up to the first advice line.
 */
function observedFrom(message: string): string {
  const kept: string[] = [];
  for (const line of message.split("\n")) {
    if (ADVICE_MARKERS.some((marker) => line.startsWith(marker))) break;
    kept.push(line);
  }
  const observed = kept.join("\n").trim();
  return observed === "" ? message : observed;
}

/**
 * What a suite does when it has no usable database: FAIL loudly, or -- only with the
 * documented opt-out -- skip EXPLICITLY and say why.
 *
 * The decision and its wording belong to `missingTestDatabase`, so no suite can invent a
 * softer rule than the rest of the repository. This function decides only whether the
 * database is usable: a Stack the harness could not provision is as unusable as a server
 * that did not answer.
 *
 * @param context - What needed the database, phrased for the person reading the failure.
 * @param outcome - The probe Stack, or why provisioning failed.
 * @returns "" when the database is usable; otherwise the reason the skip reports.
 * @throws the shared actionable failure when `LLMWIKI_TEST_ALLOW_NO_DATABASE` is not `1`.
 */
function databaseSkipReason(context: string, outcome: ProbeOutcome): string {
  if ("stack" in outcome && outcome.stack.harness.reachable) return "";
  const observed = "failure" in outcome
    ? observedFrom(outcome.failure)
    : `the kg harness reported reachable = false for stack ${outcome.stack.harness.stackId}`
      + " — the warning printed above says whether the server was unreachable or the Stack"
      + " could not be provisioned";
  const missing = missingTestDatabase(context, observed);
  if (missing.error !== undefined) throw missing.error;
  console.warn(`${context}: every case in this file is skipped.`);
  console.warn(missing.message);
  return missing.message;
}

/**
 * The provisioned Stack, unwrapped.
 *
 * The cases only exist when the database does, so a run that somehow reached one without a
 * Stack is a defect that must be loud instead of asserting against `undefined`.
 *
 * @param context - The calling suite's own path, for the message.
 * @param outcome - The probe Stack, or why provisioning failed.
 * @returns The Stack.
 * @throws Error naming the suite and its provisioning failure.
 */
function probeStackOf(context: string, outcome: ProbeOutcome): ProbeStack {
  if (!("stack" in outcome)) throw new Error(`${context}: ${outcome.failure}`);
  return outcome.stack;
}

/**
 * Provision a suite's Stack, decide what a missing database means, and build its teardown.
 *
 * Called at the CALLING suite's module top level (top-level `await`), because the probe must
 * run before any case is collected: with the opt-out the suite has to be registered as
 * skips, not registered and then failed.
 *
 * @param options - The suite's label, its own path, and its title.
 * @returns The suite's Stack accessor, its skip decision, its registrar and its teardown.
 * @throws the shared actionable failure when no database can be obtained and the run did
 *   not opt out.
 */
export async function createProbeSuite(options: ProbeSuiteOptions): Promise<ProbeSuite> {
  const outcome = await provisionProbe(options.label);
  const skipReason = databaseSkipReason(options.databaseContext, outcome);
  return {
    probeStack: () => probeStackOf(options.databaseContext, outcome),
    skipReason,
    suiteTitle: skipReason === ""
      ? options.title
      : `${options.title}${SKIPPED_SUFFIX}`,
    runSuite: skipReason === "" ? describe : describe.skip,
    teardown: async (projectRoot, savedEnv) => {
      process.env = savedEnv;
      vi.restoreAllMocks();
      await rm(projectRoot, { recursive: true, force: true });
      await probeStackOf(options.databaseContext, outcome).harness.cleanup();
    },
  };
}
