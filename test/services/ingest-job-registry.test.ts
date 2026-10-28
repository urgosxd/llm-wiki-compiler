/**
 * @file test/services/ingest-job-registry.test.ts
 * @description The registry is bounded, and it never evicts work that is running.
 *
 * WHY THESE ASSERTIONS. A host that serves for weeks accumulates jobs, so the
 * registry must forget. But forgetting the WRONG job is worse than leaking: evicting
 * an in-flight job orphans a running ingest from the only surface that reports it,
 * and the client polls a 404 while the work continues.
 *
 * So the two properties are: retention is bounded, and a job is evictable only when
 * BOTH dimensions have settled.
 */
import { describe, expect, it } from "vitest";
import { createJobRegistry, MAX_JOBS } from "../../src/services/ingest/jobs/registry.js";

/**
 * A registry filled with `count` settled jobs, created one second apart.
 *
 * The dates are RECENT on purpose: this helper measures the capacity bound, and a
 * fixed past date would expire every job through the TTL sweep before the cap was
 * ever reached, making the test pass for the wrong reason.
 */
function withSettledJobs(count: number) {
  const registry = createJobRegistry();
  const base = Date.now();
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = new Date(base + index);
    const job = registry.create(`source-${index}`, at);
    registry.patchIngest(job.id, { status: "succeeded" }, at);
    registry.patchCompile(job.id, { status: "succeeded" }, at);
    ids.push(job.id);
  }
  return { registry, ids };
}

describe("the job registry", () => {
  it("keeps every job below the cap", () => {
    const { registry, ids } = withSettledJobs(3);
    expect(ids.every((id) => registry.get(id) !== undefined)).toBe(true);
  });

  it("drops the oldest settled job once the cap is exceeded", () => {
    const { registry, ids } = withSettledJobs(MAX_JOBS + 5);
    // The most recent work is what a UI needs; the oldest is what can go.
    expect(registry.get(ids[0] ?? "")).toBeUndefined();
    expect(registry.get(ids[ids.length - 1] ?? "")).toBeDefined();
    expect(registry.list().length).toBeLessThanOrEqual(MAX_JOBS);
  });

  it("never evicts a job whose compile is still running", () => {
    const registry = createJobRegistry();
    const base = Date.now();
    // Created FIRST, so it is the oldest and would be the first thing a naive
    // eviction drops -- which is exactly what must not happen.
    const running = registry.create("still-running", new Date(base));
    registry.patchIngest(running.id, { status: "succeeded" }, new Date(base));
    registry.patchCompile(running.id, { status: "running" }, new Date(base));
    for (let index = 0; index < MAX_JOBS + 3; index += 1) {
      const at = new Date(base + 1 + index);
      const job = registry.create(`s-${index}`, at);
      registry.patchIngest(job.id, { status: "succeeded" }, at);
      registry.patchCompile(job.id, { status: "succeeded" }, at);
    }
    // The in-flight job survives even though it is the OLDEST: dropping it would
    // delete the status of work that is still happening.
    expect(registry.get(running.id)).toBeDefined();
  });

  it("expires a settled job past the TTL on read", () => {
    const registry = createJobRegistry();
    const created = new Date("2020-01-01T00:00:00.000Z");
    const job = registry.create("stale", created);
    registry.patchIngest(job.id, { status: "failed" }, created);
    registry.patchCompile(job.id, { status: "skipped" }, created);
    // Read long after the TTL window: the sweep runs lazily, so the read is what
    // performs it.
    expect(registry.get(job.id)).toBeUndefined();
  });

  it("keeps a queued job regardless of its age", () => {
    const registry = createJobRegistry();
    const job = registry.create("never-started", new Date("2020-01-01T00:00:00.000Z"));
    // A job that never ran is not settled, so it is never expired -- otherwise a
    // long backlog would be deleted instead of executed.
    expect(registry.get(job.id)).toBeDefined();
  });

  it("ignores a patch for an unknown id instead of creating one", () => {
    const registry = createJobRegistry();
    registry.patchIngest("ing_missing", { status: "running" }, new Date());
    // Patching must not resurrect an evicted job: the transition belongs to work
    // that is already gone.
    expect(registry.get("ing_missing")).toBeUndefined();
  });
});
