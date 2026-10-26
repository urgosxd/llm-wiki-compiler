/**
 * @file test/dimensions/template-update-no-journal.test.ts
 * @description A remote template update on a Stack must not open a journal batch.
 *
 * `writeUpdateTransaction` journals the pre-state of BOTH targets it rewrites --
 * `.llmwiki/template-lock.json` and `.llmwiki/profile.json` -- so a crash mid-update can
 * restore them. When both targets live in ROWS there is no pre-state to record and no
 * file to restore, so the batch was recording the previous bytes of files the row path
 * never writes, then deleting the journal it had just created.
 *
 * This suite drives the two writers directly rather than the whole remote-update
 * pipeline: the pipeline's fixture needs a signed tap index, which is orthogonal to the
 * question here -- whether these two targets still touch the filesystem.
 */

import { afterEach, describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeAdvisoryTemplateLock, writeInstalledProfile } from "../../src/profile/templates/install.js";
import { readTemplateLock } from "../../src/profile/templates/lock.js";
import { readProfile } from "../../src/dimensions/wiki/profile-store.js";
import { readTemplateLockRow } from "../../src/dimensions/wiki/template-lock-store.js";
import { applyRemoteTemplateUpdate } from "../../src/profile/templates/update-apply.js";
import { journalHealth } from "../../src/trust/journal-health.js";
import { remoteUpdateFixture, removeRemoteUpdateRoots, TARGET_COORDINATE } from "../fixtures/template-remote-update.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createKgPostgresHarness, type KgPostgresHarness } from "../fixtures/kg-postgres.js";

/**
 * A minimal valid v1 lock.
 *
 * v2 is deliberately not used: it also requires the optional `remote` block to agree with
 * `sourceType`, which is a rule of the PARSER and not of this store. The question here is
 * whether the document lands in a row and reaches the parser, not whether the parser's
 * v2 consistency rules work -- `lock.ts`'s own suite covers those.
 */
const LOCK = {
  schemaVersion: 1 as const,
  templateId: "team",
  version: "2.0.0",
  publisher: "acme",
  sourceType: "local" as const,
  installedAt: "2026-01-01T00:00:00.000Z",
  profileDigest: "a".repeat(64),
};

/** A minimal profile package body the installer accepts. */
const PACKAGE = { profile: { schemaVersion: 1, profileId: "team", entities: { note: { directory: "wiki/notes" } } } };

/** Run `body` with the Stack env bound, restoring whatever was there. */
async function withStackEnv(harness: KgPostgresHarness, body: () => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  try {
    process.env.AKS_STACK_ID = harness.stackId;
    process.env.AKS_DATABASE_URL = process.env.LLMWIKI_TEST_DATABASE_URL ?? "";
    await body();
  } finally {
    process.env = saved;
  }
}

/** A project root, a Stack and the Stack env, torn down together. */
async function withProject(body: (root: string, harness: KgPostgresHarness) => Promise<void>): Promise<void> {
  const harness = await createKgPostgresHarness(`tu-${randomUUID().slice(0, 8)}`);
  let root = "";
  try {
    await withStackEnv(harness, async () => {
      // A CLEAN root. `makeResearchLikeRoot` seeds `.llmwiki/profile.json`, which would
      // make the "no profile file" assertion measure the fixture rather than the writer.
      root = await mkdtemp(path.join(tmpdir(), "tmpl-update-"));
      await body(root, harness);
    });
  } finally {
    if (root !== "") await rm(root, { recursive: true, force: true });
    await harness.cleanup();
  }
}

describe("a full remote update on a Stack", () => {
  const roots: string[] = [];
  afterEach(async () => removeRemoteUpdateRoots(roots));

  it("completes through ROWS and opens no journal batch", async () => {
    // This drives `applyRemoteTemplateUpdate` end to end, which is the only way to reach
    // `writeUpdateTransaction` -- the function whose journal branch this change adds.
    // Calling the two writers directly bypasses it and proves nothing about it.
    const harness = await createKgPostgresHarness(`tu-full-${randomUUID().slice(0, 8)}`);
    const saved = { ...process.env };
    try {
      // The env must be set BEFORE the fixture builds: the fixture INSTALLS the base
      // template, and that install writes the lock and profile to whichever backend is
      // active. Seeding files and then switching to rows leaves the row backend empty, and
      // the update then refuses with "provenance is absent" for the wrong reason.
      process.env.AKS_STACK_ID = harness.stackId;
      process.env.AKS_DATABASE_URL = process.env.LLMWIKI_TEST_DATABASE_URL ?? "";
      const fixture = await remoteUpdateFixture(roots);

      const result = await applyRemoteTemplateUpdate(fixture.project, fixture.paths, "1.1.0");

      expect(result).toMatchObject({ kind: "updated", toCoordinate: TARGET_COORDINATE });
      // The update landed in rows...
      expect(await readTemplateLockRow(harness.db, harness.stackId)).toBeDefined();
      expect(await readProfile(harness.db, harness.stackId)).toMatchObject({ document: { profileVersion: "1.1.0" } });
      // ...and no journal batch was created for targets that have no files.
      expect(existsSync(path.join(fixture.project, ".llmwiki", "journal"))).toBe(false);
      expect(await journalHealth(fixture.project)).toMatchObject({ status: "ok" });
    } finally {
      process.env = saved;
      await harness.cleanup();
    }
  });
});

describe("template update targets on a Stack", () => {
  it("writes the lock as a row and leaves no lock file", () =>
    withProject(async (root, harness) => {
      await writeAdvisoryTemplateLock(root, LOCK);

      // Readable through the row store THROUGH the same parser the callers use.
      const row = await readTemplateLockRow(harness.db, harness.stackId);
      expect(row?.document).toMatchObject({ version: "2.0.0" });
      expect(await readTemplateLock(root)).toMatchObject({ kind: "ok" });
      // And the file the journal used to protect does not exist.
      expect(existsSync(path.join(root, ".llmwiki", "template-lock.json"))).toBe(false);
    }));

  it("writes the profile as a row and leaves no profile file", () =>
    withProject(async (root, harness) => {
      await writeInstalledProfile(root, PACKAGE as never);

      expect(await readProfile(harness.db, harness.stackId)).toMatchObject({ document: PACKAGE.profile });
      expect(existsSync(path.join(root, ".llmwiki", "profile.json"))).toBe(false);
    }));

  it("opens no journal when both targets are rows", () =>
    withProject(async (root) => {
      await writeAdvisoryTemplateLock(root, LOCK);
      await writeInstalledProfile(root, PACKAGE as never);

      // The whole point: no `.llmwiki/journal` for an update whose targets are rows.
      expect(existsSync(path.join(root, ".llmwiki", "journal"))).toBe(false);
    }));
});
