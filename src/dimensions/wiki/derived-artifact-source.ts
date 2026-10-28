/**
 * @file src/dimensions/wiki/derived-artifact-source.ts
 * @description The derived-artifact seam: rows for a Stack, files for a project.
 *
 * ## Why a seam rather than a writer change
 *
 * `generateIndex` and `generateMOC` end in a single `atomicWrite`. The only thing that
 * has to change is WHERE that write lands, so the seam exposes "store this rendered
 * artifact" and each renderer keeps its formatting untouched.
 *
 * ## Why `undefined` rather than a throw
 *
 * A project with no Stack keeps writing its files byte for byte. Handing `undefined`
 * to the caller is what keeps `generateIndex`/`generateMOC` callable from both
 * backends without either one learning about the other.
 */

import { createDimensionsDatabase, AKS_STACK_ID_ENV_VAR } from "../activation.js";
import {
  readDerivedArtifact,
  saveDerivedArtifact,
  type DerivedArtifactKind,
} from "./derived-artifact-store.js";

/** The Stack this run is bound to, or undefined when the environment names none. */
function artifactStackId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const stackId = (env[AKS_STACK_ID_ENV_VAR] ?? "").trim();
  return stackId === "" ? undefined : stackId;
}

/** Store and read one Stack's rendered artifacts. */
export interface DerivedArtifactSource {
  /** Store a rendered artifact, replacing any prior render. */
  save(kind: DerivedArtifactKind, content: string): Promise<void>;
  /** Read a rendered artifact, or undefined when it was never generated. */
  read(kind: DerivedArtifactKind): Promise<string | undefined>;
}

/**
 * Run `fn` with this Stack's derived artifacts, or with `undefined` when none.
 *
 * @param env - Environment naming the Stack.
 * @param fn - Receives the artifact handle, or undefined for a file-backed project.
 * @returns Whatever `fn` returns.
 */
export async function withDerivedSource<T>(
  env: NodeJS.ProcessEnv,
  fn: (source: DerivedArtifactSource | undefined) => Promise<T>,
): Promise<T> {
  const stackId = artifactStackId(env);
  if (stackId === undefined) return fn(undefined);
  const handle = createDimensionsDatabase(env);
  try {
    return await fn({
      save: (kind, content) => saveDerivedArtifact(handle.db, stackId, kind, content),
      read: (kind) => readDerivedArtifact(handle.db, stackId, kind),
    });
  } finally {
    await handle.close();
  }
}

export type { DerivedArtifactKind };
