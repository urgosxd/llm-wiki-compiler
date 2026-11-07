/**
 * @file test/fixtures/compile-provider.ts
 * @description Stub the THREE provider calls a compile makes, in one place, so every
 * compile-path test that needs a model answers the same calls the same way.
 *
 * WHY A FIXTURE. A compile reaches the provider for extraction (a tool call), for page
 * rendering (a completion) and -- once the reference review is wired into the pipeline
 * -- for one link verdict per earlier-page candidate (another tool call on the same
 * prototype method). Each caller used to restate that dispatch, and the copies drifted.
 * The dispatch lives here once; a case supplies only its answers.
 *
 * ROUTE ON THE PROMPT, NOT ON A TITLE. The extraction prompt also carries the existing
 * wiki index, so it mentions every title compiled so far. An extractor that branches on
 * `system.includes("<title>")` therefore answers for whichever title happens to be in
 * the index, which is why the stub's caller routes on the SOURCE TEXT instead.
 */

import { vi } from "vitest";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

/** The answers one compile-path case gives the provider. */
export interface CompileProviderAnswers {
  /** Extraction tool-call answer, chosen from the system prompt. */
  extraction: (system: string) => string;
  /** Page-render completion, chosen from the system prompt. */
  body: (system: string) => string;
  /**
   * Reference-review answer, chosen from the review prompt's system text. Omitted means
   * the stage never reaches the model, which is itself worth asserting: a run with no
   * candidate mention must not pay for a call.
   */
  review?: (system: string) => string;
  /**
   * Category-assignment answer, chosen from the assignment prompt's system text.
   * Omitted means a run that proposes no categories, which is the shape a project
   * without categories has: the stage runs and writes nothing.
   */
  categories?: (system: string) => string;
}

/**
 * Install the stub on both provider methods a compile uses.
 *
 * @param answers - What each call should return.
 */
export function stubCompileProvider(answers: CompileProviderAnswers): void {
  vi.spyOn(AnthropicProvider.prototype, "toolCall").mockImplementation(
    async (system: string, _messages, tools) => {
      if (tools[0]?.name === "judge_reference") return answers.review?.(system) ?? "";
      if (tools[0]?.name === "assign_categories") return answers.categories?.(system) ?? "";
      return answers.extraction(system);
    },
  );
  vi.spyOn(AnthropicProvider.prototype, "complete").mockImplementation(
    async (system: string) => answers.body(system),
  );
}
