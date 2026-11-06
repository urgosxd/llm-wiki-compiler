/**
 * @file packages/llmwiki-kg/ts/src/core/eval/main.test.ts
 * @description The two runners, and the guarantee that only one of them can reach
 * the network.
 *
 * The load-bearing assertion of this file is the negative one: `npm test` must be
 * unable to spend a credential or open a socket, so a configured `TYPESAFE_API_KEY`
 * on a developer machine changes nothing unless `--real` is also passed, and
 * `--real` without the key stops before any client is built. `fetch` is stubbed to
 * throw so that a regression which quietly reaches the network fails here instead of
 * on somebody's invoice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEvalCli } from "./main.js";

/** What one invocation observed: the exit code and both streams. */
interface Ran {
  readonly code: number;
  readonly outText: string;
  readonly errText: string;
}

/**
 * Runs the CLI with an injected environment and captured streams.
 *
 * @param argv - Arguments, without the node and script paths.
 * @param env - The environment the CLI reads.
 * @returns The exit code and what was written.
 */
async function run(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEvalCli(argv, {
    env,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  });
  return { code, outText: out.join(""), errText: err.join("") };
}

/**
 * Splits the combined stdout into its readable part and its JSON document.
 *
 * @param stdout - Everything the command wrote to standard output.
 * @returns The readable text and the parsed report.
 */
function splitReport(stdout: string): { text: string; json: Record<string, unknown> } {
  const [text = "", raw = ""] = stdout.split("--- json ---");
  return { text, json: JSON.parse(raw) as Record<string, unknown> };
}

describe("runEvalCli", () => {
  let fetchCalls = 0;

  beforeEach(() => {
    fetchCalls = 0;
    vi.stubGlobal("fetch", () => {
      fetchCalls += 1;
      throw new Error("network access is forbidden in the automated suite");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses the real evaluation without the key, naming what is missing", async () => {
    const result = await run(["--real"], {});
    expect(result.code).toBe(1);
    expect(result.outText).toBe("");
    expect(result.errText).toContain("TYPESAFE_API_KEY");
    expect(result.errText).toContain("--real");
    expect(fetchCalls).toBe(0);
  });

  it("runs offline when the key is present but --real was not passed", async () => {
    const result = await run([], { TYPESAFE_API_KEY: "sk-should-not-be-used" });
    expect(result.code).toBe(0);
    expect(splitReport(result.outText).json["run"]).toEqual({ mode: "offline", model: "jev-recorded", baseUrl: null });
    expect(fetchCalls).toBe(0);
  });

  it("prints readable text plus JSON labelled by axis, and no blended score", async () => {
    const result = await run([], {});
    expect(result.code).toBe(0);
    const { text, json } = splitReport(result.outText);
    expect(text).toContain("[classifier]");
    expect(text).toContain("[support]");
    expect(text).toContain("[information-loss]");
    expect(text).toContain("[extractor-coverage]");
    expect(Object.keys(json).sort()).toEqual(
      ["catalogVersion", "classification", "extractorCoverage", "informationLoss", "run", "setVersion", "support"].sort(),
    );
    expect(json["score"]).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  it("describes both runners in its help text", async () => {
    const result = await run(["--help"], {});
    expect(result.code).toBe(0);
    expect(result.outText).toContain("--real");
    expect(result.outText).toContain("--json");
    expect(result.outText).toContain("TYPESAFE_API_KEY");
  });

  it("rejects an unknown flag instead of silently ignoring it", async () => {
    const result = await run(["--nope"], {});
    expect(result.code).toBe(2);
    expect(result.errText).toContain("--nope");
  });
});
