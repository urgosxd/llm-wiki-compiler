/**
 * @file test/fixtures/host-scratch.ts
 * @description Shared scratch project + bound-host helpers for the host API tests.
 *
 * WHY THIS EXISTS. Two host test files were building the same temporary project and
 * the same fetcher, and the duplication was measured by the codebase health tool.
 * Beyond the duplication itself, the copy is the risk: a project layout change would
 * have to be made in two places, and the one that was missed would keep passing
 * against a layout the product no longer uses.
 */

import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A scratch project with the sources/ directory the mutation services expect. */
export async function scratchProjectRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}
