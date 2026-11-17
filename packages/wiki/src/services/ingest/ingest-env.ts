/**
 * @file src/services/ingest/ingest-env.ts
 * @description Resolve the environment one ingest request should run under.
 *
 * ## Why this is a module instead of two local helpers
 *
 * The same three lines were written twice — once in the host's `/api/ingest` route
 * (`packages/api`'s `host/api.ts` today) and once in `services/ingest/jobs/run.ts` for
 * the background job — because the request and the job live on opposite sides of an
 * HTTP response. Two copies is fine; two copies that could drift on WHICH environment
 * variable they set is not, since a drift would silently send one route's pages to the
 * wrong tenant.
 *
 * ## Why it lives in `@repo/wiki` and not beside the host that calls it
 *
 * Both sides need it and neither may import the other: `wiki → api` is forbidden, so a
 * copy under `packages/api` would force the wiki-side job runner to import the joining
 * package. It is reached as `@repo/wiki/ingest-env`, which is an `api → wiki` edge —
 * the permitted direction.
 *
 * ## Why it returns a copy rather than mutating
 *
 * The Stack used to be applied by assigning into `process.env` and restoring it after.
 * That holds only while no two writers overlap, so the isolation depended on locks
 * rather than on this code. A copy makes the isolation intrinsic: the value is handed
 * to the pipelines that read it, and the ambient environment is never written. Two
 * requests naming different Stacks can therefore be in flight at once.
 *
 * ## Where `undefined` is still legitimate, and where it is not
 *
 * An absent Stack used to mean "whatever the process environment says", and on the HTTP surface
 * that was silent authority: a `POST /api/ingest` with no `stackId` ran under whichever Stack
 * the server had been started with, so a client wrote into a tenant it never named. The request
 * path no longer reaches this function without a Stack — `host/api.ts` refuses an unnamed
 * request by name (`stack_unnamed`, 409) before any work starts — which makes the `undefined`
 * branch unreachable FROM A REQUEST rather than dead:
 *
 *  - A CLI RUN (the command line's own ingest, and the SDK facade) legitimately reads its OWN
 *    configured Stack from the environment. `AKS_STACK_ID` there is the operator's explicit
 *    choice for that command, not ambient authority borrowed by a third party's request, and
 *    S3 forbids the second, not the first.
 *
 * So the branch stays, and the distinction lives in its caller: a request must name its Stack;
 * a command may read its own configuration.
 */
import { AKS_STACK_ID_ENV_VAR } from "../../dimensions/activation.js";

/**
 * The environment an ingest should resolve its Stack from.
 *
 * The `undefined` branch is the CLI-shaped one described in this file's header: a command
 * reading its own configured Stack. Every HTTP route refuses an unnamed request before calling
 * this, so on that path the argument is always present.
 *
 * @param stackId - A Stack the caller named, or absent for a run that reads its own environment.
 * @returns A copy carrying that Stack, or the process environment untouched.
 */
export function buildIngestEnv(stackId: string | undefined): NodeJS.ProcessEnv {
  if (stackId === undefined) return process.env;
  return { ...process.env, [AKS_STACK_ID_ENV_VAR]: stackId };
}
