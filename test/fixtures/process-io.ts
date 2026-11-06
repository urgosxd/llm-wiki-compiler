/**
 * @file Shared stdout/stderr capture for tests that assert what a command or a
 * compile stage PRINTED.
 *
 * WHY IT IS SHARED. `fallow` reported the same `vi.spyOn(process.stdout, "write")`
 * / `vi.spyOn(process.stderr, "write")` pair copied into
 * `test/commands/links-here-cli.test.ts`, `test/commands/race-cli.test.ts` and
 * `test/context/ghost-rule.test.ts`. A test that asserts printed text needs the
 * exact same three details every time (collect into an array, stringify the
 * chunk, return `true` so the write is not re-entered), and a copy of them is a
 * place for the harness to drift out of sync with the others. One helper means
 * one definition of "what did this run print".
 *
 * BOTH WRITER CONVENTIONS, because the repository has both: a command prints by
 * calling `process.stdout.write` directly (`src/commands/links-here.ts`), while
 * the compile path prints through `output.status`, which uses `console.log`.
 * Capturing only the streams would miss every `output.*` line, and capturing
 * only the console would miss every command line, so this helper spies on the
 * streams AND on `console.log`/`console.warn`. In this harness the intercepted
 * console does not forward to the stream, so a line is counted once.
 *
 * The spies are installed with `vi.spyOn`, so the caller's existing
 * `vi.restoreAllMocks()` in `afterEach` removes them; this module deliberately
 * installs no hooks of its own.
 */

import { vi } from "vitest";

/** Everything one run wrote, split by stream. */
export interface CapturedProcessIo {
  /** Accrued stdout, e.g. the icon lines `output.status` prints. */
  out: () => string;
  /** Accrued stderr, e.g. the lines `output.note` prints. */
  err: () => string;
}

/**
 * Capture process stdout and stderr from the moment of the call.
 *
 * `output.status`/`output.header` write through `console.log` and
 * `output.note` through `console.warn`; both land on the process streams, so
 * spying on the streams catches project output without depending on the console
 * implementation.
 *
 * @returns Accessors for the text captured so far, by stream.
 */
export function captureProcessIo(): CapturedProcessIo {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(collect(out));
  vi.spyOn(process.stderr, "write").mockImplementation(collect(err));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(`${args.map(String).join(" ")}\n`);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    err.push(`${args.map(String).join(" ")}\n`);
  });
  return { out: () => out.join(""), err: () => err.join("") };
}

/**
 * A `write` implementation that records the chunk into `sink`.
 *
 * Returning `true` keeps the caller's write-success expectation: a spied stream
 * that reported backpressure would make the printing code believe the write is
 * still pending.
 *
 * @param sink - Text collected for this stream.
 * @returns The stream's `write` stand-in.
 */
function collect(sink: string[]): (chunk: unknown) => boolean {
  return (chunk: unknown) => {
    sink.push(String(chunk));
    return true;
  };
}
