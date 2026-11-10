// test/okf-sdk.test.ts
/**
 * The SDK OKF surface: `exportOkf` writes a bundle, `importOkf` is trusted-only, and
 * a `dryRun` preview writes nothing.
 *
 * An untrusted `importOkf` used to stage its documents as review candidates. Staging is
 * retired because no surface promotes a candidate into the wiki, so the untrusted call
 * REFUSES through the same public facade the docs teach.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createWiki } from "../packages/wiki/src/index.js";
import { listCandidates } from "../packages/wiki/src/compiler/candidates.js";

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** Write a foreign OKF bundle with one valid concept doc under `<root>/kb`. */
async function writeBundle(root: string): Promise<string> {
  const bundle = path.join(root, "kb");
  await mkdir(path.join(bundle, "concepts"), { recursive: true });
  await writeFile(path.join(bundle, "concepts", "a.md"), "---\ntype: concept\ntitle: A\n---\n\nBody.\n");
  return bundle;
}

describe("SDK OKF methods", () => {
  it("exportOkf writes a bundle", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sdk-okf-"));
    await mkdir(path.join(dir, "wiki/concepts"), { recursive: true });
    await writeFile(path.join(dir, "wiki/concepts/rag.md"), "---\ntitle: RAG\nkind: concept\n---\n\nBody.\n");
    const wiki = createWiki({ root: dir });
    const exp = await wiki.exportOkf({ out: path.join(dir, "out") });
    expect((await stat(path.join(exp.outDir, "index.md"))).isFile()).toBe(true);
  });

  it("importOkf refuses an untrusted import instead of staging", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sdk-okf-default-"));
    const wiki = createWiki({ root: dir });
    const bundle = await writeBundle(dir);

    await expect(wiki.importOkf(bundle)).rejects.toThrow(/no longer exists/);
    expect(await listCandidates(dir)).toHaveLength(0);
  });

  it("dryRun previews without staging, and importOkf writes live when trusted", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "sdk-okf-trusted-"));
    const wiki = createWiki({ root: dir });
    const bundle = await writeBundle(dir);

    const preview = await wiki.importOkf(bundle, { dryRun: true });
    expect(preview.mode).toBe("dry-run");
    expect(await listCandidates(dir)).toHaveLength(0);

    const written = await wiki.importOkf(bundle, { trusted: true });
    expect(written.mode).toBe("written");
    expect((await stat(path.join(dir, "wiki/concepts/a.md"))).isFile()).toBe(true);
    expect(await listCandidates(dir)).toHaveLength(0);
  });
});
