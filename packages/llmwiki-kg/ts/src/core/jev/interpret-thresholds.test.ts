/**
 * @file packages/llmwiki-kg/ts/src/core/jev/interpret-thresholds.test.ts
 * @description Where the four confidence bands begin, and that each one begins at
 * the number its own environment variable asks for.
 *
 * WHY THIS FILE EXISTS. All four band comparisons are strict `<`, so equality
 * belongs to the upper arm, and the day one of them degrades to `<=` every band
 * shifts by exactly one input value — which moves every abstention boundary of a
 * corpus with nothing red. No existing test asserts an equality case. The second
 * silent failure is wiring: a threshold that is parsed from the environment and
 * then read by a comparison belonging to a sibling band keeps every parsing test
 * green while the operator's band never moves.
 *
 * Every case drives an exported verdict function with thresholds handed in
 * explicitly — `DEFAULT_JEV_THRESHOLDS` for the boundaries, `parseJevConfig` for
 * the overrides — and asserts the arm's own declaration (its reason, or the
 * canonical type it resolved), because a status alone cannot tell the two
 * `free_uncertain` arms apart.
 */

import { describe, expect, it } from "vitest";

import { defaultTypeCatalog } from "../catalog/default_catalog.js";
import { DEFAULT_JEV_THRESHOLDS, parseJevConfig } from "./config.js";
import type { JevThresholds } from "./config.js";
import {
  CLASSIFICATION_REASON_NO_MATCH,
  CLASSIFICATION_REASON_UNCERTAIN_FIT,
  CLASSIFICATION_REASON_UNCERTAIN_TOP,
  SUPPORT_REASON_UNCERTAIN,
  interpretClassification,
  interpretSupport,
} from "./interpret.js";
import { ENTITY_CLASSIFICATION_QUESTIONS, SUPPORT_CHOICE_LABELS, SUPPORT_QUESTION_ID } from "./questions.js";
import type { ClassificationVerdict, JevDecisionOutcome, SupportVerdict } from "./types.js";

/** The shipped defaults, the reference every boundary position is relative to. */
const {
  classificationNoMatchBelow: NO_MATCH_BELOW,
  classificationUncertainBelow: UNCERTAIN_BELOW,
  classificationMinTopProbability: MIN_TOP,
  supportUncertainBelow: SUPPORT_BELOW,
} = DEFAULT_JEV_THRESHOLDS;

/**
 * The grid the boundary positions sit on: one hundredth of a probability, the
 * finest difference between a reported probability and a configured band.
 */
const STEP = 0.01;

/**
 * A probability one or more grid steps away from a band, rounded to two decimals
 * because `0.35 - 0.01` in binary floating point is `0.33999999999999997`.
 *
 * @param band - The threshold the position is measured from.
 * @param steps - How many grid steps to move, negative for below the band.
 * @returns The grid value, comparable to a configured threshold.
 */
function stepFrom(band: number, steps: number): number {
  return Math.round((band + steps * STEP) * 100) / 100;
}

/**
 * A probability high enough that the band under test cannot be shadowed.
 *
 * The two `fits`-gated bands sit at or below 0.65 and the two `top`-gated ones at
 * or below 0.6, so one value clears all four and no case succeeds by reaching an
 * earlier arm by accident.
 */
const CLEARS_EVERY_BAND = 0.9;

/** The catalog type the probes resolve to, so a `classified` arm is checkable. */
const DECLARED_ENTITY_TYPE = "Role";

/** The losing option in the probe distribution; it exists only to fill the map. */
const SHADOWED_ENTITY_TYPE = "Process";

/** The two numbers the bands actually compare. */
interface Probe {
  readonly fitsProbability: number;
  readonly topProbability: number;
}

/**
 * Drives `interpretClassification` with one probe and the thresholds in force.
 *
 * @param probe - The two probabilities the bands read.
 * @param thresholds - The bands to interpret against.
 * @returns The verdict, exactly as the pipeline would receive it.
 */
function classify(probe: Probe, thresholds: JevThresholds): ClassificationVerdict {
  const outcome: JevDecisionOutcome = {
    status: "answered",
    response: {
      model: "jev-test",
      answers: {
        [ENTITY_CLASSIFICATION_QUESTIONS.choice]: {
          type: "choice",
          choice: DECLARED_ENTITY_TYPE,
          probabilities: {
            [DECLARED_ENTITY_TYPE]: probe.topProbability,
            [SHADOWED_ENTITY_TYPE]: 1 - probe.topProbability,
          },
          confidence: 0.5,
        },
        [ENTITY_CLASSIFICATION_QUESTIONS.fits]: { type: "noul", noul: probe.fitsProbability },
      },
    },
  };
  return interpretClassification(outcome, {
    catalog: defaultTypeCatalog(),
    thresholds,
    questions: ENTITY_CLASSIFICATION_QUESTIONS,
  });
}

/**
 * Drives `interpretSupport`, the sibling export that owns the support band.
 *
 * @param topProbability - P(the top support answer).
 * @param thresholds - The bands in force.
 * @returns The support verdict, exactly as the pipeline would receive it.
 */
function judgeSupport(topProbability: number, thresholds: JevThresholds): SupportVerdict {
  const outcome: JevDecisionOutcome = {
    status: "answered",
    response: {
      model: "jev-test",
      answers: {
        [SUPPORT_QUESTION_ID]: {
          type: "choice",
          choice: SUPPORT_CHOICE_LABELS.supported,
          probabilities: {
            [SUPPORT_CHOICE_LABELS.supported]: topProbability,
            [SUPPORT_CHOICE_LABELS.unsupported]: 1 - topProbability,
          },
          confidence: 0.5,
        },
      },
    },
  };
  return interpretSupport(outcome, thresholds);
}

/** What a verdict must declare, matched as a subset of the returned verdict. */
type Declared = Readonly<Record<string, unknown>>;

/** Which of the four bands a case exercises. */
type BandName = "no-match" | "uncertain-fit" | "min-top" | "support";

/** One band: where it starts, what moves it, and what each side of it declares. */
interface Band {
  /** The shipped default the band starts at. */
  readonly threshold: number;
  /** The environment variable an operator uses to move it. */
  readonly variable: string;
  /** A value distinguishable from the default, used to prove the override is wired. */
  readonly override: number;
  /** Runs the exported verdict function that owns this band's comparison. */
  readonly judgeAt: (thresholds: JevThresholds, value: number) => object;
  /** What the band declares for a value below it. */
  readonly below: Declared;
  /** What it declares AT it: equality belongs to the upper arm of every band. */
  readonly at: Declared;
}

/** The four bands, in the order the interpreter evaluates them. */
const BAND_NAMES: readonly BandName[] = ["no-match", "uncertain-fit", "min-top", "support"];

/** One `fits`-gated band, whose comparison input is P(some catalog type fits). */
function fitsBand(threshold: number, variable: string, below: Declared, at: Declared): Band {
  return {
    threshold,
    variable,
    override: stepFrom(threshold, 5),
    judgeAt: (thresholds, value) => classify({ fitsProbability: value, topProbability: CLEARS_EVERY_BAND }, thresholds),
    below,
    at,
  };
}

/** One `top`-gated band, whose comparison input is P(the argmax option). */
function topBand(threshold: number, variable: string, below: Declared, at: Declared): Band {
  return {
    threshold,
    variable,
    override: stepFrom(threshold, 5),
    judgeAt: (thresholds, value) =>
      classify({ fitsProbability: CLEARS_EVERY_BAND, topProbability: value }, thresholds),
    below,
    at,
  };
}

const CLASSIFIED: Declared = { status: "classified", canonicalType: DECLARED_ENTITY_TYPE };
const UNCERTAIN_FIT: Declared = { status: "free_uncertain", reason: CLASSIFICATION_REASON_UNCERTAIN_FIT };

const BANDS: Readonly<Record<BandName, Band>> = {
  "no-match": fitsBand(NO_MATCH_BELOW, "LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW", { status: "free_no_match", reason: CLASSIFICATION_REASON_NO_MATCH }, UNCERTAIN_FIT),
  "uncertain-fit": fitsBand(UNCERTAIN_BELOW, "LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW", UNCERTAIN_FIT, CLASSIFIED),
  "min-top": topBand(MIN_TOP, "LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY", { status: "free_uncertain", reason: CLASSIFICATION_REASON_UNCERTAIN_TOP }, CLASSIFIED),
  support: {
    threshold: SUPPORT_BELOW,
    variable: "LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW",
    override: stepFrom(SUPPORT_BELOW, 5),
    judgeAt: (thresholds, value) => judgeSupport(value, thresholds),
    below: { status: "uncertain", reason: SUPPORT_REASON_UNCERTAIN },
    at: { status: "supported" },
  },
};

/** One grid position relative to one band, and what it must declare. */
interface BoundaryPosition {
  readonly name: string;
  readonly band: BandName;
  readonly value: number;
  readonly expected: Declared;
}

/** The three positions every band is pinned at, measured in grid steps from its default. */
const POSITION_STEPS: readonly { readonly steps: number; readonly named: string; readonly upperArm: boolean }[] = [
  { steps: -1, named: "one step below", upperArm: false },
  { steps: 0, named: "exactly at", upperArm: true },
  { steps: 1, named: "one step above", upperArm: true },
];

const BOUNDARY_POSITIONS: readonly BoundaryPosition[] = BAND_NAMES.flatMap((bandName) => {
  const band = BANDS[bandName];
  return POSITION_STEPS.map((position) => ({
    name: `${bandName} ${position.named} ${String(band.threshold)}: ${String(stepFrom(band.threshold, position.steps))}`,
    band: bandName,
    value: stepFrom(band.threshold, position.steps),
    expected: position.upperArm ? band.at : band.below,
  }));
});

/** The four documented variables at their defaults, so one override stands alone. */
function defaultThresholdEnv(): Record<string, string> {
  return {
    LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW: String(NO_MATCH_BELOW),
    LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW: String(UNCERTAIN_BELOW),
    LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY: String(MIN_TOP),
    LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW: String(SUPPORT_BELOW),
  };
}

describe("the four confidence bands — every boundary, from both sides", () => {
  it.each(BOUNDARY_POSITIONS)("$name", ({ band, value, expected }) => {
    expect(BANDS[band].judgeAt(DEFAULT_JEV_THRESHOLDS, value)).toMatchObject(expected);
  });
});

describe("the environment overrides reach the band they name and no other", () => {
  it.each(BAND_NAMES)("%s override moves its own band and leaves the other three alone", (bandName) => {
    const band = BANDS[bandName];
    const { thresholds } = parseJevConfig({ ...defaultThresholdEnv(), [band.variable]: String(band.override) });
    const insideTheMovedBand = stepFrom(band.override, -1);
    // The grid value lands in the other arm under the shipped defaults, so only the
    // override can explain where it landed: a variable parsed but never wired fails here.
    expect(band.judgeAt(thresholds, insideTheMovedBand)).toMatchObject(band.below);
    expect(band.judgeAt(DEFAULT_JEV_THRESHOLDS, insideTheMovedBand)).toMatchObject(band.at);
    for (const otherName of BAND_NAMES.filter((name) => name !== bandName)) {
      const other = BANDS[otherName];
      expect(other.judgeAt(thresholds, stepFrom(other.threshold, -1)), otherName).toMatchObject(other.below);
      expect(other.judgeAt(thresholds, other.threshold), otherName).toMatchObject(other.at);
    }
  });
});
