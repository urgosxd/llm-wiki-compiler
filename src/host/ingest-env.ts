/**
 * @file src/host/ingest-env.ts
 * @description Resolve the environment one ingest request should run under.
 *
 * ## Why this is a module instead of two local helpers
 *
 * The same three lines were written twice — once in `host/api.ts` for the synchronous
 * route and once in `services/ingest/jobs/run.ts` for the background job — because the
 * request and the job live on opposite sides of an HTTP response. Two copies is fine;
 * two copies that could drift on WHICH environment variable they set is not, since a
 * drift would silently send one route's pages to the wrong tenant.
 *
 * ## Why it returns a copy rather than mutating
 *
 * The Stack used to be applied by assigning into `process.env` and restoring it after.
 * That holds only while no two writers overlap, so the isolation depended on locks
 * rather than on this code. A copy makes the isolation intrinsic: the value is handed
 * to the pipelines that read it, and the ambient environment is never written. Two
 * requests naming different Stacks can therefore be in flight at once.
 *
 * When no Stack is named the process environment is returned as-is, so a single-Stack
 * deployment keeps the exact behaviour it had.
 */
import { AKS_STACK_ID_ENV_VAR } from "../dimensions/activation.js";

/**
 * The environment an ingest should resolve its Stack from.
 *
 * @param stackId - A Stack the caller named, or absent to use the bound one.
 * @returns A copy carrying that Stack, or the process environment untouched.
 */
export function buildIngestEnv(stackId: string | undefined): NodeJS.ProcessEnv {
  if (stackId === undefined) return process.env;
  return { ...process.env, [AKS_STACK_ID_ENV_VAR]: stackId };
}
