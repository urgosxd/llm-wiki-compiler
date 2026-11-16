/**
 * Shared on-disk project setup for reconciliation regression tests.
 * These tests exercise ownership and retry state, not embedding providers or
 * progress output. Keep those two side effects stubbed consistently while each
 * suite controls its own extraction and page-generation responses.
 *
 * FILE MODE, DECLARED HERE BECAUSE THIS HARNESS OWNS IT: it builds a throwaway project on disk
 * (`sources/`, `wiki/`, `.llmwiki/`) and nothing it produces can be read from rows, so a suite on
 * this harness has no database by construction. Importing the file-mode fixture registers that for
 * whoever imports this module; the suites themselves therefore add nothing. See
 * `test/fixtures/file-mode.ts`.
 */
import "./file-mode.js";
import { beforeEach, vi, type MockInstance } from "vitest";
import { AnthropicProvider } from "../../packages/wiki/src/providers/anthropic.js";
import * as embeddings from "../../packages/wiki/src/utils/embeddings.js";
import { useCompileProject, type CompileProjectCtx, type CompileProjectOptions } from "./compile-project.js";

/** Register the standard project lifecycle and isolate unrelated side effects. */
export function useReconciliationProject(options: CompileProjectOptions): CompileProjectCtx {
  const ctx = useCompileProject(options);
  beforeEach(() => {
    vi.spyOn(embeddings, "updateEmbeddingsLockedCore").mockResolvedValue({ embedded: [], eligible: [], pruned: [] });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  return ctx;
}

/** Let each regression control extraction and generation independently. */
export function mockReconciliationProvider(): {
  toolCall: MockInstance<typeof AnthropicProvider.prototype.toolCall>;
  complete: MockInstance<typeof AnthropicProvider.prototype.complete>;
} {
  return {
    toolCall: vi.spyOn(AnthropicProvider.prototype, "toolCall"),
    complete: vi.spyOn(AnthropicProvider.prototype, "complete"),
  };
}
