/**
 * Egress tests for page-embedding collection.
 *
 * `collectPageRecords` reads concept/query pages whose text is later sent to the
 * embedding provider. A symlinked page escaping the project tree must be DROPPED
 * before it is read, so its bytes are never collected and therefore never embedded.
 * A normal page and a legit in-dir symlinked page must still be collected.
 *
 * ## Why these assert on the collected records, not on a batch call
 *
 * They used to call `embedPages` and check the provider was never invoked with the
 * escaped page's text. `embedPages` had no production caller -- it was exercised
 * only from here -- and it was removed, so the assertion moved to the boundary that
 * actually matters: the page must not appear in `collectPageRecords` at all. If it
 * is absent there, no downstream stage can embed it, which is a stronger statement
 * than "this particular embed call did not include it".
 */

import { describe, it, expect, vi } from "vitest";
import { writeFile, symlink, realpath } from "fs/promises";
import path from "path";
import { makeTempRoot } from "./fixtures/temp-root.js";
import { makeOutsideDir } from "./fixtures/outside-dir.js";
import { writePage } from "./fixtures/write-page.js";
import { collectPageRecords } from "../src/utils/embeddings-pages.js";

describe("collectPageRecords egress confinement", () => {
  it("does NOT read or embed an out-of-tree symlinked concept/query page", async () => {
    const root = await makeTempRoot("egress-escape");
    const outside = await makeOutsideDir();
    await writeFile(path.join(outside, "leak.md"), "---\ntitle: Secret\n---\nleaked");
    await symlink(path.join(outside, "leak.md"), path.join(root, "wiki/concepts/leak.md"));
    await symlink(path.join(outside, "leak.md"), path.join(root, "wiki/queries/leak.md"));

    const records = await collectPageRecords(root);

    // Absent from the collected set is the strongest form of "never embedded": a
    // page that was never read cannot reach any provider, by any later stage.
    expect(records.find((r) => r.title === "Secret")).toBeUndefined();
    expect(records.map((r) => r.slug)).not.toContain("leak");
    expect(JSON.stringify(records)).not.toContain("Secret");
  });

  it("embeds a normal page as before", async () => {
    const root = await makeTempRoot("egress-normal");
    await writePage(path.join(root, "wiki/concepts"), "alpha", { title: "Alpha", summary: "sa" }, "Body.");
    const records = await collectPageRecords(root);

    // The normal page is still collected, with the text an embedder would receive.
    expect(records.map((r) => r.slug)).toEqual(["alpha"]);
    expect(JSON.stringify(records)).toContain("Alpha");
    expect(JSON.stringify(records)).toContain("sa");
  });

  it("embeds a legit IN-DIR symlinked page (resolves inside the dir)", async () => {
    const root = await makeTempRoot("egress-alias");
    const dir = path.join(root, "wiki/concepts");
    await writePage(dir, "original", { title: "Orig", summary: "so" }, "Body.");
    await symlink(path.join(dir, "original.md"), path.join(dir, "alias.md"));
    await realpath(path.join(dir, "alias.md")); // sanity: link is resolvable

    const records = await collectPageRecords(root);
    // Both alias and original are collected: an in-dir symlink stays inside the
    // tree, so confinement permits it.
    expect(records.map((r) => r.slug).sort()).toEqual(["alias", "original"]);
  });
});
