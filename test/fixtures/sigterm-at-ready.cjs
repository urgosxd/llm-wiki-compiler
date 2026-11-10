/**
 * @file test/fixtures/sigterm-at-ready.cjs
 * @description Raises SIGTERM against the child ITSELF, synchronously, at the
 * instant the child writes its readiness line — a deterministic RED for the
 * launcher's SIGTERM stop contract.
 *
 * ## Why the signal is raised from inside the child, not from the test
 *
 * The container's stop path is: `docker stop` sends SIGTERM, and the launcher must
 * answer exit 0. A parent-side "kill as soon as the readiness line appears" cannot
 * prove that contract: the line travels through a pipe, so a loaded machine can
 * deliver it milliseconds after the child wrote it, and by then the handler may be
 * armed for reasons that have nothing to do with the fix. Measured, that shape
 * reproduced a bare ~83% of the time, which is the timing dependence AGENTS.md
 * forbids: a test that is sometimes green is not evidence.
 *
 * This hook removes the timing entirely. It wraps `process.stdout.write`, performs
 * the real write, and only then — in the same synchronous turn, before the write
 * call returns to its caller — sends SIGTERM to its own pid. The signal therefore
 * lands at a fixed, code-determined point in the child's execution: right after the
 * readiness bytes are queued, and before the statement that follows the write.
 *
 * - With the handler armed AFTER the announcement, no JS signal listener exists at
 *   that point, so the kernel applies the default disposition and the child dies by
 *   signal: `code === null`, `signal === "SIGTERM"`. RED, no timing involved.
 * - With the handler armed BEFORE the announcement, libuv's signal handler is
 *   already installed, the graceful path runs, and the child exits 0. GREEN.
 *
 * Loaded with `node --require` (or `NODE_OPTIONS=--require …`); it installs nothing
 * else and changes no other behaviour.
 */

"use strict";

/** The line `host` mode writes once its listener has bound. */
const READY_MARKER = "Host ready at";

/** Text of a write chunk, whichever of the two accepted types it is. */
function chunkText(chunk) {
  return typeof chunk === "string" ? chunk : String(chunk);
}

const realWrite = process.stdout.write.bind(process.stdout);

process.stdout.write = function writeThenSignal(chunk, ...rest) {
  const written = realWrite(chunk, ...rest);
  if (chunkText(chunk).includes(READY_MARKER)) {
    process.kill(process.pid, "SIGTERM");
  }
  return written;
};
