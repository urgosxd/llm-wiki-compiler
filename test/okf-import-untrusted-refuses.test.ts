// test/okf-import-untrusted-refuses.test.ts
/**
 * @file An untrusted OKF import refuses instead of staging.
 *
 * Staging a document as a review candidate is retired: no surface promotes a
 * candidate into the wiki, so a staged record could never become a page. An import
 * that names no `trusted: true` therefore REFUSES with a typed error and touches
 * nothing — neither `wiki/` nor `.llmwiki/candidates/`. The trusted live-write arm
 * is unchanged — `test/okf-run-import.test.ts` holds that PRESERVE pair, so it is not
 * restated here — and a `dryRun` preview still works because it writes nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOkfImport, UntrustedOkfImportError } from "../packages/wiki/src/import/run.js";
import { CANDIDATES_DIR } from "../packages/wiki/src/utils/constants.js";
import { writeOneDocBundle as bundle } from "./fixtures/okf-bundle-fixture.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Every entry under `dir`, or an empty list when it does not exist. */
async function entriesOf(target: string): Promise<string[]> {
  return readdir(target).catch(() => []);
}

describe("an untrusted OKF import refuses", () => {
  it("throws the typed refusal and stages nothing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-untrusted-"));
    const bundleDir = await bundle(dir);
    const candidatesDir = path.join(dir, CANDIDATES_DIR);

    const importing = runOkfImport(dir, bundleDir, {});
    await expect(importing).rejects.toBeInstanceOf(UntrustedOkfImportError);

    expect(await entriesOf(candidatesDir)).toEqual([]);
    expect(await entriesOf(path.join(dir, "wiki"))).toEqual([]);
  });

  it("names the surviving trusted option and the guide in the refusal", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-untrusted-msg-"));
    const bundleDir = await bundle(dir);

    await expect(runOkfImport(dir, bundleDir, {})).rejects.toThrow(
      "The untrusted OKF import no longer exists: staging documents as review candidates " +
      "is retired, because no surface promotes a candidate into the wiki. Import with " +
      "{ trusted: true } to write the bundle's pages live; see docs/guides/open-knowledge-format.mdx.",
    );
  });

  it("refuses before taking the mutation lock", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-untrusted-lock-"));
    const bundleDir = await bundle(dir);
    const lock = path.join(dir, ".llmwiki/lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "held");

    // A lock contention would surface LockUnavailableError; the refusal is a
    // property of the CALL, so it is reached without asking the lock at all.
    await expect(runOkfImport(dir, bundleDir, {})).rejects.toBeInstanceOf(UntrustedOkfImportError);
  });

  it("still previews under dryRun and writes nothing", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "okf-untrusted-preview-"));
    const bundleDir = await bundle(dir);

    const report = await runOkfImport(dir, bundleDir, { dryRun: true });

    expect(report.mode).toBe("dry-run");
    expect(report.pages).toEqual([{ slug: "a", okfPath: "concepts/a.md", targetDirectory: "concepts" }]);
    expect(await entriesOf(path.join(dir, CANDIDATES_DIR))).toEqual([]);
    expect(await entriesOf(path.join(dir, "wiki"))).toEqual([]);
  });

});
