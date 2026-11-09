/**
 * @file test/compiler/curated-links.test.ts
 * @description The four survivability cases the durable curated-link record exists for
 * (S8, S9, S12): the link outlives a re-ingest of its own page, a re-ingest of the TARGET
 * duplicates nothing, a lost anchor drops the link VISIBLY, and the same sources twice are
 * byte-identical.
 *
 * THE ANCHOR IS AN ALIAS IN EVERY CASE. The resolver re-wraps plain mentions of page
 * TITLES on every render, so a title-anchored link would survive regeneration with no
 * record at all and would prove nothing. `pgvector store` is an alias whose canonical key
 * differs from `Vector DB` by hand, so only the overlay can put the link back.
 *
 * WHY THE STORE IS READ AS A FILE. `.llmwiki/curated-links.json` is the record's public
 * artifact (it is documented beside the other durable state files in `constants.ts`), and
 * a case that asked the store module to read what it had just written could not tell a
 * missing record from a mis-read one.
 *
 * Driven through `compileAndReport`, the public compile entry point, with the provider
 * stubbed: no network, no key, and a throwaway project under the OS temp dir.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "fs/promises";
import path from "path";
import { compileAndReport } from "../../packages/wiki/src/compiler/index.js";
import { useCompileProject } from "../fixtures/compile-project.js";
import { readConceptPage } from "../fixtures/concept-page.js";
import {
  ALPHA_BODY,
  ALPHA_BODY_TITLE_MENTION,
  ALPHA_BODY_WITHOUT_TARGET,
  ALPHA_SOURCE,
  DECLARED_ALIAS,
  curateLinkToBeta,
  curatedStorePath,
  ingestBoth,
  readCuratedStore,
  reingestAlpha,
  reingestBeta,
} from "../fixtures/curated-scenario.js";
import { changedPaths, fingerprintTree } from "../fixtures/tree-fingerprint.js";
import { captureProcessIo } from "../fixtures/process-io.js";

describe("durable curated links", () => {
  const ctx = useCompileProject({ dirSuffix: "curated-links", sourceFile: ALPHA_SOURCE });

  it("X1 the link survives a re-ingest of the page that carries it", async () => {
    await ingestBoth(ctx.dir);
    await curateLinkToBeta(ctx.dir);

    // The curation itself: one anchored alias link, and one durable record beside it.
    expect(await readConceptPage(ctx.dir, "alpha-topic"))
      .toContain(`[[vector-db|${DECLARED_ALIAS}]]`);
    const store = await readFile(curatedStorePath(ctx.dir), "utf-8");
    expect(store).toContain('"sourcePageId": "concepts/alpha-topic"');
    expect(store).toContain('"targetPageId": "concepts/vector-db"');
    expect(store).toContain('"provenance": "model-verdict"');

    // Re-ingest ALPHA alone: the target is not reviewed here, so the only thing that can
    // put an alias-anchored link back into a freshly generated body is the record.
    await reingestAlpha(ctx.dir);
    const regenerated = await readConceptPage(ctx.dir, "alpha-topic");
    expect(regenerated).toContain(`[[vector-db|${DECLARED_ALIAS}]]`);
    expect([...regenerated.matchAll(/\[\[vector-db/g)]).toHaveLength(1);
    expect(await readFile(curatedStorePath(ctx.dir), "utf-8")).toBe(store);
  });

  it("X2 re-ingesting the target duplicates no record and churns no body", async () => {
    await ingestBoth(ctx.dir);
    await curateLinkToBeta(ctx.dir);
    const page = await readConceptPage(ctx.dir, "alpha-topic");
    const store = await readFile(curatedStorePath(ctx.dir), "utf-8");
    const before = await fingerprintTree(path.join(ctx.dir, "wiki"));

    // The target is revised twice, which is exactly the ingest that used to append a
    // second curated link: the mention is already a link, so it is not even a candidate.
    await reingestBeta(ctx.dir);
    await reingestBeta(ctx.dir);

    expect(await readConceptPage(ctx.dir, "alpha-topic")).toBe(page);
    expect(await readFile(curatedStorePath(ctx.dir), "utf-8")).toBe(store);
    const changed = changedPaths(before, await fingerprintTree(path.join(ctx.dir, "wiki")));
    expect(changed.filter((file) => file.includes("alpha-topic"))).toEqual([]);
  });

  it("X3 a lost anchor drops the link and records why", async () => {
    let renders = 0;
    const alphaBody = (): string => (renders++ === 0 ? ALPHA_BODY : ALPHA_BODY_WITHOUT_TARGET);
    await ingestBoth(ctx.dir, alphaBody);
    await curateLinkToBeta(ctx.dir, undefined, alphaBody);
    const io = captureProcessIo();
    await reingestAlpha(ctx.dir);

    // S8 wins over survivability: no mention, no link.
    const page = await readConceptPage(ctx.dir, "alpha-topic");
    expect(page).not.toContain("[[vector-db");
    expect(page).toContain("Alpha Topic stores vectors only.");
    // ...and the loss is REPORTED, per record and in the run total, with its reason.
    expect(io.out()).toContain("Curated link dropped on concepts/alpha-topic: concepts/vector-db");
    expect(io.out()).toContain("anchor-missing");
    expect(io.out()).toContain("Curated links: 0 link(s) restored, 1 dropped (1 anchor-missing).");
    // The drop is durable: the store no longer promises a link the prose cannot hold.
    expect(await readFile(curatedStorePath(ctx.dir), "utf-8")).toContain('"links": []');
  });

  it("X5 records nothing for a MECHANICALLY derived link", async () => {
    // Alpha names the target by its TITLE and the review is given an answer it cannot
    // read, so the resolver's inbound pass is the ONLY channel that can create this
    // link. It is derived from the text on every render, so it needs no record -- and a
    // record for it would be the overlay claiming work it did not do.
    const titleOnly = (): string => ALPHA_BODY_TITLE_MENTION;
    await ingestBoth(ctx.dir, titleOnly);
    await curateLinkToBeta(ctx.dir, () => "", titleOnly);

    expect(await readConceptPage(ctx.dir, "alpha-topic")).toContain("[[vector-db|Vector DB]]");
    expect(await readCuratedStore(ctx.dir)).toBeNull();

    // The re-render loses the link for a moment and the resolver puts it back, still
    // with no record anywhere: the mechanical channel is what owns it.
    await reingestAlpha(ctx.dir);
    expect(await readConceptPage(ctx.dir, "alpha-topic")).toContain("[[vector-db|Vector DB]]");
    expect(await readCuratedStore(ctx.dir)).toBeNull();
  });

  it("X4 the same sources twice leave every page and every record identical", async () => {
    await ingestBoth(ctx.dir);
    await curateLinkToBeta(ctx.dir);
    await reingestAlpha(ctx.dir);

    const pages = await fingerprintTree(path.join(ctx.dir, "wiki"));
    const store = await readFile(curatedStorePath(ctx.dir), "utf-8");
    expect(store).toContain("concepts/vector-db");

    // Nothing changed in `sources/`, so this run has nothing to compile at all.
    await compileAndReport(ctx.dir);

    expect(changedPaths(pages, await fingerprintTree(path.join(ctx.dir, "wiki")))).toEqual([]);
    expect(await readFile(curatedStorePath(ctx.dir), "utf-8")).toBe(store);
    // The store's order is a function of its SET, never of arrival order.
    expect(store.indexOf("concepts/alpha-topic")).toBeLessThan(store.indexOf("concepts/vector-db"));
  });
});
