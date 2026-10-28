/**
 * @file test/dimensions/source-projection.test.ts
 * @description The one write an ingest cannot put inside a Postgres transaction:
 * `sources/<slug>.md`. This suite measures its SELF-COMPENSATION.
 *
 * ## Why this file had to exist
 *
 * `odd/tasks/ingest-atomicity.md` lists compensation as a delivered behaviour:
 *
 *   "The wiki dimension compensates it: it captures the file's pre-state through
 *    `saveSource`'s existing `beforeWrite` hook, and on failure restores what was
 *    there -- deleting a file this attempt created, restoring previous bytes for one
 *    it updated."
 *
 * Measured at audit time: NO file under `test/` imported `projectSourceMarkdown`.
 * Task 8 claimed "compensation" was covered; it was not. The branches below are
 * exactly the ones that sentence promises.
 *
 * ## How the failure is injected without faking the thing under test
 *
 * The failure must land INSIDE `saveSource`, after it has resolved the destination
 * and fired `beforeWrite` -- otherwise the compensation has nothing to undo and the
 * case proves nothing. Two cheaper setups were tried and both were vacuous:
 *
 *   - a stray DIRECTORY on the target path: `resolveCollisionFreeFilename` appends a
 *     hash suffix, chooses a different filename, and never reaches the failure;
 *   - `vi.spyOn` on `saveSource`: it replaces the function the projection calls, so
 *     the compensation ran against a stub and nothing was ever written or restored.
 *
 * So exactly ONE export is replaced -- `writeFile` -- and only while a flag is armed,
 * and only for calls whose target is the file under test. The real `saveSource` runs:
 * real `mkdir`, real identity scan, real `beforeWrite`, real pre-state capture. The
 * flag disarms itself on the first injected failure, so the COMPENSATION's own write
 * goes through the genuine implementation -- which is the whole point of arming one
 * call instead of stubbing `saveSource`.
 *
 * ## The failure must ALTER the file, or the suite proves nothing
 *
 * First version of this mock threw BEFORE writing. All five cases went green, and a
 * mutation that emptied `restorePreWrite` left them green too -- because an
 * untouched file is indistinguishable from a restored one. The compensation only has
 * work to do when the failed write left the destination changed.
 *
 * So the injected failure now performs the REAL write and THEN throws. That is not a
 * contrivance: `writeFile` opens with truncate-then-write, so a failure mid-write
 * (ENOSPC, EIO) leaves a truncated or replaced file behind -- the exact state the
 * compensation exists to repair.
 *
 * A module-level `vi.mock` is used rather than `vi.spyOn` because `node:fs/promises`
 * exports are non-configurable: attempting to spy on `writeFile` throws
 * `Cannot spy on export "writeFile"`, which would have turned all cases into
 * failures that say nothing about compensation.
 *
 * ## The `source` frontmatter field is not decoration
 *
 * `findFileBySourceIdentity` keys on the `source:` field in the frontmatter. A
 * document without it is invisible to the identity scan, so a re-ingest allocates a
 * NEW filename instead of updating the existing one, and the "restore" branch is never
 * reachable. Every document below therefore carries it, the way a real ingest does.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Whether the next write to the marked path should fail.
 *
 * Hoisted because `vi.mock` is lifted above the imports, so it cannot close over a
 * plain module-level `let`.
 */
const writeFailure = vi.hoisted(() => ({ armed: false }));

// The SPECIFIER MATTERS. `source-writer.ts` imports from `"fs/promises"` (no `node:`
// prefix), and mocking only `"node:fs/promises"` intercepts nothing -- the injected
// failure never fired and all three cases failed with "resolved instead of
// rejecting". Both specifiers are mocked, each delegating to its own original, so the
// suite is not sensitive to which spelling a module happens to use.
//
// Two `vi.mock` calls are required because the factories cannot be looped: `vi.mock`
// is hoisted above every import and cannot close over a loop variable
// (`specifier is not defined`). Both delegate to ONE shared body below, so the
// injected-failure logic exists once -- fallow flagged two inline copies as a clone
// group, and a clone is where one copy silently stops failing.

/**
 * The injected failure: perform the real write, then throw.
 *
 * Writing first is what makes the destination DIFFER from its pre-state, so the
 * compensation has something to actually repair. See the file header.
 */
async function partialThenFail(
  write: (...args: unknown[]) => Promise<void>,
  args: unknown[],
): Promise<void> {
  await write(...args);
  throw new Error("injected write failure");
}

/**
 * The mocked module body, shared by both specifiers.
 *
 * @param importOriginal - Vitest's original-module loader for the given specifier.
 * @returns The module with an armable `writeFile`.
 */
async function fsPromisesMock(
  importOriginal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const actual = await importOriginal();
  const write = actual.writeFile as (...args: unknown[]) => Promise<void>;
  return {
    ...actual,
    writeFile: async (target: unknown, ...rest: unknown[]) => {
      if (writeFailure.armed && String(target).includes(FAILING_FILE_MARKER)) {
        writeFailure.armed = false;
        return partialThenFail(write, [target, ...rest]);
      }
      return write(target, ...rest);
    },
  };
}

vi.mock("fs/promises", (importOriginal) => fsPromisesMock(importOriginal));
vi.mock("node:fs/promises", (importOriginal) => fsPromisesMock(importOriginal));

import { projectSourceMarkdown } from "../../src/dimensions/wiki/source-projection.js";
import { saveSource } from "../../src/utils/source-writer.js";

/**
 * Slug suffix identifying the file the injected failure targets.
 *
 * MUST MATCH the title the fixtures use. The filename is `slugify(title)`, so a
 * marker of `replaced.md` never matched `Replaced Note` (which becomes
 * `replaced-note.md`): the mock was installed and intercepting, the failure simply
 * never fired, and every case reported "resolved instead of rejecting". A constant
 * rather than an inline string keeps the mock and the fixtures from drifting apart
 * again.
 */
const FAILING_FILE_MARKER = "replaced-note";

/** Documents carry `source:`, because the identity scan keys on it. */
function documentOf(title: string, source: string, body: string): string {
  return `---\ntitle: ${title}\nsource: ${source}\n---\n\n${body}\n`;
}

/** A project root with a real `sources/` directory, as an ingest would find it. */
async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "source-projection-"));
  await mkdir(path.join(root, "sources"), { recursive: true });
  return root;
}

/**
 * Run `body` with exactly one injected write failure armed.
 *
 * The flag is cleared on entry AND on exit, so a case that stops failing cannot leave
 * a later case armed -- an ordering leak is exactly how a suite starts passing for a
 * reason other than the one its name states.
 */
async function withFailingWrite<T>(body: () => Promise<T>): Promise<T> {
  writeFailure.armed = true;
  try {
    return await body();
  } finally {
    writeFailure.armed = false;
  }
}

describe("the source projection's happy path", () => {
  it("reports where the markdown landed and that it was created", async () => {
    const root = await projectRoot();

    const result = await projectSourceMarkdown(root, {
      title: "First Note",
      document: documentOf("First Note", "src://first", "# First\n\nbody"),
      source: "src://first",
    });

    expect(result.writeStatus).toBe("created");
    expect(result.artifactPath.endsWith(".md")).toBe(true);
    // The bytes on disk are the document it was given -- the projection does not
    // synthesize frontmatter of its own.
    expect(await readFile(result.artifactPath, "utf-8")).toContain("First Note");
  });

  it("reports unchanged without rewriting an already current file", async () => {
    const root = await projectRoot();
    const document = documentOf("Steady Note", "src://steady", "# Steady\n\nbody");

    await projectSourceMarkdown(root, { title: "Steady Note", document, source: "src://steady" });
    const again = await projectSourceMarkdown(root, {
      title: "Steady Note",
      document,
      source: "src://steady",
    });

    // `saveSource` compares stable content and skips the write, so this path never
    // fires `beforeWrite` and the projection has no pre-state to capture.
    expect(again.writeStatus).toBe("unchanged");
  });
});

describe("compensation when the projection fails", () => {
  it("restores the previous bytes when the attempt overwrote an existing file", async () => {
    const root = await projectRoot();
    const source = "src://replaced";
    const previousDocument = documentOf("Replaced Note", source, "# Replaced\n\nold body");
    const nextDocument = documentOf("Replaced Note", source, "# Replaced\n\nnew body");

    const seeded = await saveSource(root, "Replaced Note", previousDocument, source);
    expect(seeded.writeStatus).toBe("created");

    await expect(
      withFailingWrite(() =>
        projectSourceMarkdown(root, { title: "Replaced Note", document: nextDocument, source }),
      ),
    ).rejects.toThrow("injected write failure");

    // THE COMPENSATION. The attempt captured the previous bytes through `beforeWrite`
    // and put them back. Without it the file would be empty or absent, and a failed
    // re-ingest would have destroyed a source that was working before the attempt.
    expect(await readFile(seeded.path, "utf-8")).toBe(previousDocument);
  });

  it("lets the original error through rather than a cleanup error", async () => {
    const root = await projectRoot();
    const source = "src://replaced-error";
    await saveSource(root, "Replaced Note", documentOf("Replaced Note", source, "old"), source);

    // The operator needs the CAUSE. A compensation that failed to write back must not
    // replace "your write failed" with "cleanup failed".
    await expect(
      withFailingWrite(() =>
        projectSourceMarkdown(root, {
          title: "Replaced Note",
          document: documentOf("Replaced Note", source, "new"),
          source,
        }),
      ),
    ).rejects.toThrow("injected write failure");
  });

  it("does not delete a pre-existing file when the creating attempt failed", async () => {
    const root = await projectRoot();
    const source = "src://replaced";
    // The file under the failing slug ALREADY EXISTS, owned by a DIFFERENT source, so
    // this attempt takes the CREATE branch under a collision-suffixed name. The
    // pre-existing file is the witness: if the compensation ever unlinked the wrong
    // destination, or defaulted to "delete" without checking the pre-state, it would
    // take this file with it.
    const bystander = await saveSource(
      root,
      "Replaced Note",
      documentOf("Replaced Note", "src://someone-else", "do not touch me"),
      "src://someone-else",
    );
    const bystanderBytes = await readFile(bystander.path, "utf-8");

    await expect(
      withFailingWrite(() =>
        projectSourceMarkdown(root, {
          title: "Replaced Note",
          document: documentOf("Replaced Note", source, "body"),
          source,
        }),
      ),
    ).rejects.toThrow("injected write failure");

    // The bystander survives byte-for-byte, and nothing new was left behind under the
    // suffixed name this attempt would have created.
    expect(await readFile(bystander.path, "utf-8")).toBe(bystanderBytes);
    const remaining = await readdir(path.join(root, "sources"));
    expect(remaining).toHaveLength(1);
  });
});
