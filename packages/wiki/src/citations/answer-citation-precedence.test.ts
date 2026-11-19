/**
 * Precedence pins for `findPageInDirectory` (S7, S10) and the raw-target erasure
 * that makes one ambiguity permanent (S7).
 */
import { describe, expect, it } from "vitest";
import { resolveBareSlug } from "../viewer/collect.js";
import { recognizedWikilinkTargets } from "../wiki/wikilink-tokens.js";

type Index = Parameters<typeof resolveBareSlug>[1];
const page = (dir: "concepts" | "queries", slug: string, aliases?: string[]): Index[number] =>
  ({ id: `${dir}/${slug}`, pageDirectory: dir, slug, aliases });

describe("bare-slug precedence is unchanged and order-independent", () => {
  it.each([
    ["alias only", "polyglot", [page("concepts", "multilingual", ["Polyglot"])], "concepts/multilingual"],
    ["exact beats a sibling's alias", "polyglot",
      [page("concepts", "polyglot"), page("concepts", "other", ["Polyglot"])], "concepts/polyglot"],
    ["concepts beat queries on the same slug", "dupe",
      [page("concepts", "dupe"), page("queries", "dupe")], "concepts/dupe"],
    ["a title-shaped concept beats an exact query", "dupe",
      [page("concepts", "Dupe"), page("queries", "dupe")], "concepts/Dupe"],
    ["an exact query beats a concept alias", "dupe",
      [page("concepts", "other", ["Dupe"]), page("queries", "dupe")], "queries/dupe"],
  ] as const)("%s", (_label, target, pages, expected) => {
    expect(resolveBareSlug(target, pages)).toBe(expected);
    expect(resolveBareSlug(target, [...pages].reverse())).toBe(expected);
  });
});

describe("a qualified target is confined to its own namespace", () => {
  it("never falls through to the other namespace", () => {
    const pages: Index = [page("concepts", "dupe"), page("queries", "Dupe Two")];
    expect(resolveBareSlug("concepts/dupe", pages)).toBe("concepts/dupe");
    expect(resolveBareSlug("queries/nope", pages)).toBeNull();
    expect(resolveBareSlug("entities/dupe", pages)).toBeNull();
    expect(resolveBareSlug("", pages)).toBeNull();
  });
});

describe("the raw wikilink target does not survive into resolution", () => {
  it("normalizes a title-shaped citation to the same bare slug", () => {
    // Why the ambiguity is permanent rather than fixable in the resolver: by the
    // time `resolveBareSlug` runs, the two spellings are one string.
    expect(recognizedWikilinkTargets("[[7. Subdominios DDD]]")).toEqual(["7-subdominios-ddd"]);
    expect(recognizedWikilinkTargets("[[7-subdominios-ddd]]")).toEqual(["7-subdominios-ddd"]);
  });
});
