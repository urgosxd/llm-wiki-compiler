/**
 * @file test/fixtures/child-report.ts
 * @description Read the first JSON report line a spawned child process prints.
 *
 * Two suites in this directory spawn a real process that provisions a database of its
 * own, prints one JSON line describing it, and then keeps running:
 * `per-run-database.test.ts` reaps a live sibling from another process, and
 * `per-run-database-signal.test.ts` observes what a signal does to a process whose
 * database is the thing being protected. Both need exactly the same thing from the
 * child — its first complete JSON line on stdout, or a failure carrying whatever the
 * child said on stderr before it exited — so that reader lives here once.
 *
 * `stdout` arrives in chunks, so a line is only handed back once a newline terminated
 * it; a chunk that ends mid-line stays buffered.
 */
import type { ChildProcess } from "node:child_process";

/**
 * Resolve with the first JSON value the child prints on stdout.
 *
 * Rejects when the child exits before printing one, and `label` names the caller's
 * role in that message (`sibling`, `child`) so each suite keeps its own diagnosis.
 *
 * An unparseable first line rejects too, rather than throwing inside the `data`
 * handler: a malformed report is a failed spawn, not a crashed test file.
 */
export function firstJsonReport<T>(child: ChildProcess, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const line = buffered.split("\n").find((entry) => entry.trim() !== "");
      if (line === undefined) return;
      try {
        resolve(JSON.parse(line) as T);
      } catch (error) {
        reject(error as Error);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("exit", (code) => {
      reject(new Error(`${label} exited before reporting (status ${String(code)}): ${stderr}`));
    });
  });
}
