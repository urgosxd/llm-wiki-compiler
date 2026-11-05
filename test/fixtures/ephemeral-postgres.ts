/**
 * @file test/fixtures/ephemeral-postgres.ts
 * @description A throwaway Postgres container a test owns from start to finish.
 *
 * ## Why this exists next to `kg-postgres.ts`
 *
 * `kg-postgres.ts` binds a suite to the database a DEVELOPER is running (through
 * `test-database.ts` and its port). That is right for suites whose subject is the
 * schema, and wrong for a suite whose subject is "the whole service works": such a
 * probe must not inherit anything a human started, or it proves that person's
 * environment instead of the code.
 *
 * So this fixture starts its own server. The cost is one `docker run`, measured at
 * ~1.4 s to ready for a cached image, and the payoff is that a run cannot reach the
 * operator's data, cannot be moved by a parallel suite, and cannot look green
 * because something else was already listening.
 *
 * ## Why the host port comes from Docker
 *
 * `--publish 127.0.0.1::5432` asks Docker to pick a free host port, so two probes
 * running at once — or a probe beside a developer's own database on 5432/5434 —
 * cannot collide. A fixed port would turn a parallel run into a flaky failure, and
 * the port is read back from `docker port` rather than assumed.
 *
 * ## Why the image is not pulled
 *
 * A pull needs the network and can take a minute. The image is expected to be
 * present (it is the repository's own dev image); when it is missing, `docker run`
 * fails and the caller reports that as the reason it could not run.
 *
 * ## Why readiness is not decided here
 *
 * `container-server-primitives.ts` owns the probe and the poll loop, because
 * `testcontainers-postgres.ts` needs the same decision for the container a whole run
 * shares. Two copies of it had already drifted into a duplicate fallow refuses to pass,
 * and the cost of letting them diverge further is a fixture that accepts a server this
 * one rejects.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { waitUntilReady } from "./container-server-primitives.js";

const run = promisify(execFile);

/** The repository's Postgres image: the one that carries the `vector` extension. */
export const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/** Throwaway credential for a container that lives for one test run, on loopback. */
const THROWAWAY_PASSWORD = "probe-only";

/** How long a fresh container may take to accept connections. */
const READY_TIMEOUT_MS = 45_000;

/** How often readiness is re-tried while that budget lasts. */
const READY_POLL_MS = 100;

/** How many times `docker port` is re-read: the mapping appears just after `run`. */
const PORT_READ_ATTEMPTS = 20;

/** Per-probe connect timeout while the fresh container is still coming up. */
const PROBE_CONNECT_TIMEOUT_SECONDS = 2;

/** A running container, the URL that reaches it, and the way to stop it. */
export interface EphemeralPostgres {
  /** Container name, unique per run, so debris is identifiable. */
  readonly name: string;
  /** Connection string on loopback: `<host>:<docker-chosen port>`. */
  readonly url: string;
  /** Stop and remove the container. Best effort, safe to call twice. */
  stop(): Promise<void>;
}

/**
 * Is a Docker daemon reachable from this process?
 *
 * A boolean rather than a throw: a machine without Docker must be able to SKIP
 * this suite with a reason that names the missing capability, and a skipped suite
 * that says why is honest in a way a red suite is not.
 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
}

/** The host port Docker published for the container's 5432. */
async function mappedPort(name: string): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_READ_ATTEMPTS; attempt += 1) {
    try {
      const { stdout } = await run("docker", ["port", name, "5432/tcp"]);
      const match = /:(\d+)\s*$/m.exec(stdout.trim());
      if (match !== null) return Number(match[1]);
      lastError = new Error(`docker port printed no host port: ${JSON.stringify(stdout)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`could not read the published port of ${name}: ${String(lastError)}`);
}

/**
 * Start a private Postgres and hand back the URL that reaches it.
 *
 * @param label - Short label folded into the container name, for debuggability.
 * @returns The running container; `stop()` removes it.
 */
export async function startEphemeralPostgres(label: string): Promise<EphemeralPostgres> {
  const name = `llmwiki-probe-${label}-${randomBytes(4).toString("hex")}`;
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    // A free host port chosen by Docker itself: see the file header.
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${THROWAWAY_PASSWORD}`,
    // Labelled so debris is findable by `docker ps --filter label=…` even when the
    // process that started it was killed before it could tear anything down.
    "--label",
    "llmwiki-probe=1",
    POSTGRES_IMAGE,
  ]);
  const port = await mappedPort(name);
  const url = `postgresql://postgres:${THROWAWAY_PASSWORD}@127.0.0.1:${String(port)}/postgres`;
  await waitUntilReady(url, name, {
    timeoutMs: READY_TIMEOUT_MS,
    pollMs: READY_POLL_MS,
    connectTimeoutSeconds: PROBE_CONNECT_TIMEOUT_SECONDS,
  });
  return {
    name,
    url,
    stop: async () => {
      await run("docker", ["rm", "--force", name]).catch(() => undefined);
    },
  };
}
