/**
 * @file packages/llmwiki-kg/ts/src/core/jev/config.test.ts
 * @description The one place JEV configuration is parsed, and how it fails.
 *
 * WHY THIS FILE EXISTS. Every classification state downstream depends on these
 * numbers, so a typo in an override must be loud: silently falling back to a
 * default would shift an entire corpus's abstention rate with nothing in the log
 * to explain it. The misordered-band case is the subtler one — it leaves the
 * uncertainty band empty, which reads as "the classifier never abstains".
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_THRESHOLDS,
  JevConfigError,
  parseJevConfig,
} from "./config.js";

describe("parseJevConfig — defaults", () => {
  it("uses the documented endpoint and model when nothing is configured", () => {
    const config = parseJevConfig({});
    expect(config.baseUrl).toBe(DEFAULT_JEV_BASE_URL);
    expect(config.model).toBe(DEFAULT_JEV_MODEL);
    expect(config.baseUrl).toBe("https://api.typesafe.ai");
    expect(config.model).toBe("jev-latest");
    expect(config.thresholds).toEqual(DEFAULT_JEV_THRESHOLDS);
  });

  it("publishes documented default bands that must be tuned against evaluations", () => {
    expect(DEFAULT_JEV_THRESHOLDS).toEqual({
      classificationNoMatchBelow: 0.35,
      classificationUncertainBelow: 0.65,
      classificationMinTopProbability: 0.45,
      supportUncertainBelow: 0.6,
    });
  });
});

describe("parseJevConfig — overrides", () => {
  it("reads the endpoint, the model, the timeout and every threshold from the environment", () => {
    const config = parseJevConfig({
      LLMWIKI_JEV_BASE_URL: "https://jev.internal",
      LLMWIKI_JEV_MODEL: "jev-2026-09",
      LLMWIKI_JEV_TIMEOUT_MS: "2500",
      LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW: "0.2",
      LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW: "0.7",
      LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY: "0.5",
      LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW: "0.8",
    });
    expect(config.baseUrl).toBe("https://jev.internal");
    expect(config.model).toBe("jev-2026-09");
    expect(config.timeoutMs).toBe(2_500);
    expect(config.thresholds).toEqual({
      classificationNoMatchBelow: 0.2,
      classificationUncertainBelow: 0.7,
      classificationMinTopProbability: 0.5,
      supportUncertainBelow: 0.8,
    });
  });
});

describe("parseJevConfig — refusals", () => {
  it("refuses a threshold that is not a number and names the variable", () => {
    expect(() => parseJevConfig({ LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW: "high" })).toThrow(JevConfigError);
    expect(() => parseJevConfig({ LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW: "high" })).toThrow(
      /LLMWIKI_JEV_SUPPORT_UNCERTAIN_BELOW/,
    );
  });

  it("refuses a threshold outside (0, 1)", () => {
    expect(() => parseJevConfig({ LLMWIKI_JEV_CLASSIFICATION_MIN_TOP_PROBABILITY: "1.4" })).toThrow(JevConfigError);
  });

  it("refuses a no-match band that is not below the uncertain band", () => {
    expect(() =>
      parseJevConfig({
        LLMWIKI_JEV_CLASSIFICATION_NO_MATCH_BELOW: "0.7",
        LLMWIKI_JEV_CLASSIFICATION_UNCERTAIN_BELOW: "0.7",
      }),
    ).toThrow(/no-match band/);
  });
});
