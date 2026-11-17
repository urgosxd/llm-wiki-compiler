/**
 * @file packages/api/src/boot-review-surfaces.test.ts
 * @description Proves the viewer's two review surfaces agree: the `pendingReviews` count in
 * `GET /api/pages` and the rows `GET /api/reviews` lists must name the SAME backend.
 *
 * ## Why this needs its own file
 *
 * `main.test.ts` pins the COUNT side — a Stack-backed host with a leftover `.llmwiki/candidates`
 * directory must count its OWN empty queue, not the checkout's file. Nothing compared that count
 * with the LIST, and the list is a separate read taken at request time
 * (`packages/wiki/src/viewer/server.ts`). Two independent reads can name two different backends,
 * and a suite that only ever asked one of them could not see it.
 *
 * ## Why it spawns the artifact
 *
 * What is measured is a REQUEST-level fact — which Stack a running host serves to a request that
 * names one — so it needs a real process with a frozen snapshot and a real listener. Every case
 * below boots `dist/api.js host --port 0` and asks the two public HTTP surfaces — never an
 * internal count helper, and never a value compared with itself.
 *
 * ## Precondition: the build has run
 *
 * `test/global-setup.ts` builds `dist/` once before any file loads; the launch names that
 * precondition instead of reporting a bare `ENOENT` from the spawn.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AKS_DATABASE_URL_ENV_VAR,
  AKS_STACK_ID_ENV_VAR,
  createDimensionsDatabase,
} from "../../../packages/wiki/src/dimensions/activation.js";
import { saveStoredCandidate } from "../../../packages/wiki/src/dimensions/wiki/candidate-store.js";
import { createSuiteDatabase } from "../../../test/fixtures/per-run-database.js";
// A MIXED file: one case asserts a Stack's rows, the other a project's files. It imports this
// module for `withFileMode` and declares, once, that its mode is decided per case — the file-wide
// hook would otherwise leave the row-backed case without the database it needs.
import { usePerCaseFileMode, withFileMode } from "../../../test/fixtures/file-mode.js";
// The spawn, the readiness wait and the planted candidate come from the harness `main.test.ts`
// also uses: the two files spawn the same bundle, and a copy in each is the drift fallow reports.
import { launch, plantFileCandidate, waitForReady } from "../../../test/fixtures/launcher-harness.js";

usePerCaseFileMode();

/** What the two review surfaces reported on one boot. */
interface ReviewSurfaces {
  /** `counts.pendingReviews` from `GET /api/pages`. */
  readonly count: number;
  /** How many rows `GET /api/reviews` listed. */
  readonly listed: number;
  /** `total` from `GET /api/reviews`: the queue depth the listed rows were sliced from. */
  readonly total: number;
  /** The ids the listed rows carry, in the order the route returned them. */
  readonly ids: string[];
}

/**
 * Ask both review surfaces over HTTP, one boot.
 *
 * The PUBLIC routes only: the question is what a reviewer sees on one screen, so reading
 * anything internal here would let a bug answer for itself.
 *
 * @param base - The base URL the child announced.
 * @param stackId - The Stack to NAME on the list request, which is what a caller does since the
 *   review list resolves its Stack per request. Omitted asks the unnamed route, which is the
 *   file-backed deployment's shape.
 * @returns The count and the number of listed rows.
 */
async function readSurfaces(base: string, stackId?: string): Promise<ReviewSurfaces> {
  const pages = await fetch(`${base}/api/pages`);
  expect(pages.status, `GET ${base}/api/pages must answer`).toBe(200);
  const counts = (await pages.json()) as { counts: { pendingReviews: number } };
  const listUrl = stackId === undefined
    ? `${base}/api/reviews`
    : `${base}/api/reviews?stackId=${encodeURIComponent(stackId)}`;
  const reviews = await fetch(listUrl);
  expect(reviews.status, `GET ${base}/api/reviews must answer`).toBe(200);
  const envelope = (await reviews.json()) as { reviews: { id: string }[]; total: number };
  return {
    count: counts.counts.pendingReviews,
    listed: envelope.reviews.length,
    total: envelope.total,
    ids: envelope.reviews.map((row) => row.id),
  };
}

/** The throwaway checkout this case's child runs in, made fresh for every case. */
let root: string;

/**
 * Create ONE Stack in the throwaway database, the way `POST /stacks` does.
 *
 * Both row-backed cases used to name no Stack and let the BOOT create a default one. S1 of
 * `odd/tasks/stack-authority-per-request.md` deletes that, so each case creates the Stack it
 * is about and names it — which is what a deployment does after its first `POST /stacks`.
 *
 * @param dimensions - Handle on the throwaway database.
 * @param domain - The Stack's domain.
 * @returns The id of the row it created.
 */
async function createStackRow(
  dimensions: ReturnType<typeof createDimensionsDatabase>,
  domain: string,
): Promise<string> {
  const id = randomUUID();
  await dimensions.db.execute(
    `insert into public.stacks (id, name, domain) values ('${id}', '${domain}', '${domain}')`,
  );
  return id;
}

/**
 * Leave ONE pending candidate row in ONE Stack's queue, the way a Stack-backed compile does.
 *
 * A real stored record rather than a hand-built object: the row source lists what the store
 * really holds, so the assertions downstream are about this Stack's queue and nothing else.
 *
 * @param dimensions - Handle on the throwaway database.
 * @param stackId - The Stack the row belongs to.
 * @param id - The candidate id the row carries, which is what the route lists.
 */
async function plantStackCandidate(
  dimensions: ReturnType<typeof createDimensionsDatabase>,
  stackId: string,
  id: string,
): Promise<void> {
  await saveStoredCandidate(dimensions.db, stackId, {
    id, title: id, slug: id, summary: "", sources: [],
    body: `---\ntitle: ${id}\n---\n\nBody.\n`, generatedAt: "2026-01-02T00:00:00.000Z",
    reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }],
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "boot-review-surfaces-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a Stack-backed host whose checkout carries a candidate file", () => {
  it("reports ONE review queue on both surfaces, counting nothing from the checkout", async () => {
    const suite = await createSuiteDatabase("boot-review-surfaces");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      const stackId = await createStackRow(dimensions, "boot-review-surfaces");
      await plantFileCandidate(root);
      // A database configured and ONE Stack named: the shape a deployment has once its owner has
      // created the Stack. Both roots of the boot's answer must still agree about that Stack.
      const host = launch(["host", "--port", "0"], root, {
        ...process.env,
        [AKS_DATABASE_URL_ENV_VAR]: suite.url,
        [AKS_STACK_ID_ENV_VAR]: stackId,
      });
      try {
        const base = await waitForReady(host);
        const surfaces = await readSurfaces(base, stackId);
        // The named Stack's queue is EMPTY: the planted file is the only thing that could
        // make either number anything but zero.
        expect(surfaces.count, "the count must read the Stack's empty queue, not the checkout's files").toBe(0);
        // The claim, in one assertion: whatever the count says, the list must say the same. This is
        // what fails when the list keeps asking the environment while the count consults the boot's
        // resolved authority.
        expect(
          surfaces.listed,
          "a reviewer sees the count and the list on one screen, so they must name the same backend",
        ).toBe(surfaces.count);
      } finally {
        host.terminate();
        await host.exited;
      }
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  });
});

describe("a Stack-backed host whose queue really holds a row", () => {
  it("names the row on both surfaces and never the checkout's candidate file", async () => {
    // The case above proves the two surfaces AGREE, but its queue is EMPTY: `0` and `0` would
    // hold just as well if the row branch answered nothing at all. Here the queue is non-empty and
    // the checkout carries a file with a DIFFERENT id, so every wrong backend leaves a fingerprint
    // on the assertions: a union with the file reports 2, a file fallback names `planted-1`, and a
    // row branch that stopped reading reports 0.
    const suite = await createSuiteDatabase("boot-review-surfaces-rows");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      const stackId = await createStackRow(dimensions, "boot-review-surfaces-rows");
      await saveStoredCandidate(dimensions.db, stackId, {
        id: "row-1", title: "Row", slug: "row", summary: "", sources: [],
        body: "---\ntitle: Row\n---\n\nBody.\n", generatedAt: "2026-01-02T00:00:00.000Z",
        reviewMode: "forced", heldReasons: [{ code: "manual-review-requested" }],
      });
      await plantFileCandidate(root);
      const host = launch(["host", "--port", "0"], root, {
        ...process.env, [AKS_DATABASE_URL_ENV_VAR]: suite.url, [AKS_STACK_ID_ENV_VAR]: stackId,
      });
      try {
        const surfaces = await readSurfaces(await waitForReady(host), stackId);
        expect(surfaces.count, "the count must read the Stack's own queue").toBe(1);
        expect(surfaces.total, "the total must read the Stack's own queue").toBe(1);
        expect(surfaces.ids, "the list must name the row, never the checkout's file").toEqual(["row-1"]);
      } finally {
        host.terminate();
        await host.exited;
      }
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  }, 120_000);
});

describe("one boot serving several Stacks", () => {
  it("reads the Stack EACH request names, with no restart in between", async () => {
    // S6's own claim, and the reason the boot stopped resolving a Stack: authority is a request
    // input, so one process must answer for whichever Stack each request names. Two Stacks with
    // DIFFERENT rows make every wrong answer visible — a boot-frozen Stack names the other id, and
    // a file fallback names `planted-1`.
    const suite = await createSuiteDatabase("boot-review-surfaces-per-request");
    const dimensions = createDimensionsDatabase({ [AKS_DATABASE_URL_ENV_VAR]: suite.url });
    try {
      const first = await createStackRow(dimensions, "per-request-first");
      const second = await createStackRow(dimensions, "per-request-second");
      await plantStackCandidate(dimensions, first, "row-first");
      await plantStackCandidate(dimensions, second, "row-second");
      await plantFileCandidate(root);
      // The boot names the FIRST Stack, so the second is served only if the resolution really
      // happens per request instead of once at startup.
      const host = launch(["host", "--port", "0"], root, {
        ...process.env, [AKS_DATABASE_URL_ENV_VAR]: suite.url, [AKS_STACK_ID_ENV_VAR]: first,
      });
      try {
        const base = await waitForReady(host);
        const firstRead = await readSurfaces(base, first);
        expect(firstRead.ids, "the first Stack's request must read its OWN row").toEqual(["row-first"]);
        const secondRead = await readSurfaces(base, second);
        expect(secondRead.ids, "the second Stack's request must read its OWN row").toEqual(["row-second"]);
        // The name is VALIDATED, not trusted: an id that names no row is refused through the same
        // `stackExists` check the mutation surface uses, not served as an empty queue.
        const unknown = await fetch(`${base}/api/reviews?stackId=${randomUUID()}`);
        expect(unknown.status, "a Stack id that names no row must be refused").toBe(404);
        // A request that names NONE must not silently substitute a backend. This asserts the
        // CHECKOUT is never read, not the envelope: the unnamed-request contract is T4's, so only
        // T5's own claim — no file fallback — is pinned here.
        const unnamed = await fetch(`${base}/api/reviews`);
        const body = (await unnamed.json()) as { reviews?: { id: string }[] };
        expect(
          (body.reviews ?? []).map((row) => row.id),
          "an unnamed request must never fall back to the checkout's candidate file",
        ).not.toContain("planted-1");
      } finally {
        host.terminate();
        await host.exited;
      }
    } finally {
      await dimensions.close();
      await suite.drop();
    }
  }, 120_000);
});

describe("a file-backed host whose checkout carries a candidate file", () => {
  it("counts AND lists the one candidate the file backend really holds", async () => {
    // The mirror of the case above, and the reason it exists: with no database configured the
    // authority answers the named FILE mode, so both surfaces must read files — and report the
    // single candidate that is really there, which is what makes the comparison non-vacuous.
    // `test/viewer-reviews-api.test.ts` asks both surfaces too, but only on an EMPTY queue, where
    // its `pendingReviews` assertion (0) equals the list it would also have to be zero for: a file
    // path that silently stopped counting would pass it.
    await plantFileCandidate(root);
    await withFileMode(async () => {
      const host = launch(["host", "--port", "0"], root, { ...process.env, [AKS_STACK_ID_ENV_VAR]: "" });
      try {
        const base = await waitForReady(host);
        const surfaces = await readSurfaces(base);
        expect(surfaces.count, "a file-backed host must count the candidate file that is there").toBe(1);
        expect(surfaces.listed, "a file-backed host must list the candidate file it counts").toBe(1);
        expect(surfaces.listed, "the two surfaces must agree, whatever the queue holds").toBe(surfaces.count);
      } finally {
        host.terminate();
        await host.exited;
      }
    });
  });
});
