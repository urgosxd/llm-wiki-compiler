/**
 * @file test/bridge-project-id-boundary.test.ts
 * @description In-process replacement for the two `projectId` SECURITY-boundary
 * cases in `test/bridge-export-contract-cli.test.ts` (`:88` traversal, `:104`
 * oversize; spec S5, group 5).
 *
 * ## Why this boundary is worth its own file
 *
 * `projectId` is not a display label. It participates in the deterministic
 * external ids (`llmwiki/<projectId>/<pageDirectory>/<slug>`) that downstream
 * importers and the Atomic Memory namespace scope are built on, so two projects
 * supplying the same id collide and silently overwrite each other through any
 * upsert primitive. `export/project-id.ts` says so in its own header, and the
 * regex + length cap there is the whole guard on the export side.
 *
 * ## What the CLI cases asserted, and what survives
 *
 * They asserted three things at once: a non-zero exit, an `Invalid projectId`
 * message, and that `dist/exports/wiki.json` was not written. The first two are
 * process properties; the third is not — it is a property of the EXPORT PIPELINE,
 * which survives. `runExport` validates the id as its FIRST statement, before it
 * collects a single page, so a refused id can neither write an envelope nor
 * mutate the project. That ordering is what this file pins.
 *
 * Both surviving surfaces are exercised: `runExport` (the writer the MCP server
 * and the CLI share) and `exportJson` (what `createWiki().exportJson` exposes to
 * embedders, reached at `sdk/core.ts`, so the SDK cannot bypass the boundary).
 *
 * ## Not ported
 *
 * The exit code and the stderr rendering of the message are process facts and
 * die with the entry (S5 ENTRY-ONLY). `utils/path-confine.ts` is NOT part of this
 * boundary and is not touched: `projectId` never becomes a filesystem path — the
 * regex is what forbids traversal, which is why it is asserted byte-for-byte.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exportJson, runExport } from "../packages/wiki/src/commands/export.js";
import { validateProjectId } from "../packages/wiki/src/export/project-id.js";
import { EXPORT_DIR } from "../packages/wiki/src/utils/constants.js";
import { writePage } from "./fixtures/write-page.js";

/** A value that escapes the namespace root; kept obvious so a failure reads as itself. */
const TRAVERSAL_ID = "../escape";

/** One character past the 63-character DNS-label cap the on-wire format allows. */
const OVERSIZE_ID = "a".repeat(64);

/** Absolute root of the current test's project; seeded with one page. */
let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-project-id-"));
  await mkdir(path.join(projectRoot, "wiki/concepts"), { recursive: true });
  await writePage(
    path.join(projectRoot, "wiki/concepts"),
    "retrieval",
    { title: "Retrieval", summary: "x", kind: "concept" },
    "Retrieval is selective lookup.\n",
  );
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

/** Whether a path exists, without asserting anything about why it might not. */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** The wiki page this file seeds, as stored, so "unchanged" is provable. */
function seededPagePath(): string {
  return path.join(projectRoot, "wiki/concepts/retrieval.md");
}

describe("projectId — the export pipeline refuses an escaping id before it writes", () => {
  it("rejects a traversal id and writes no export file", async () => {
    await expect(runExport(projectRoot, { target: "json", projectId: TRAVERSAL_ID })).rejects.toThrow(
      /Invalid projectId/,
    );
    expect(await exists(path.join(projectRoot, EXPORT_DIR, "wiki.json"))).toBe(false);
    expect(await exists(path.join(projectRoot, EXPORT_DIR))).toBe(false);
  });

  it("rejects the traversal id through the SDK's exportJson surface too", async () => {
    await expect(exportJson(projectRoot, { projectId: TRAVERSAL_ID })).rejects.toThrow(
      /Invalid projectId/,
    );
    expect(await exists(path.join(projectRoot, EXPORT_DIR))).toBe(false);
  });

  it("leaves the seeded wiki page byte-identical after both refusals", async () => {
    const before = await readFile(seededPagePath(), "utf-8");
    await expect(runExport(projectRoot, { target: "json", projectId: TRAVERSAL_ID })).rejects.toThrow();
    await expect(exportJson(projectRoot, { projectId: TRAVERSAL_ID })).rejects.toThrow();
    expect(await readFile(seededPagePath(), "utf-8")).toBe(before);
  });
});

describe("projectId — the size cap is enforced at both surviving surfaces", () => {
  it("rejects a 64-character id naming the cap in the message", async () => {
    await expect(runExport(projectRoot, { target: "json", projectId: OVERSIZE_ID })).rejects.toThrow(
      /Invalid projectId/,
    );
    expect(await exists(path.join(projectRoot, EXPORT_DIR, "wiki.json"))).toBe(false);
    expect(() => validateProjectId(OVERSIZE_ID)).toThrow(/max 63 characters/);
  });

  it("rejects the same oversize id through exportJson and writes nothing", async () => {
    await expect(exportJson(projectRoot, { projectId: OVERSIZE_ID })).rejects.toThrow(
      /Invalid projectId/,
    );
    expect(await exists(path.join(projectRoot, EXPORT_DIR))).toBe(false);
  });

  it("accepts the 63-character boundary the cap allows", () => {
    expect(validateProjectId("a".repeat(63))).toBe("a".repeat(63));
  });
});

describe("projectId — an accepted id still reaches the envelope (preservation)", () => {
  it("embeds a valid id in the written wiki.json", async () => {
    const result = await runExport(projectRoot, { target: "json", projectId: "my-kb" });
    expect(result.written).toHaveLength(1);
    const written = JSON.parse(
      await readFile(path.join(projectRoot, EXPORT_DIR, "wiki.json"), "utf-8"),
    ) as { projectId?: string; pages: { path: string }[] };
    expect(written.projectId).toBe("my-kb");
    expect(written.pages[0]?.path).toBe("wiki/concepts/retrieval.md");
  });
});
