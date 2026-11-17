/**
 * @file test/testcontainers-no-adopted-server.test.ts
 * @description Pins S4: a run never continues against a server it did not create or own.
 *
 * ## The behaviour this replaces
 *
 * When no container could be started, the harness probed `DEFAULT_TEST_DATABASE_URL` and, if
 * something answered, printed a WARNING and published that server as the run's database. The
 * warning was invisible in the suite summary, and what it announced was a green run against a
 * server the run never created — in practice a developer's hand-migrated compose instance on 5434.
 * A suite can pass on such a server using state another run left behind, which is the defect.
 *
 * ## Why the decision, and not a container failure
 *
 * Docker IS available here, so the branch only fires when Docker is unavailable — the one
 * condition this test cannot manufacture without stopping somebody else's container. The decision
 * therefore takes the probe as an input: `answers` returning `true` IS the condition that used to
 * be adopted, and it is driven directly. What is asserted is the published record, the same object
 * `publishSharedTestDatabase` writes and every worker reads.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE_URL_ENV_VAR } from "./fixtures/test-database.js";
import { SHARED_POSTGRES_IMAGE, noContainerHandoff } from "./fixtures/testcontainers-postgres.js";

/** The Docker failure a container-less run sees, phrased as production phrases it. */
const NO_CONTAINER = `no ${SHARED_POSTGRES_IMAGE} container could be started (docker unavailable)`;

/** A probe that reports a server answering at the documented local port. */
const ANSWERING = async (): Promise<boolean> => true;

/** A probe that reports nothing listening at the documented local port. */
const SILENT = async (): Promise<boolean> => false;

describe("the harness with no container obtainable", () => {
  it("refuses a server that answers at the documented port, and says what to do instead", async () => {
    const handoff = await noContainerHandoff(NO_CONTAINER, ANSWERING);
    expect(handoff.source, "an adopted server must not be published as this run's database").toBe(
      "unavailable",
    );
    expect(handoff.url, "the answering server's URL must not be published").toBeNull();
    const reason = handoff.reason ?? "";
    expect(reason, "the reason must name the server that answered").toContain(
      DEFAULT_TEST_DATABASE_URL,
    );
    expect(reason, "the reason must say this run does not own that server").toMatch(
      /neither created nor owns it/,
    );
    expect(reason, "the reason must tell the reader how to get an owned database").toContain(
      "Docker",
    );
    expect(reason, "the reason must name the explicit override").toContain(
      TEST_DATABASE_URL_ENV_VAR,
    );
  });

  it("still reports the plain no-server condition when nothing answers", async () => {
    const handoff = await noContainerHandoff(NO_CONTAINER, SILENT);
    expect(handoff.source).toBe("unavailable");
    expect(handoff.url).toBeNull();
    expect(handoff.reason ?? "").toContain(`nothing answers at ${DEFAULT_TEST_DATABASE_URL} either`);
    expect(handoff.reason ?? "").toContain(NO_CONTAINER);
  });
});
