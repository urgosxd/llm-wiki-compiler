/** Run the real gate in small projects; baseline edits must not turn regressions green. */
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTypecheckProject } from "./fixtures/test-typecheck-project.js";

const command = fileURLToPath(new URL("../scripts/typecheck-tests.ts", import.meta.url));
let root: string;
beforeEach(async () => { root = await createTypecheckProject(); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Invoke the CLI directly, without npm, networking or build output. */
function run(...args: string[]) {
  return spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: "utf8" });
}

/** Seed a valid source and bootstrap the one-time fixture baseline. */
async function seed(body: string): Promise<string> {
  const file = path.join(root, "test", "nested", "probe.ts");
  await writeFile(file, body);
  const result = run("--init");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return file;
}

/** Write a test file whose body produces exactly the requested number of type errors. */
async function writeErrors(relative: string, errors: number): Promise<void> {
  const body = Array.from({ length: errors }, (_, index) => `export const value${index}: string = ${index};`);
  await writeFile(path.join(root, relative), body.join("\n") + "\n");
}

/** Snapshot every file's contents so a test can prove exactly what a run wrote. */
async function snapshotTree(): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const pairs = await Promise.all(files.map(async (file) => [path.relative(root, file), await readFile(file, "utf8")] as const));
  return Object.fromEntries(pairs);
}

/**
 * Anchor a stale baseline, then move the live project away from it: the stored document carries a
 * different configuration digest, one dead path, one lowered count, and one raised count.
 */
async function seedStaleBaseline(): Promise<{ baselineFile: string; before: string }> {
  await writeErrors("test/nested/probe.ts", 4);
  await writeErrors("test/nested/keep.ts", 1);
  expect(run("--init").status).toBe(0);
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const stored = JSON.parse(await readFile(baselineFile, "utf8"));
  stored.configuration = "stale-configuration-digest";
  stored.counts["test/nested/gone.ts"] = 3;
  await writeFile(baselineFile, JSON.stringify(stored, null, 2) + "\n");
  const before = await readFile(baselineFile, "utf8");
  await writeErrors("test/nested/probe.ts", 2);
  await writeErrors("test/nested/keep.ts", 3);
  await writeErrors("test/nested/extra.ts", 1);
  return { baselineFile, before };
}

it("fails on a new test error and passes after reverting it", async () => {
  const file = await seed('export const value: string = "ok";');
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const before = await readFile(baselineFile, "utf8");
  await writeFile(file, "export const value: string = 42;");
  const gate = run();
  expect(gate.status).toBe(1);
  expect(gate.stderr).toContain("test/nested/probe.ts: 1 diagnostics exceeds baseline 0");
  const update = run("--update");
  expect(update.status).toBe(1);
  expect(update.stderr).toContain("test/nested/probe.ts: 1 diagnostics exceeds baseline 0");
  expect(await readFile(baselineFile, "utf8")).toBe(before);
  await writeFile(file, 'export const value: string = "ok";');
  expect(run().status).toBe(0);
});

it("requires lowering the baseline after fixing its last error", async () => {
  const file = await seed("export const value: string = 42;");
  await writeFile(file, 'export const value: string = "ok";');
  const gate = run();
  expect(gate.status).toBe(1);
  expect(gate.stderr).toContain("test/nested/probe.ts: diagnostics decreased from 1 to 0; update the baseline");
  expect(run("--update").status).toBe(0);
  expect(JSON.parse(await readFile(path.join(root, "test-typecheck-baseline.json"), "utf8")).counts).toEqual({});
  expect(run().status).toBe(0);
});

it("rejects manual baseline increases relative to a PR base", async () => {
  const file = await seed('export const value: string = "ok";');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "baseline"], { cwd: root });
  await writeFile(file, "export const value: string = 42;");
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
  baseline.counts["test/nested/probe.ts"] = 1;
  await writeFile(baselineFile, JSON.stringify(baseline));
  expect(run("--base-ref", "HEAD").status).toBe(1);
});

it("does not overwrite an existing baseline through bootstrap", async () => {
  await seed("export const value = 42;");
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const before = await readFile(baselineFile, "utf8");
  const result = run("--init");
  expect(result.status).toBe(1);
  expect(result.stderr.trimEnd()).toBe("Baseline already exists; use --update for reductions");
  expect(await readFile(baselineFile, "utf8")).toBe(before);
});

it.each(["typescript", "configuration"])("refuses a mismatched %s pin", async (field) => {
  await seed("export const value = 42;");
  const file = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(file, "utf8"));
  baseline[field] = "different";
  await writeFile(file, JSON.stringify(baseline));
  expect(run().status).toBe(1);
  expect(run("--update").status).toBe(1);
});

it("refuses malformed diagnostic allowances", async () => {
  await seed("export const value = 42;");
  const file = path.join(root, "test-typecheck-baseline.json");
  const baseline = JSON.parse(await readFile(file, "utf8"));
  baseline.counts["test/nested/probe.ts"] = -1;
  await writeFile(file, JSON.stringify(baseline));
  expect(run().status).toBe(1);
});

it("reports a re-baseline dry run without writing", async () => {
  const { baselineFile, before } = await seedStaleBaseline();
  const result = run("--rebaseline");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(await readFile(baselineFile, "utf8")).toBe(before);
  expect(result.stdout).toContain("Test type-check re-baseline (dry run; nothing written)\n");
  expect(result.stdout).toContain("Old configuration: stale-configuration-digest\n");
  expect(result.stdout).toMatch(/New configuration: [0-9a-f]{64}\n/);
  expect(result.stdout).toContain([
    "ADDED: 1 file",
    "  test/nested/extra.ts: 1 diagnostic",
    "REMOVED: 1 file",
    "  test/nested/gone.ts: 3 diagnostics",
    "INCREASED: 1 file",
    "  test/nested/keep.ts: 1 -> 3",
    "DECREASED: 1 file",
    "  test/nested/probe.ts: 4 -> 2",
    "Total errors: 8 -> 6",
  ].join("\n"));
  expect(result.stdout).toContain("Run again with --confirm to write the new baseline.");
});

it("writes the live measurement when a re-baseline is confirmed", async () => {
  const { baselineFile } = await seedStaleBaseline();
  const result = run("--rebaseline", "--confirm");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Test type-check re-baseline (confirmed)");
  expect(result.stdout).toContain("Wrote test-typecheck-baseline.json.");
  const written = JSON.parse(await readFile(baselineFile, "utf8"));
  expect(written.version).toBe(1);
  expect(written.configuration).toMatch(/^[0-9a-f]{64}$/);
  expect(written.counts).toEqual({
    "test/nested/extra.ts": 1,
    "test/nested/keep.ts": 3,
    "test/nested/probe.ts": 2,
  });
  const rerun = run();
  expect(rerun.status).toBe(0);
  expect(rerun.stdout).toContain("no regression");
});

it("writes nothing but the baseline file", async () => {
  await writeErrors("test/nested/probe.ts", 2);
  const before = await snapshotTree();
  expect(run("--rebaseline", "--confirm").status).toBe(0);
  const after = await snapshotTree();
  expect(Object.keys(after).sort()).toEqual([...Object.keys(before), "test-typecheck-baseline.json"].sort());
  for (const file of Object.keys(before)) expect(after[file]).toBe(before[file]);
});

it("reports a missing baseline as an empty starting point", async () => {
  await writeErrors("test/nested/probe.ts", 2);
  const before = await snapshotTree();
  const result = run("--rebaseline");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Old configuration: none (no baseline file)");
  expect(result.stdout).toContain("ADDED: 1 file\n  test/nested/probe.ts: 2 diagnostics");
  expect(result.stdout).toContain("Total errors: 0 -> 2");
  expect(await snapshotTree()).toEqual(before);
});

it("does not rewrite a baseline that is already current", async () => {
  await writeErrors("test/nested/probe.ts", 2);
  expect(run("--init").status).toBe(0);
  const baselineFile = path.join(root, "test-typecheck-baseline.json");
  const before = await readFile(baselineFile, "utf8");
  const result = run("--rebaseline", "--confirm");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ADDED: 0 files\nREMOVED: 0 files\nINCREASED: 0 files\nDECREASED: 0 files");
  expect(result.stdout).toContain("Baseline is already current; nothing written.");
  expect(await readFile(baselineFile, "utf8")).toBe(before);
});

it("refuses conflicting re-baseline flags", async () => {
  await writeErrors("test/nested/probe.ts", 2);
  expect(run("--init").status).toBe(0);
  const conflict = run("--rebaseline", "--update");
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toContain("Choose --rebaseline or a baseline bump, not both");
  const stray = run("--confirm");
  expect(stray.status).toBe(1);
  expect(stray.stderr).toContain("--confirm requires --rebaseline");
});
