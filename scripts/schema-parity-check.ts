/**
 * @file scripts/schema-parity-check.ts
 * @description Compare the columns a database ACTUALLY has against the columns the
 * repository DECLARES, and fail when one the repo declares is absent.
 *
 * ## The defect this closes
 *
 * `createPageContentSource` — the production row reader — selects `wiki.pages.aliases`
 * and `wiki.pages.attribution_gaps` (`page-store.ts:214/264/291/348`). `schema.sql:101`
 * and `:104` declare both, and `migration_wiki_db_parity.sql` adds them to a database
 * that predates them. That migration sat in the repository unapplied to the live `aks`
 * database, so every row-backed page read there failed with
 * `PostgresError 42703: column "aliases" does not exist` — and no gate noticed, because
 * the check mode that ran against that database validated row-level security and never
 * compared a column. A check that answers a narrower question than a reader assumes is
 * worse than no check: it reports a green nobody should trust.
 *
 * ## Why this is TypeScript and not a `psql` one-liner
 *
 * The declared side is 17 SQL files of `create table ( ... )` and `alter table ... add
 * column` text. Reading a column list out of that needs depth-0 comma splitting (so a
 * `numeric(12,2)` type or a `check (x in ('a','b'))` predicate is not split), comment
 * removal that leaves quoted literals alone, and quoted-identifier handling. That is a
 * parser, and this repository's shape for a check is a TypeScript entry point —
 * `node scripts/lint-ratchet.ts` is the precedent. The connection side still goes
 * through `psql`, honoring the runner's `PSQL` wrapper first and `DATABASE_URL` second,
 * so no database driver is added and the `docker exec` form works exactly as it does
 * for `scripts/apply-schemas.sh`.
 *
 * ## One check, not two
 *
 * `scripts/apply-schemas.sh` invokes this file from its `--check` / `CHECK_ONLY` mode,
 * so `CHECK_ONLY=true ./scripts/apply-schemas.sh` is a green on COLUMNS as well as on
 * row-level security. There is deliberately no `package.json` entry and no CI workflow
 * edit: CI already runs that command, so wiring parity there means CI covers parity.
 *
 * ## Error vs warning, and why the split is not a softening
 *
 * A declared column the database lacks is an ERROR (exit `1`). Every one of them is
 * reported — no threshold, no ignore list, no baseline — because a first real finding
 * that gets filtered is a finding nobody should trust. A column the database has and
 * nothing declares is a WARNING (listed, exit unaffected): `aks` legitimately carries
 * seven legacy tables and 49 such columns, and a guard that fails on those cannot be
 * run against a real deployment at all.
 *
 * ## What it catches, and — stated plainly — what it does not
 *
 * Catches: a declared table missing from the database; a declared column missing from a
 * table the database has. Both are named with the file that provides them.
 *
 * Does NOT catch: a wrong column TYPE, a missing or different DEFAULT, a changed
 * NULLABILITY, a missing INDEX, a missing CONSTRAINT, a column in the wrong ORDER, a
 * migration applied out of order (only its end state is visible), a table or column that
 * exists but is not granted to the application role, row-level security, or anything
 * declared in a schema other than the two this file reads (see below). Those are structural
 * dimensions this check does not read, and `test/dimensions/db-parity-migration.test.ts`
 * is where the full catalogue comparison lives. Types and indexes were considered and
 * left out: comparing them means normalising `format_type` output, index definitions and
 * default expressions, which is a different check with a different failure mode, not a
 * cheap addition here.
 *
 * ## The comparison is bounded to two schemas, and that bound is a limit
 *
 * The catalogue side reads `public` and `wiki` and nothing else (`COMPARED_SCHEMAS`), which
 * matches the declaration side: every `create table` in the 17 registered files qualifies
 * `wiki` or declares nothing, so no declared object falls outside them today. Anything
 * declared in a third schema would be INVISIBLE here rather than reported, and a table
 * living outside those two schemas is never listed as undeclared either. Passing a
 * connection does not widen this: the bound is in the file, not in the target.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository root, resolved from this file so the caller's cwd cannot matter. */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The runner that owns the one authoritative file list. */
const RUNNER = "scripts/apply-schemas.sh";

/** The array name inside {@link RUNNER} that lists the schema files, in apply order. */
const SCHEMA_FILES_MARKER = "SCHEMA_FILES=(";

/** Schemas compared. `schema.sql` declares its KG tables unqualified, i.e. in `public`. */
const COMPARED_SCHEMAS = ["public", "wiki"] as const;

/** Schema an unqualified `create table` lands in, which is Postgres's own default. */
const DEFAULT_SCHEMA = "public";

/** Exit code when the database is missing something the repository declares. */
const EXIT_DRIFT = 1;

/** Exit code for misuse: no connection, unreadable runner, `psql` that will not run. */
const EXIT_MISUSE = 2;

/** Ceiling on `psql`'s output, so a pathological catalogue cannot exhaust memory. */
const MAX_PSQL_OUTPUT = 32 * 1024 * 1024;

/** Names that open a table-level item rather than a column. */
const NON_COLUMN_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "check",
  "foreign",
  "exclude",
  "like",
]);

/**
 * A possibly double-quoted identifier, without a capture group of its own.
 *
 * Every pattern below wraps it in exactly one group, so group `1` is always the first
 * identifier and group `2` the second; an inner group here would shift both indices and
 * turn a schema qualifier into a column name.
 */
const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';

/** `create table [if not exists] <schema.>table (` — the opening paren is the body. */
const CREATE_TABLE = new RegExp(
  `\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?\\s*\\(`,
  "gi",
);

/** `alter table [if exists] [only] <schema.>table` — the statement is scanned for adds. */
const ALTER_TABLE = new RegExp(
  `\\balter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?`,
  "gi",
);

/** `add column [if not exists] <column>` inside one `alter table` statement. */
const ADD_COLUMN = new RegExp(
  `\\badd\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(${IDENT})`,
  "gi",
);

/** The first identifier of a body item, which is its column name unless it is a keyword. */
const LEADING_IDENT = new RegExp(`^(${IDENT})`);

/** Usage text, printed by `--help`. */
const USAGE = [
  "usage: node scripts/schema-parity-check.ts [connection]",
  "",
  "Compare the columns a database actually has with the columns the SQL files that",
  "scripts/apply-schemas.sh registers declare. A declared column that is absent is an",
  "error (exit 1); a column nothing declares is a warning (exit unaffected).",
  "",
  "This is the check mode of the runner: `CHECK_ONLY=true ./scripts/apply-schemas.sh`",
  "runs it, so that command is a green on columns as well as on row-level security.",
  "",
  "The connection comes from, in order: the PSQL wrapper (`docker exec -i <container>",
  "psql -U <user> -d <db>`), the positional connection string, $DATABASE_URL.",
  "It never needs fixtures or a corpus: an empty, fully migrated database passes.",
  "",
].join("\n");

/** One column the repository declares, with the file that provides it. */
export interface DeclaredColumn {
  /** `schema.table`, with an unqualified `create table` landing in `public`. */
  readonly table: string;
  /** Column name, unquoted and case-folded the way Postgres folds an unquoted one. */
  readonly column: string;
  /** Repository-relative path of the file that declares or adds it. */
  readonly provider: string;
}

/** One column the database actually has. */
export interface PresentColumn {
  /** `schema.table`. */
  readonly table: string;
  /** Column name as the catalogue reports it. */
  readonly column: string;
}

/** One present table that no registered file declares. */
export interface UndeclaredTable {
  /** `schema.table`. */
  readonly table: string;
  /** How many columns it has, so the warning says how much it carries. */
  readonly columnCount: number;
}

/** What one comparison found. Missing is drift; undeclared is a warning. */
export interface ParityReport {
  /** Declared columns the database does not have, sorted by table then column. */
  readonly missingColumns: readonly DeclaredColumn[];
  /** Declared tables no column of which the database has. */
  readonly missingTables: readonly string[];
  /** Columns of a declared table that no registered file declares. */
  readonly undeclaredColumns: readonly PresentColumn[];
  /** Tables that exist and that no registered file declares. */
  readonly undeclaredTables: readonly UndeclaredTable[];
}

/** Index just past the quoted literal or identifier that starts at `start`. */
function endOfQuoted(sql: string, start: number): number {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) return index + 1;
    index += 1;
  }
  return sql.length;
}

/**
 * Index just past a `--` or block comment that starts at `index`, or `index` itself when
 * what starts there is not a comment.
 *
 * Split out of {@link stripComments} so each function answers one question.
 */
function skipComment(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const newline = sql.indexOf("\n", index);
    return newline === -1 ? sql.length : newline;
  }
  if (sql.startsWith("/*", index)) {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return index;
}

/**
 * Remove `--` and block comments, leaving quoted literals and identifiers untouched.
 *
 * A quoted string may contain `--` or a comma; reading it as a comment would truncate a
 * column definition, and the resulting column list would be wrong in a way nobody sees.
 */
function stripComments(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"') {
      const end = endOfQuoted(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    const afterComment = skipComment(sql, index);
    out += afterComment === index ? char : " ";
    index = afterComment === index ? index + 1 : afterComment;
  }
  return out;
}

/** Index just past the `)` that closes the paren at `open`. */
function endOfParens(sql: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"') {
      index = endOfQuoted(sql, index);
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

/** Split a `create table` body at its depth-0 commas. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? "";
    if (char === "'" || char === '"') {
      const end = endOfQuoted(body, index);
      current += body.slice(index, end);
      index = end;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(current);
      current = "";
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== "");
}

/** Fold one possibly-quoted identifier the way Postgres folds an unquoted one. */
function identifierName(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw.toLowerCase();
}

/** The `schema.table` a matched name denotes, defaulting an unqualified one to `public`. */
function tableName(match: RegExpExecArray): string {
  const first = identifierName(match[1] ?? "");
  const second = match[2];
  return second === undefined ? `${DEFAULT_SCHEMA}.${first}` : `${first}.${identifierName(second)}`;
}

/** The column a body item declares, or `""` when the item is a table constraint. */
function columnNameOfItem(item: string): string {
  const leading = LEADING_IDENT.exec(item)?.[1];
  if (leading === undefined) return "";
  const name = identifierName(leading);
  return NON_COLUMN_KEYWORDS.has(name) ? "" : name;
}

/** The columns one file's `create table` bodies declare inline. */
function parseCreateTables(file: string, sql: string): DeclaredColumn[] {
  const found: DeclaredColumn[] = [];
  for (const match of sql.matchAll(CREATE_TABLE)) {
    const table = tableName(match);
    const body = sql.slice(match.index + match[0].length, endOfParens(sql, match.index + match[0].length - 1));
    for (const item of splitTopLevel(body)) {
      const column = columnNameOfItem(item);
      if (column !== "") found.push({ table, column, provider: file });
    }
  }
  return found;
}

/** The columns one file's `alter table ... add column` actions declare. */
function parseAddedColumns(file: string, sql: string): DeclaredColumn[] {
  const found: DeclaredColumn[] = [];
  for (const match of sql.matchAll(ALTER_TABLE)) {
    const table = tableName(match);
    const rest = sql.slice(match.index + match[0].length);
    const statement = rest.slice(0, rest.indexOf(";") === -1 ? rest.length : rest.indexOf(";"));
    for (const added of statement.matchAll(ADD_COLUMN)) {
      const column = added[1];
      if (column !== undefined) found.push({ table, column: identifierName(column), provider: file });
    }
  }
  return found;
}

/**
 * Every column one SQL file declares, from `create table` bodies and from
 * `alter table ... add column` actions, with that file as the provider.
 *
 * @param file - Repository-relative path, used only as the provider label.
 * @param sql - The file's text.
 * @returns Declared columns in file order; table-level constraints are not columns.
 */
export function parseDeclaredFile(file: string, sql: string): DeclaredColumn[] {
  const body = stripComments(sql);
  return [...parseCreateTables(file, body), ...parseAddedColumns(file, body)];
}

/** The quoted file paths one line of the runner's array names, in order. */
function quotedPaths(line: string): string[] {
  return [...line.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** The repository-relative schema files {@link RUNNER} registers, in apply order. */
function schemaFiles(): string[] {
  const script = readFileSync(path.join(REPO_ROOT, RUNNER), "utf-8");
  const start = script.indexOf(SCHEMA_FILES_MARKER);
  const end = start === -1 ? -1 : script.indexOf("\n)", start);
  if (start === -1 || end === -1) {
    throw new Error(`${RUNNER} no longer declares a ${SCHEMA_FILES_MARKER} array`);
  }
  const body = script.slice(start + SCHEMA_FILES_MARKER.length, end);
  const declared = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap(quotedPaths);
  if (declared.length === 0) {
    throw new Error(`${RUNNER} declares ${SCHEMA_FILES_MARKER} but lists no file`);
  }
  return declared;
}

/**
 * Every column every registered file declares.
 *
 * When more than one file declares the same column, the LAST one in the runner's own
 * apply order is the provider: it is the file that reaches a database which already has
 * the older shape — `wiki.pages.aliases` is in `schema.sql`'s `create table` and in
 * `migration_wiki_db_parity.sql`'s `add column`, and the migration is what an existing
 * database is missing. That follows the runner's order rather than inventing a second
 * precedence rule.
 *
 * @returns Declared columns, one entry per `table.column`, in first-declared order.
 */
function readDeclaredSurface(): DeclaredColumn[] {
  const providers = new Map<string, DeclaredColumn>();
  for (const file of schemaFiles()) {
    const sql = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    for (const column of parseDeclaredFile(file, sql)) {
      const key = `${column.table}.${column.column}`;
      const seen = providers.get(key);
      providers.set(key, seen === undefined ? column : { ...seen, provider: column.provider });
    }
  }
  return [...providers.values()];
}

/** Sort catalogue rows by table, then column; both sides of the diff use it. */
function byTableThenColumn(
  left: { readonly table: string; readonly column: string },
  right: { readonly table: string; readonly column: string },
): number {
  return left.table === right.table
    ? left.column.localeCompare(right.column)
    : left.table.localeCompare(right.table);
}

/**
 * Compare the declared surface against the database's actual columns.
 *
 * A table counts as missing when the database has no column for it at all, which is what
 * `information_schema.columns` can say. Columns of a missing table are reported both as
 * "missing table" and as their own missing-column lines, because a reader needs the column
 * names as well as the table.
 *
 * @param declared - Columns the repository declares.
 * @param present - Columns the database reports.
 * @returns The report; empty arrays in every field means the database matches.
 */
export function diffSchema(
  declared: readonly DeclaredColumn[],
  present: readonly PresentColumn[],
): ParityReport {
  const declaredKeys = new Set(declared.map((entry) => `${entry.table}.${entry.column}`));
  const presentKeys = new Set(present.map((entry) => `${entry.table}.${entry.column}`));
  const declaredTables = new Set(declared.map((entry) => entry.table));
  const presentTables = new Set(present.map((entry) => entry.table));
  const missingColumns = declared
    .filter((entry) => !presentKeys.has(`${entry.table}.${entry.column}`))
    .sort(byTableThenColumn);
  const undeclaredColumns = present
    .filter(
      (entry) => declaredTables.has(entry.table) && !declaredKeys.has(`${entry.table}.${entry.column}`),
    )
    .sort(byTableThenColumn);
  return {
    missingColumns,
    missingTables: [...declaredTables].filter((table) => !presentTables.has(table)).sort(),
    undeclaredColumns,
    undeclaredTables: [...presentTables]
      .filter((table) => !declaredTables.has(table))
      .sort()
      .map((table) => ({
        table,
        columnCount: present.filter((entry) => entry.table === table).length,
      })),
  };
}

/** Does this report mean the database matches the repository? */
function isClean(report: ParityReport): boolean {
  return report.missingColumns.length === 0 && report.missingTables.length === 0;
}

/** Group missing columns by table, preserving their sorted order. */
function groupByTable(columns: readonly DeclaredColumn[]): Map<string, DeclaredColumn[]> {
  const grouped = new Map<string, DeclaredColumn[]>();
  for (const column of columns) {
    grouped.set(column.table, [...(grouped.get(column.table) ?? []), column]);
  }
  return grouped;
}

/** The file that provides a declared table, read from any of its missing columns. */
function tableProvider(report: ParityReport, table: string): string {
  return report.missingColumns.find((entry) => entry.table === table)?.provider ?? "(unknown file)";
}

/** The `missing tables` block, one line per table, naming its providing file. */
function formatMissingTables(report: ParityReport): string[] {
  if (report.missingTables.length === 0) return [];
  return [
    `missing tables (${String(report.missingTables.length)}):`,
    ...report.missingTables.map(
      (table) => `  ${table}  provided by ${tableProvider(report, table)}`,
    ),
  ];
}

/** The `missing columns` block, grouped by table, one line per column. */
function formatMissingColumns(report: ParityReport): string[] {
  const grouped = groupByTable(report.missingColumns);
  if (grouped.size === 0) return [];
  const lines = [`missing columns (${String(report.missingColumns.length)}):`];
  for (const [table, columns] of grouped) {
    lines.push(`  ${table} (${String(columns.length)}):`);
    for (const column of columns) {
      lines.push(`    ${column.table}.${column.column}  provided by ${column.provider}`);
    }
  }
  return lines;
}

/** The undeclared block: warnings, so the verdict line and exit code ignore it. */
function formatUndeclared(report: ParityReport): string[] {
  const count = report.undeclaredTables.length + report.undeclaredColumns.length;
  if (count === 0) return [];
  const lines = [`undeclared (${String(count)}, warning only, exit unaffected):`];
  for (const entry of report.undeclaredTables) {
    lines.push(`  table ${entry.table} (${String(entry.columnCount)} columns, declared nowhere)`);
  }
  for (const column of report.undeclaredColumns) {
    lines.push(`  column ${column.table}.${column.column}`);
  }
  return lines;
}

/**
 * Render one report for a terminal: grouped by table, one line per missing column, and a
 * closing verdict line.
 *
 * Readable at 86 findings, which is what the first real database reported: the grouping is
 * what keeps the count meaningful instead of a wall of columns.
 *
 * @param report - The comparison result.
 * @param declaredCount - How many columns the repository declares, for the verdict.
 * @returns Plain text, without a trailing newline.
 */
function formatReport(report: ParityReport, declaredCount: number): string {
  const lines = [...formatMissingTables(report), ...formatMissingColumns(report), ...formatUndeclared(report)];
  if (isClean(report)) {
    lines.unshift(`schema parity: ${String(declaredCount)} declared columns all present.`);
    lines.push("schema parity: ok");
  } else {
    lines.push(
      `schema parity: FAIL - ${String(report.missingColumns.length)} missing columns in ` +
        `${String(groupByTable(report.missingColumns).size)} tables, ` +
        `${String(report.missingTables.length)} missing tables.`,
    );
  }
  return lines.join("\n");
}

/** The `psql` arguments that print one tab-separated catalogue query. */
function psqlArgs(sql: string): string[] {
  return ["-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "\t", "-c", sql];
}

/**
 * The command and arguments that reach the database, honoring what the runner honors.
 *
 * Checks the `PSQL` wrapper FIRST, exactly as `scripts/apply-schemas.sh` does, so the
 * `docker exec` form works: the wrapper carries its own connection, and the DSN is then
 * not passed. A wrapper string is split on whitespace, which is the same limitation the
 * shell script has — it word-splits `$PSQL` too.
 *
 * @param env - Environment to read `PSQL` and `DATABASE_URL` from.
 * @returns The command to spawn and the arguments to give it.
 */
function psqlInvocation(env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const sql = [
    "select table_schema || '.' || table_name, column_name",
    "from information_schema.columns",
    `where table_schema in (${COMPARED_SCHEMAS.map((schema) => `'${schema}'`).join(", ")})`,
    "order by table_schema, table_name, ordinal_position",
  ].join(" ");
  const wrapper = env.PSQL?.trim() ?? "";
  if (wrapper !== "") {
    const [command = "", ...prefix] = wrapper.split(/\s+/).filter((part) => part !== "");
    return { command, args: [...prefix, ...psqlArgs(sql)] };
  }
  const target = env.DATABASE_URL?.trim() ?? "";
  if (target === "") {
    throw new Error(
      "schema parity needs a connection: pass one as an argument, or set DATABASE_URL (or PSQL).",
    );
  }
  return { command: "psql", args: [target, ...psqlArgs(sql)] };
}

/** Every column of a `public` or `wiki` table, read from the catalogue through `psql`. */
function readPresentColumns(env: NodeJS.ProcessEnv): PresentColumn[] {
  const { command, args } = psqlInvocation(env);
  const run = spawnSync(command, args, { encoding: "utf-8", maxBuffer: MAX_PSQL_OUTPUT });
  if (run.error !== undefined) {
    throw new Error(`could not run ${command}: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(`${command} exited ${String(run.status)}: ${(run.stderr ?? "").trim()}`);
  }
  return run.stdout
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      const [table = "", column = ""] = line.split("\t");
      return table === "" || column === "" ? [] : [{ table, column }];
    });
}

/**
 * Run the check and return its exit code.
 *
 * @param argv - Arguments after the script name; `--help` prints usage, a positional value
 * is the connection string, any other flag is a misuse.
 * @returns `0` when the database matches, `1` on drift, `2` on misuse.
 */
function main(argv: readonly string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const flag = argv.find((argument) => argument.startsWith("-"));
  if (flag !== undefined) {
    process.stderr.write(`error: unknown option: ${flag}\n`);
    return EXIT_MISUSE;
  }
  try {
    const declared = readDeclaredSurface();
    const present = readPresentColumns({ ...process.env, DATABASE_URL: argv[0] ?? process.env.DATABASE_URL });
    const report = diffSchema(declared, present);
    const text = `${formatReport(report, declared.length)}\n`;
    if (isClean(report)) process.stdout.write(text);
    else process.stderr.write(text);
    return isClean(report) ? 0 : EXIT_DRIFT;
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return EXIT_MISUSE;
  }
}

/**
 * Is this module the program Node was told to run, rather than a file something imported?
 *
 * A bare `import` of this module must NOT run the check. `test/schema-parity-check.test.ts`
 * imports the parser and the diff, and an unconditional `main()` at module scope made that
 * import — measured — exit `2` with `error: schema parity needs a connection...`, and, inside
 * a test runner, print a `schema parity: FAIL` line into the suite output and set
 * `process.exitCode = 1` on a run where every assertion passed. `scripts/apply-schemas.sh`
 * still executes the file as `node <path>/schema-parity-check.ts`, which must keep working.
 *
 * `process.argv[1]` is absent under `node -e` / `--input-type=module`, which is another
 * import-shaped invocation. Both sides go through `realpathSync` so a symlinked or
 * relatively-invoked entry still compares equal to `import.meta.url`'s file path. That
 * resolution cannot fail here: `argv[1]` is only read when it names a file Node itself just
 * loaded, and `import.meta.url` names this file, which is by definition readable.
 */
function isEntryPoint(): boolean {
  const executed = process.argv[1];
  if (executed === undefined) return false;
  const self = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  return pathToFileURL(realpathSync(executed)).href === self;
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));
