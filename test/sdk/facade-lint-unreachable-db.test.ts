/**
 * @file test/sdk/facade-lint-unreachable-db.test.ts
 * @description A Stack-bound facade handle cannot LINT without a reachable database.
 *
 * ## The published requirement this pins
 *
 * `CHANGELOG.md` states it as the consequence of the `env`-threading fix: a
 * `createWiki({ root, env })` handle whose `env` names a Stack now resolves its lint
 * corpus from THAT Stack's rows, so `lint()` and `lintByTier()` on such a handle
 * "require a reachable database", and "an embedder whose database is briefly
 * unavailable gets an exception instead of filesystem-based results".
 *
 * Before the threading fix the same handle answered regardless, and the answer was
 * worse than an outage: with an ambient Stack bound to the process it reported THAT
 * tenant's findings, and with none it walked a `wiki/` tree a Stack deployment does not
 * have and reported a clean wiki. Both were measured when the fix landed
 * (`odd/tasks/facade-env-remaining-sites.md`, L5). This file pins the documented
 * trade: rejection is the CONTRACT now, so making lint fall back to disk instead of
 * throwing is a regression, not a convenience.
 *
 * ## Why the environment is unreachable rather than absent
 *
 * A handle whose `env` names NO Stack is a supported file-backed deployment and must
 * keep linting `wiki/` (pinned in `facade-env-threading.test.ts`); the new requirement
 * binds only a handle that NAMES a Stack. So this fixture names a well-formed Stack id
 * and points `AKS_DATABASE_URL` — the variable the dimension reads, at
 * `packages/wiki/src/dimensions/activation.ts:61` — at a closed localhost port. The
 * connection is refused at once and nothing leaves the host.
 *
 * ## What is pinned
 *
 *  - the SAME root, read by a handle that names no Stack, still lints and still names
 *    its empty page — the corpus really is there, so a rejection is not "there was
 *    nothing to lint";
 *  - `lint()` rejects on the Stack-bound handle;
 *  - `lintByTier()` rejects too, since it is the same seam in the same run;
 *  - `getSource()` keeps answering from disk (`null` for a file it does not hold)
 *    instead of rejecting: it is the INERT site recorded in `sdk/core.ts` and must not
 *    acquire a database dependency by accident.
 *
 * No container and no ambient Stack: a refused localhost connection is the whole
 * fixture, so the test depends on no shared database and on no timing.
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWiki } from "../../packages/wiki/src/sdk/wiki.js";
import type { LintSummary } from "../../packages/wiki/src/linter/types.js";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
} from "../../packages/wiki/src/dimensions/activation.js";

/** The Stack the handle names: well-formed, and no database stands behind it. */
const ABSENT_STACK_ID = "0f000000-0000-4000-8000-000000000000";

/** A DSN whose port is closed, so `connect` is refused immediately on the loopback. */
const REFUSED_DSN = "postgresql://nobody:nobody@127.0.0.1:1/none";

/** A page body below the rule's 50-character floor, so `empty-page` names it. */
const HOLLOW_PAGE = `---\ntitle: Hollow\nsummary: Hollow summary\n---\n\nshort\n`;

describe("SDK facade lint requires a reachable database on a Stack-bound handle", () => {
  it("rejects instead of answering from the filesystem or the ambient Stack", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sdk-lint-unreachable-"));
    try {
      await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
      await writeFile(path.join(root, "wiki", "concepts", "hollow.md"), HOLLOW_PAGE, "utf-8");

      // An explicit empty `env` names no Stack, so this handle is file-backed whatever
      // the runner's own `process.env` holds: its answer is the disk corpus, named.
      const fileBound = createWiki({ root, env: {} });
      const disk = ((await fileBound.lint()) as LintSummary).results.filter(
        (result) => result.rule === "empty-page",
      );
      expect(disk.map((finding) => path.basename(finding.file))).toEqual(["hollow.md"]);

      const stackBound = createWiki({
        root,
        env: { [AKS_STACK_ID_ENV_VAR]: ABSENT_STACK_ID, [AKS_DATABASE_URL_ENV_VAR]: REFUSED_DSN },
      });
      // Both surfaces require the database the named Stack lives in, and say so.
      await expect(stackBound.lint()).rejects.toThrow(/ECONNREFUSED/);
      await expect(stackBound.lintByTier()).rejects.toThrow(/ECONNREFUSED/);
      // The inert site still answers from disk rather than rejecting: no database is
      // implied by a single-source read, and a future row wiring would fail here.
      expect(await stackBound.getSource("note.md")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
