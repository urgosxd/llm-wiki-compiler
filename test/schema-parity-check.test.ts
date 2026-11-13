/**
 * @file test/schema-parity-check.test.ts
 * @description Prove that `CHECK_ONLY=true ./scripts/apply-schemas.sh` answers the question
 * a reader will assume it answers — does this database have the COLUMNS the repo declares —
 * and that it can say NO.
 *
 * ## The defect this file exists for
 *
 * `createPageContentSource` selects `wiki.pages.aliases`; `schema.sql:101` declares it;
 * `migration_wiki_db_parity.sql` adds it; the live `aks` database never received that
 * migration. The check mode of `scripts/apply-schemas.sh` passed on that database for
 * months, because it validated row-level security over 25 tenant tables and never compared
 * a single column. Every row-backed page read in that deployment was broken and the gate
 * was green. **A check that cannot fail is decoration**, so the assertions below are built
 * the other way round from most suites: first that the diff NAMES a missing column, then
 * that the whole invocation FAILS on one, and only then that a complete database passes.
 *
 * ## Why the end-to-end case drops a column instead of building a stale database
 *
 * The realistic way to obtain a drifted database is to apply an older file set, which would
 * make this suite's "expected" state depend on a fixture that drifts from `schema.sql` — the
 * trap `test/dimensions/db-parity-migration.test.ts` documents at length. Dropping one
 * column from a database the runner itself just built is a genuine defect of the class being
 * guarded, it names the exact column the deployment lost, and it cannot silently drift.
 *
 * ## The database is created by this suite and by nothing else
 *
 * `createSuiteDatabase` mints a `llmwiki_suite_*` database on the test server, builds the
 * schema from the file list `scripts/apply-schemas.sh` registers, and is dropped in
 * `afterAll`. `aks` is never named here: this suite only ever drops what it created.
 *
 * ## How the checker reaches that database
 *
 * The checker shells out to `psql`, honoring the runner's own `PSQL` wrapper first and
 * `DATABASE_URL` second — so this suite supplies whichever this host actually has: a `psql`
 * on `PATH` takes the DSN, and a host whose only client lives in the compose container
 * supplies the `docker exec` wrapper `docs/guides/wiki-db-parity-migration.mdx` documents.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSuiteDatabase, type SuiteDatabase } from "./fixtures/per-run-database.js";
import type { DeclaredColumn, PresentColumn } from "../scripts/schema-parity-check.js";
import { diffSchema, parseDeclaredFile } from "../scripts/schema-parity-check.js";

/** Repository root, from this file, so the caller's cwd cannot matter. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The single entry point every developer and CI already has. */
const RUNNER = "scripts/apply-schemas.sh";

/** The checker the runner invokes, run directly for the connection-error case. */
const CHECKER = path.join(REPO_ROOT, "scripts/schema-parity-check.ts");

/** The column whose absence broke every row-backed page read on `aks`. */
const LOST_COLUMN = "wiki.pages.aliases";

/** The registered migration that adds it, which the failure must name. */
const LOST_COLUMN_PROVIDER = "packages/wiki/src/dimensions/wiki/migration_wiki_db_parity.sql";

/** A page column as the repo declares it. */
function declaredPageColumn(column: string, provider = LOST_COLUMN_PROVIDER): DeclaredColumn {
  return { table: "wiki.pages", column, provider };
}

/** Present-side rows for `table`, in catalogue order. */
function presentColumns(table: string, columns: readonly string[]): PresentColumn[] {
  return columns.map((column) => ({ table, column }));
}

/** A minimal environment: nothing of the developer's own may decide these outcomes. */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extra };
}

/** Run the wired entry point in its check mode against `extra`. */
function runCheckMode(extra: Record<string, string> = {}) {
  return spawnSync("bash", [RUNNER], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: baseEnv({ CHECK_ONLY: "true", ...extra }),
  });
}

/** The host's own `psql`, when it has one. */
function psqlOnPath(): boolean {
  return spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
}

/** The container Docker publishes `port` from, read from `docker ps`, never guessed. */
function containerForPort(port: string): string {
  const listed = spawnSync("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], {
    encoding: "utf8",
  });
  const match = listed.stdout
    .split("\n")
    .find((line) => line.includes(`:${port}->`));
  const name = match?.split("\t")[0]?.trim() ?? "";
  if (name === "") {
    throw new Error(
      `no container publishes port ${port}, and this host has no psql on PATH: ${listed.stderr}`,
    );
  }
  return name;
}

/**
 * Point the runner at `url` the way this host can.
 *
 * `psql` on `PATH` takes the DSN; otherwise the same `docker exec` wrapper the migration
 * guide documents, with the container resolved from the DSN's published port.
 */
function connectionEnv(url: string): Record<string, string> {
  if (psqlOnPath()) return { DATABASE_URL: url };
  const parsed = new URL(url);
  const container = containerForPort(parsed.port);
  const database = parsed.pathname.replace(/^\//, "");
  const user = decodeURIComponent(parsed.username);
  return { PSQL: `docker exec -i ${container} psql -U ${user} -d ${database}` };
}

/** Open one single-connection client with server NOTICEs silenced. */
function openClient(url: string): Sql {
  return postgres(url, { max: 1, onnotice: () => undefined });
}

/** Run one statement against the per-run database at `url`. */
async function runSql(url: string, statement: string): Promise<void> {
  const client = openClient(url);
  try {
    await client.unsafe(statement);
  } finally {
    await client.end({ timeout: 10 });
  }
}

/** Drop exactly one column from the database this suite created. */
async function dropColumn(url: string, column: string): Promise<void> {
  const [table, name] = [column.slice(0, column.lastIndexOf(".")), column.split(".").pop() ?? ""];
  await runSql(url, `alter table ${table} drop column ${name}`);
}

/**
 * Run `work` against a database of its own, dropped whatever happens.
 *
 * The mutating cases below cannot share the suite database: one adds a column and another
 * disables row-level security on a tenant table, so a shared database would make each case
 * depend on the order the others ran in.
 */
async function withFreshDatabase(
  label: string,
  work: (url: string) => Promise<void>,
): Promise<void> {
  const created = await createSuiteDatabase(`schema-parity-${label}`);
  try {
    await work(created.url);
  } finally {
    await created.drop();
  }
}

/** Binaries the runner needs; `node` is deliberately NOT among them. */
const RUNNER_BINARIES = ["bash", "docker", "psql", "tr", "dirname", "cat"] as const;

/**
 * A directory holding only the runner's binaries, usable as a whole `PATH` with no `node`.
 *
 * The point is `command -v node` in `scripts/apply-schemas.sh` returning nothing: the column
 * half must then fail loudly instead of skipping and reporting a row-level-security-only
 * green, which is the defect the half exists to close.
 */
function pathWithoutNode(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "schema-parity-nonode-"));
  for (const binary of RUNNER_BINARIES) {
    const found = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => path.join(entry, binary))
      .find((candidate) => existsSync(candidate));
    if (found !== undefined) symlinkSync(found, path.join(dir, binary));
  }
  return dir;
}

let suite: SuiteDatabase;
let connection: Record<string, string>;
let beforeDrop: ReturnType<typeof runCheckMode>;
let afterDrop: ReturnType<typeof runCheckMode>;

beforeAll(async () => {
  suite = await createSuiteDatabase("schema-parity");
  connection = connectionEnv(suite.url);
  beforeDrop = runCheckMode(connection);
  await dropColumn(suite.url, LOST_COLUMN);
  afterDrop = runCheckMode(connection);
}, 300_000);

afterAll(async () => {
  await suite?.drop();
}, 60_000);

describe("declared surface parsing", () => {
  it("reads inline columns, skipping comments and nested parens inside a type", () => {
    const sql = [
      "create table if not exists wiki.pages (",
      "  -- one column, with a comma and (parens) in a comment",
      "  stack_id uuid not null,",
      "  amount numeric(12,2) not null default 0,",
      "  constraint pages_pk primary key (stack_id)",
      ");",
    ].join("\n");
    const parsed = parseDeclaredFile("wiki/schema.sql", sql);
    expect(parsed.map((entry) => entry.column)).toEqual(["stack_id", "amount"]);
    expect(parsed.every((entry) => entry.table === "wiki.pages")).toBe(true);
  });

  it("puts an unqualified create table in public, where schema.sql's KG tables live", () => {
    const parsed = parseDeclaredFile("db/schema.sql", "create table kg_evidence (id uuid);");
    expect(parsed.map((entry) => entry.table)).toEqual(["public.kg_evidence"]);
  });

  it("reads add column from a list with comments between the items", () => {
    const sql = [
      "alter table wiki.review_candidates",
      "    -- why this column exists",
      "    add column if not exists candidate_kind jsonb,",
      "    add column if not exists integrity jsonb;",
    ].join("\n");
    const parsed = parseDeclaredFile("migration_candidates.sql", sql);
    expect(parsed.map((entry) => entry.column)).toEqual(["candidate_kind", "integrity"]);
    expect(parsed.every((entry) => entry.provider === "migration_candidates.sql")).toBe(true);
  });
});

describe("declared vs present diff", () => {
  it("reports nothing when both sides agree", () => {
    const declared = [declaredPageColumn("aliases"), declaredPageColumn("attribution_gaps")];
    const report = diffSchema(declared, presentColumns("wiki.pages", ["aliases", "attribution_gaps"]));
    expect(report).toEqual({
      missingColumns: [],
      missingTables: [],
      undeclaredColumns: [],
      undeclaredTables: [],
    });
  });

  it("names a missing column exactly, with the migration that provides it", () => {
    const declared = [declaredPageColumn("aliases"), declaredPageColumn("attribution_gaps")];
    const report = diffSchema(declared, presentColumns("wiki.pages", ["attribution_gaps"]));
    expect(report.missingColumns).toEqual([declaredPageColumn("aliases")]);
    expect(report.missingTables).toEqual([]);
    expect(report.undeclaredColumns).toEqual([]);
  });

  it("reports a present-but-undeclared column as undeclared, never as missing", () => {
    const report = diffSchema(
      [declaredPageColumn("aliases")],
      presentColumns("wiki.pages", ["aliases", "legacy_note"]),
    );
    expect(report.undeclaredColumns).toEqual([{ table: "wiki.pages", column: "legacy_note" }]);
    expect(report.missingColumns).toEqual([]);
  });

  it("reports a declared table the database does not have at all", () => {
    const declared = [
      { table: "wiki.categories", column: "id", provider: "migration_wiki_db_parity.sql" },
      { table: "wiki.categories", column: "name", provider: "migration_wiki_db_parity.sql" },
      declaredPageColumn("aliases"),
    ];
    const report = diffSchema(declared, presentColumns("wiki.pages", ["aliases"]));
    expect(report.missingTables).toEqual(["wiki.categories"]);
    expect(report.missingColumns.map((entry) => entry.column)).toEqual(["id", "name"]);
  });
});

describe("the wired check mode", () => {
  it("is the one check, and fails loudly when it has no connection", () => {
    const result = spawnSync(process.execPath, [CHECKER], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: baseEnv(),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("error: schema parity needs a connection");
  });

  it("passes on a database built by the runner, and still reports RLS", () => {
    expect(beforeDrop.stderr).toBe("");
    expect(beforeDrop.status).toBe(0);
    expect(beforeDrop.stdout).toContain("ok: every tenant table enforces row-level security.");
    expect(beforeDrop.stdout).toContain("schema parity: ok");
  });

  it("fails on one lost column, naming it and the migration that provides it", () => {
    expect(afterDrop.status).toBe(1);
    expect(afterDrop.stderr).toContain(LOST_COLUMN);
    expect(afterDrop.stderr).toContain(LOST_COLUMN_PROVIDER);
    expect(afterDrop.stderr).toContain("drift detected.");
    expect(afterDrop.stderr).not.toContain("ok: every tenant table enforces row-level security.");
  });
});

describe("the check mode beyond a lost column", () => {
  it("fails loudly when node is absent, not reporting an RLS-only green", () => {
    const sparsePath = pathWithoutNode();
    try {
      const result = runCheckMode({ ...connection, PATH: sparsePath });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "error: node is required for the schema parity check and is not on PATH.",
      );
      expect(result.stderr).toContain(
        "error: refusing to report a row-level-security-only result as a schema check.",
      );
    } finally {
      rmSync(sparsePath, { recursive: true, force: true });
    }
  });

  it("reports an undeclared column as a warning and keeps the exit code", async () => {
    await withFreshDatabase("undeclared", async (url) => {
      await runSql(url, "alter table wiki.pages add column legacy_probe int");
      const result = runCheckMode(connectionEnv(url));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("schema parity: ok");
      expect(result.stdout).toContain("undeclared (1, warning only, exit unaffected):");
      expect(result.stdout).toContain("column wiki.pages.legacy_probe");
    });
  });

  it("keeps the row-level-security half failing on its own exact answer", async () => {
    await withFreshDatabase("rls", async (url) => {
      await runSql(url, "alter table wiki.lint_cache disable row level security");
      const result = runCheckMode(connectionEnv(url));
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("schema parity: ok");
      expect(result.stderr).toContain("  MISSING RLS: wiki.lint_cache");
      expect(result.stderr).toContain("drift detected.");
      expect(result.stdout).not.toContain("ok: every tenant table enforces row-level security.");
    });
  });
});

describe("importing the checker", () => {
  it("does not run the CLI, and touches neither stderr nor the exit code", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(CHECKER)});`],
      { cwd: REPO_ROOT, encoding: "utf8", env: baseEnv() },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
