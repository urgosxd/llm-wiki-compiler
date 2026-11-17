/**
 * @file packages/api/src/host/stacks-declaration.ts
 * @description The optional Stack declaration a boot can seed from, and the ONE write it performs.
 *
 * ## A PROVISIONING input, never a RESOLUTION input
 *
 * The file this module reads creates rows. It never tells a request which Stack to serve: once a
 * declared Stack exists, every request afterwards reads it from the database like any other Stack,
 * by naming it. Nothing here is cached, remembered, or consulted again, so a Stack an operator
 * edits through `PATCH /stacks/:id` is the row every later request sees. That distinction is why the
 * flag is explicit at the deploy's call site instead of ambient in the environment: an environment
 * variable would be inherited by every process that never asked to provision anything.
 *
 * ## Why it exists at all, given `POST /stacks` is the primary path
 *
 * It is for an UNATTENDED container deploy, where nobody is present to send the first POST. That is
 * its only justification, and it is not the normal path: a deployment whose operator is awake creates
 * its first Stack over HTTP and never writes a declaration.
 *
 * ## SEED ONLY: an existing domain is a no-op, never an update
 *
 * Each declared Stack is inserted with `on conflict (domain) do nothing`, so a domain that already
 * exists keeps the row it has — name, description, ontology and all. `on conflict ... do update`
 * would let a restart silently revert an operator's edits, which is exactly the guarantee S2 of
 * `odd/tasks/stack-authority-per-request.md` forbids.
 *
 * ## ONE transaction, so a bad element seeds nothing
 *
 * The whole declaration is applied inside a single transaction. A refusal from the database part-way
 * through rolls back everything already written, and a declaration that does not VALIDATE is refused
 * before a connection is even built. There is no state in which a boot has seeded half a declaration.
 *
 * ## Refusals come out as the existing boot failure shape
 *
 * Every failure here throws, so `main.ts`'s `formatFailure` turns it into `Error: <message>` on
 * stderr and exit 1: a missing file, an unreadable file, malformed JSON, an element the HTTP schema
 * refuses, a database that refuses the write, and a declaration handed to a run with no database
 * configured. A boot never starts partially seeded and never ignores a declaration it could not apply.
 *
 * ## Row-level security, and why the domain is bound before each insert
 *
 * `stacks` carries ONE `FOR ALL` policy in `packages/llmwiki-kg/db/migration_rls_tenancy.sql:99-103`
 * whose `WITH CHECK` is omitted, so Postgres validates the row being written against the same `USING`
 * predicate — and creating a Stack is the one write where the row IS the tenant, so there is no
 * `app.stack_id` to bind yet. The binding this module makes is `app.stack_domain`, transaction-local,
 * before each insert, which is what `bindCreatingStackDomain`
 * (`packages/llmwiki-kg/ts/src/core/stack_resolver.ts:158`) does for `POST /stacks` and what the
 * deleted `ensureDefaultStack` did before its own insert.
 *
 * It is a no-op while the connection bypasses RLS — measured, and documented at
 * `migration_rls_tenancy.sql:14-21` — which is why it is safe on a database whose role is still the
 * DDL owner, and load-bearing the moment that role is the `llmwiki_app` one.
 */

import { readFile } from "node:fs/promises";
import { sql, type SQL } from "drizzle-orm";
import type { DatabaseHandle } from "@repo/foundation";
import {
  AKS_DATABASE_URL_ENV_VAR,
  createDimensionsDatabase,
  isDatabaseConfigured,
} from "@repo/wiki/dimensions-activation";
// A RELATIVE SPECIFIER INTO THE KG PACKAGE, and the one place this package reads its DTOs from
// source: `@repo/kg`'s exports map publishes no `./dto` subpath, and the element schema this loader
// must use is `StackCreate` itself. Importing anything else here — a copy of the schema, a loosened
// object — is the drift S8 forbids. `@repo/api` is the sanctioned joiner, so eslint's api zone
// permits the edge.
import { StacksDeclaration } from "../../../llmwiki-kg/ts/src/dto.js";

/** The boot flag this module serves, spelled once so `main.ts` cannot drift from the refusal text. */
export const STACKS_DECLARATION_FLAG = "--stacks-declaration";

/** One Stack as the declaration parsed it: exactly what `POST /stacks` would have received. */
type DeclaredStack = ReturnType<typeof StacksDeclaration.parse>["stacks"][number];

/** How many rejected elements one refusal names before summarising the rest. */
const MAX_REPORTED_ISSUES = 5;

/** A declaration this boot cannot apply: the message is the whole diagnostic. */
class StackDeclarationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "StackDeclarationError";
  }
}

/** Narrow a caught value to a message worth appending to ours. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Render a Zod issue's path the way a reader of a nested document would write it.
 *
 * `["stacks", 1, "domain"]` becomes `stacks[1].domain`, so a refusal names the element and the field
 * inside it rather than a positional list nobody can map back to the file.
 *
 * @param path - The issue's path segments.
 * @returns The dotted, bracketed path.
 */
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === "number"
        ? `${text}[${segment}]`
        : text === ""
          ? String(segment)
          : `${text}.${String(segment)}`,
    "",
  );
}

/**
 * Read the declaration file, refusing by name when it cannot be opened.
 *
 * @param declarationPath - The path the flag named.
 * @returns The file's bytes, decoded as UTF-8.
 * @throws {StackDeclarationError} When the file is missing or unreadable.
 */
async function readDeclarationText(declarationPath: string): Promise<string> {
  try {
    return await readFile(declarationPath, "utf8");
  } catch (error) {
    throw new StackDeclarationError(
      `The Stack declaration at "${declarationPath}" could not be read: ${messageOf(error)}.`,
      { cause: error },
    );
  }
}

/**
 * Parse the file's text as JSON, refusing by name when it is not JSON.
 *
 * @param declarationPath - The path the flag named, for the message.
 * @param text - The file's contents.
 * @returns The parsed document, still unvalidated.
 * @throws {StackDeclarationError} When the text is not valid JSON.
 */
function parseDeclaration(declarationPath: string, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StackDeclarationError(
      `The Stack declaration at "${declarationPath}" is not valid JSON: ${messageOf(error)}.`,
      { cause: error },
    );
  }
}

/**
 * The refusal text for a document the HTTP schema would not have accepted either.
 *
 * @param declarationPath - The path the flag named.
 * @param issues - Every issue Zod reported, in document order.
 * @returns One sentence naming the elements and fields that failed.
 */
function invalidDeclarationMessage(
  declarationPath: string,
  issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>,
): string {
  const reported = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${pathOf(issue.path)}: ${issue.message}`);
  const remaining = issues.length - reported.length;
  const more = remaining > 0 ? `; and ${remaining} more` : "";
  return `The Stack declaration at "${declarationPath}" is not a valid declaration: ${reported.join("; ")}${more}.`;
}

/**
 * Read and validate a declaration, without touching any database.
 *
 * Validation happens FIRST and completely, so a document with one bad element is refused before a
 * connection is built rather than after the good elements have been written.
 *
 * @param declarationPath - The path the flag named.
 * @returns Every declared Stack, each already the shape `POST /stacks` accepts.
 * @throws {StackDeclarationError} When the file is missing, unreadable, not JSON, or not a declaration.
 */
async function readStacksDeclaration(declarationPath: string): Promise<readonly DeclaredStack[]> {
  const parsed = StacksDeclaration.safeParse(
    parseDeclaration(declarationPath, await readDeclarationText(declarationPath)),
  );
  if (!parsed.success) {
    throw new StackDeclarationError(invalidDeclarationMessage(declarationPath, parsed.error.issues));
  }
  return parsed.data.stacks;
}

/**
 * Renders a Stack's ontology as the jsonb value an insert should store.
 *
 * A deliberate copy of the private helper the HTTP route uses
 * (`packages/llmwiki-kg/ts/src/routes/stacks.ts:148`), for the reason documented there: drizzle hands
 * a JS object to its parameter binder in a form Postgres refuses, while a JSON string cast to `jsonb`
 * arrives as a jsonb *object*. `undefined` and `null` both mean "no declaration" and become SQL NULL,
 * never the JSON document `null`.
 *
 * @param ontology - The parsed declaration field; absent and null are equivalent.
 * @returns A `jsonb`-cast fragment, or SQL NULL when there is no declaration.
 */
function ontologyLiteral(ontology: unknown): SQL | null {
  return ontology === undefined || ontology === null ? null : sql`${JSON.stringify(ontology)}::jsonb`;
}

/**
 * Insert ONE declared Stack, and create nothing when its domain is already taken.
 *
 * The domain binding comes first, for the row-level-security reason the module header states; the
 * `on conflict (domain) do nothing` is what makes a declared domain an operator has since renamed a
 * no-op rather than a revert.
 *
 * @param tx - The declaration's transaction.
 * @param stack - One validated declaration element.
 */
async function seedOneStack(tx: DatabaseHandle, stack: DeclaredStack): Promise<void> {
  await tx.execute(sql`select set_config('app.stack_domain', ${stack.domain}, true)`);
  await tx.execute(sql`
    insert into stacks (name, domain, description, scope,
                        compilation_strategy, synthesize_descriptions, ontology)
    values (${stack.name}, ${stack.domain}, ${stack.description},
            ${stack.scope}, ${stack.compilation_strategy},
            ${stack.synthesize_descriptions}, ${ontologyLiteral(stack.ontology)})
    on conflict (domain) do nothing
  `);
}

/**
 * Apply every declared Stack inside ONE transaction.
 *
 * @param tx - The transaction the whole declaration is applied in.
 * @param stacks - The validated declaration, in document order.
 */
async function seedAllStacks(tx: DatabaseHandle, stacks: readonly DeclaredStack[]): Promise<void> {
  for (const stack of stacks) await seedOneStack(tx, stack);
}

/**
 * Refuse a declaration that has no database to be seeded into.
 *
 * Read through `isDatabaseConfigured`, the one predicate that answers "is there a database behind
 * this run", so a declaration and the Stack authority cannot disagree about which mode the process is
 * in. A declaration that cannot be applied is refused rather than silently dropped: the operator
 * asked for rows, and a boot that ignores the request is the silent behaviour this feature exists to
 * end.
 *
 * @param env - The process environment.
 * @throws {StackDeclarationError} When no database is configured.
 */
function requireDatabase(env: NodeJS.ProcessEnv): void {
  if (isDatabaseConfigured(env)) return;
  throw new StackDeclarationError(
    `${STACKS_DECLARATION_FLAG} requires a database, and ${AKS_DATABASE_URL_ENV_VAR} is not configured, ` +
      `so a declaration would have nowhere to be seeded.`,
  );
}

/**
 * Seed the Stacks a declaration names, then release the connection it opened.
 *
 * @param declarationPath - The path the flag named.
 * @param env - Environment the database is built from; defaults to `process.env`.
 * @throws {StackDeclarationError} On any refusal: no database, an unreadable or invalid declaration,
 *   or a database that refuses the write.
 */
export async function seedDeclaredStacks(
  declarationPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  requireDatabase(env);
  const stacks = await readStacksDeclaration(declarationPath);
  const database = createDimensionsDatabase(env);
  try {
    await database.db.transaction((tx) => seedAllStacks(tx, stacks));
  } catch (error) {
    throw new StackDeclarationError(
      `The Stack declaration at "${declarationPath}" could not be seeded: ${messageOf(error)}.`,
      { cause: error },
    );
  } finally {
    await database.close();
  }
}
