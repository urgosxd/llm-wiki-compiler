/**
 * @file test/host/graph-prefix-routing.test.ts
 * @description The host decides sub-app ownership by PREFIX, and nothing pinned
 * that decision for a prefix the oracle does not know about.
 *
 * ## Why this file exists
 *
 * `startHost` routes with `isGraphPath`, a `startsWith` over a literal list. Two
 * kinds of path live in that list and they fail differently:
 *
 *   - oracle paths (`/health`, `/stacks`, `/aks`, `/documents`, ...) are covered
 *     indirectly because their behaviour is asserted elsewhere against measured
 *     `Allow` values;
 *   - extension paths are covered by NOTHING. `/domain/kg/...` is the first such
 *     prefix, and when it was omitted the endpoint silently fell through to the
 *     viewer and answered its 404 — while every package-level test passed,
 *     because `createApp()` has no dispatcher.
 *
 * That is the failure this file is built to catch: a green KG suite and an
 * unreachable endpoint at the same time. So the assertions talk to a REAL bound
 * listener, and they distinguish "the graph app answered" from "the viewer
 * answered" by the response SHAPE, not merely by status — both apps can produce
 * a 404, and the viewer's is `{error:{code,message}}` while the graph app's is
 * FastAPI's `{detail}`.
 */
import { describe, expect, it } from "vitest";
import { runningHost } from "../fixtures/running-host.js";

/** A UUID that resolves to no Stack, so the graph app fails INSIDE the handler. */
const UNKNOWN_STACK = "00000000-0000-0000-0000-000000000000";

/** True when the body is the viewer's envelope rather than the graph's. */
function isViewerEnvelope(body: unknown): boolean {
  const envelope = body as { error?: { code?: unknown } } | null;
  return envelope?.error !== undefined && typeof envelope.error.code === "string";
}

/** Boot a host for this suite; the fixture keeps every host suite on one path. */
function bootHost(): ReturnType<typeof runningHost> {
  return runningHost("host-prefix-");
}

describe("the host routes the /domain extension prefix to the graph app", () => {
  it("does not let the viewer claim the stack graph endpoint", async () => {
    const { handle, base } = await bootHost();
    try {
      const response = await fetch(`${base}/domain/kg/stacks/${UNKNOWN_STACK}/graph`, {
        headers: { origin: base },
      });
      // Either app can 404, so the discriminator is the body. A viewer envelope
      // here means `/domain` is missing from GRAPH_PATH_PREFIXES and the request
      // never reached the graph app at all.
      const body: unknown = await response.json().catch(() => null);
      expect(isViewerEnvelope(body)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("keeps the graph app authoritative for an oracle prefix in the same list", async () => {
    const { handle, base } = await bootHost();
    try {
      // `/health` is the control: it proves the dispatcher sends graph-prefixed
      // traffic to the graph app, so the case above is about `/domain` and not
      // about the dispatcher being broken for every prefix.
      const response = await fetch(`${base}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ service: "aks-reference-server" });
    } finally {
      await handle.close();
    }
  });
});
