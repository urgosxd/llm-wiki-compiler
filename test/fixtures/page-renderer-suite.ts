/**
 * @file Shared setup for the two compiler suites that render merged page content.
 *
 * Both suites declared the same schema stub, the same managed temp roots and the
 * same per-test mock restore, which the duplication gate reported. The stub and
 * the hooks are setup, so they live here; `vi.mock` does NOT, because vitest
 * hoists it per file and moving it would change which module each suite mocks.
 */

import { afterEach, vi } from "vitest";
import type { renderMergedPageContent } from "../../packages/wiki/src/compiler/page-renderer.js";
import { useManagedTempRoots } from "./temp-root.js";

/** Minimal SchemaConfig stub matching the shape page-renderer needs. */
export const STUB_SCHEMA = { defaultKind: "concept" } as Parameters<typeof renderMergedPageContent>[2];

/**
 * Register the calling suite's temp roots and its per-test mock restore.
 * @returns The managed temp-root handle, typed as the composable returns it.
 */
export function usePageRendererSuite(): ReturnType<typeof useManagedTempRoots> {
  const suite = useManagedTempRoots();
  afterEach(() => {
    vi.restoreAllMocks();
  });
  return suite;
}
