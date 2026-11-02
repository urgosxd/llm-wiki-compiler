/**
 * @file test/viewer-profile-schema.test.ts
 * @description The declared-SCHEMA half of the `profilePipeline` block: each
 * entity type's `titleField` and declared fields, plus the profile's artifact
 * type declarations.
 *
 * These ride on `profilePipeline` rather than in a separate `profileSchema`
 * block because four of the six things a schema read model needs — `type`,
 * `directory`, the lifecycle, and the relation endpoints — already ship there.
 * Two blocks would put the lifecycle on the wire twice and give a future reader
 * two sources that can disagree about it.
 *
 * The field projection is BOUNDED: `default` can carry an arbitrary
 * author-supplied value that was never meant for a read surface, and `min`/`max`
 * are validation bounds nothing renders. That boundary is enforced by the type
 * system rather than by these tests alone — a facet added to `FieldDef` fails to
 * compile until it is explicitly projected or explicitly dropped — but the tests
 * below pin the resulting wire shape so a widening is visible in a diff.
 */

import { describe, expect, it } from "vitest";
import { buildPipelineDefinitions, buildPipelineEnvelope } from "../src/viewer/pipeline.js";
import type { ProfilePack } from "../src/profile/types.js";

/** A pack with one titled type carrying every projected field facet, plus artifacts. */
const PACK: ProfilePack = {
  schemaVersion: 1,
  profileId: "newsroom",
  entities: {
    articles: {
      directory: "wiki/articles",
      titleField: "headline",
      fields: {
        headline: { type: "string", required: true },
        wordCount: { type: "integer", min: 0, max: 5000 },
        stage: { type: "enum", enum: ["draft", "filed"], default: "draft" },
        homepage: { type: "string", format: "url" },
      },
    },
    desks: { directory: "wiki/desks" },
  },
};

/** The projected row for one entity type. */
function typeRow(type: string) {
  return buildPipelineDefinitions(PACK).entityTypes.find((row) => row.type === type)!;
}

describe("profilePipeline carries each type's declared schema", () => {
  it("carries the declared titleField", () => {
    expect(typeRow("articles").titleField).toBe("headline");
  });

  it("carries fields as an ordered array, in declaration order", () => {
    expect(typeRow("articles").fields?.map((field) => field.name)).toEqual([
      "headline",
      "wordCount",
      "stage",
      "homepage",
    ]);
  });

  it("carries type, required, enum and format verbatim", () => {
    const byName = Object.fromEntries(
      (typeRow("articles").fields ?? []).map((field) => [field.name, field]),
    );
    expect(byName.headline).toEqual({ name: "headline", type: "string", required: true });
    expect(byName.stage).toEqual({ name: "stage", type: "enum", enum: ["draft", "filed"] });
    expect(byName.homepage).toEqual({ name: "homepage", type: "string", format: "url" });
  });

  it("omits both keys for a type declaring neither", () => {
    expect(typeRow("desks")).not.toHaveProperty("titleField");
    expect(typeRow("desks")).not.toHaveProperty("fields");
  });
});

describe("the field projection is bounded", () => {
  // A `default` is author-supplied data that never had a read surface in mind,
  // and `min`/`max` are write-time bounds no renderer draws. Sending either
  // would widen the surface for nothing.
  it("drops a declared default", () => {
    const stage = typeRow("articles").fields?.find((field) => field.name === "stage");
    expect(stage).not.toHaveProperty("default");
  });

  it("drops numeric validation bounds", () => {
    const wordCount = typeRow("articles").fields?.find((field) => field.name === "wordCount");
    expect(wordCount).toEqual({ name: "wordCount", type: "integer" });
  });
});

describe("the envelope carries the schema through the count join", () => {
  /** The wire block for `PACK`, with a summary that reports no pages at all. */
  function envelope() {
    return buildPipelineEnvelope(buildPipelineDefinitions(PACK), {
      profileId: "newsroom",
      entityCounts: {},
    } as never);
  }

  it("carries each type's titleField and fields alongside its counts", () => {
    const row = envelope()?.entityTypes.find((entry) => entry.type === "articles");
    expect(row?.titleField).toBe("headline");
    expect(row?.fields?.map((field) => field.name)).toEqual([
      "headline",
      "wordCount",
      "stage",
      "homepage",
    ]);
    expect(row?.pageCount).toBe(0);
  });

});
