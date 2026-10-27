/**
 * @file src/dimensions/wiki/store-dimension.ts
 * @description The wiki dimension writing to Postgres instead of the filesystem
 * (W3.2), keeping every protection `saveSource` already carries.
 *
 * ## Why this exists beside `index.ts` rather than replacing it
 *
 * W3.4 requires the file-backed implementation to stay selectable, so the two are
 * siblings behind the same `Dimension` contract and the caller picks. `index.ts`
 * keeps the journal-based rollback that makes a filesystem write revertible; this
 * one does not need a journal at all, because a transaction IS the rollback.
 *
 * ## The protections this must not lose
 *
 * `saveSource` (`utils/source-writer.ts:158`) is not a file write — it is three
 * rules that took bugs to learn:
 *
 *   1. **The empty-slug guard.** A title of pure punctuation slugifies to `""`, and
 *      without the guard the file lands at `sources/.md`. Here the same guard
 *      applies before anything touches the database, because a `"".` slug would
 *      become a page no reader ever lists.
 *   2. **Basename-collision suffixing.** Two different sources with the same title
 *      must not overwrite each other. On the filesystem that is a `-1`, `-2`
 *      filename suffix; here it is the same suffix on the slug.
 *   3. **Source identity as the key, not the slug.** Re-ingesting the same source
 *      under a changed title updates the existing page instead of forking a new
 *      one. The filesystem version scans frontmatter for the identity; here the
 *      identity is stored in the row, so the lookup is a query instead of a scan.
 *
 * Rule 3 is why `source_identity` is a column rather than being folded into the
 * slug: with it, "does this source already have a page?" is one indexed lookup
 * instead of reading every page and parsing its frontmatter.
 *
 * ## The source markdown is a PROJECTION, run after the commit
 *
 * The rows go to Postgres; the raw markdown still goes to `sources/`. That looks
 * like the migration failing halfway, and for now it is exactly that --
 * deliberately. `compile` is not migrated (it discovers work by hashing
 * `sources/`, `compiler/hasher.ts:34-43`), and the ingest caller refuses an outcome
 * without an `artifactPath` (`services/ingest/service.ts:120`), so a dimension that
 * wrote only a row would break both.
 *
 * What changed with atomic ingest is WHERE that write happens. It cannot join the
 * transaction -- no ordering makes a `writeFile` participate in a COMMIT -- so it
 * runs in `afterCommit`, owned by `source-projection.ts`, and compensates itself if
 * it fails. The consequence worth naming: when the transaction fails, the file was
 * never touched, so cleaning up a failed ingest costs nothing instead of deleting
 * content a previous ingest produced.
 *
 * ## Why prepare/commit is still two steps even though a transaction is atomic
 *
 * The coordinator's contract is prepare-then-commit across EVERY dimension, and
 * dimensions commit in a fixed order. A postgres transaction cannot stay open while
 * another dimension runs its own work — that would hold locks across an arbitrary
 * delay and, worse, make the commit order depend on lock timing. So `prepare` only
 * computes what would be written and `commit` performs it in one transaction. A
 * prepared-but-uncommitted page has nothing to undo, which is why `discard` here is
 * a no-op, exactly as in the KG dimension.
 */

import { sql } from "drizzle-orm";

import { slugify } from "../../utils/markdown.js";
import { saveSourceDocument } from "./source-documents-store.js";
import { projectSourceMarkdown } from "./source-projection.js";
import type { WriteStatus } from "../../utils/types.js";
import type {
  CommittedWrite,
  CommitScope,
  Dimension,
  DimensionInput,
  PreparedWrite,
} from "../types.js";
import { wikiIdempotencyKey } from "./idempotency.js";
import { withTenant } from "./page-store.js";
import type { Database } from "llmwiki-kg";

/** Directory compiled concept pages live in. */
const CONCEPTS_DIRECTORY = "concepts";

/** What `prepare` worked out; carried to `commit` as the opaque handle. */
interface StoredWikiWrite {
  readonly input: DimensionInput;
  readonly slug: string;
  readonly writeStatus: WriteStatus;
}

/** What a stack's existing page for one source identity looks like. */
interface ExistingPage {
  readonly slug: string;
  readonly body: string;
}

/**
 * The slug the empty-slug guard demands.
 *
 * Same rule and same message as `saveSource`: a title of pure punctuation has no
 * derivable filename, and silently storing it under `""` would create a page that
 * exists in the table and appears in no listing.
 *
 * @param title - Source title.
 * @returns The slug.
 * @throws When the title yields no usable slug.
 */
function requireSlug(title: string): string {
  const slug = slugify(title);
  if (!slug) {
    throw new Error(
      `Could not derive a filename from title "${title}". ` +
        `The title contains no letter or number characters. ` +
        `Rename the source file to one with at least one letter or digit.`,
    );
  }
  return slug;
}

/**
 * The page already stored for this source identity, if any.
 *
 * Scoped by `stack_id` explicitly as well as by the bound GUC, for the reason
 * `page-store.ts` documents: RLS is inert under a bypassing role, so the explicit
 * predicate is the guarantee.
 *
 * @param db - Database handle.
 * @param stackId - The tenant.
 * @param source - Source identity.
 * @returns The existing page, or `undefined`.
 */
async function findPageBySource(
  db: Database,
  stackId: string,
  source: string,
): Promise<ExistingPage | undefined> {
  return withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<{ slug: string; body: string }>(sql`
      select slug, body from wiki.pages
      where stack_id = ${stackId}
        and page_directory = ${CONCEPTS_DIRECTORY}
        and source_identity = ${source}
    `);
    return rows[0];
  });
}

/**
 * A slug that does not collide with a DIFFERENT source's page.
 *
 * Mirrors `resolveCollisionFreeFilename`: the same title from two sources must
 * produce two pages, suffixed `-1`, `-2`, and so on. Returns `slug` untouched when
 * the only existing holder is the same source, which is what keeps a re-ingest
 * under a changed title updating in place rather than forking.
 *
 * @param db - Database handle.
 * @param stackId - The tenant.
 * @param slug - The desired slug.
 * @param source - The source asking for it.
 * @returns A collision-free slug.
 */
async function resolveFreeSlug(
  db: Database,
  stackId: string,
  slug: string,
  source: string,
): Promise<string> {
  const taken = await withTenant(db, stackId, async (tx) => {
    const rows = await tx.execute<{ slug: string; source_identity: string | null }>(sql`
      select slug, source_identity from wiki.pages
      where stack_id = ${stackId} and page_directory = ${CONCEPTS_DIRECTORY}
        and (slug = ${slug} or slug like ${`${slug}-%`})
    `);
    return rows;
  });

  const ownedByThisSource = taken.find((row) => row.source_identity === source);
  if (ownedByThisSource !== undefined) return ownedByThisSource.slug;

  const used = new Set(taken.map((row) => row.slug));
  if (!used.has(slug)) return slug;

  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** What the database-backed wiki dimension needs to exist. */
export interface WikiStoreDimensionOptions {
  /** The tenant whose pages this dimension writes. */
  readonly stackId: string;
  /** Database handle; the pooled one in production, a test's own in tests. */
  readonly db: Database;
  /**
   * Project root whose `sources/` the raw markdown is ALSO written to.
   *
   * Required rather than optional, for the reason in the file header: an
   * `IngestOutcome` without an `artifactPath` throws at
   * `services/ingest/service.ts:120`, so a dimension that cannot produce one
   * makes every ingest fail. Making this optional would move that failure from
   * the constructor, where it is visible, to the first ingest, where it is not.
   */
  readonly root: string;
}

/**
 * Work out what a write would do, without making anything visible.
 *
 * Two lookups: the page this source already owns (identity is the key, so a
 * re-ingest under a changed title updates in place), and otherwise a slug no OTHER
 * source holds.
 *
 * @param options - Tenant binding and database handle.
 * @param input - Source identity, title and document.
 * @returns The handle `commit` acts on, and whether this is a no-op.
 */
async function prepareWikiWrite(
  options: WikiStoreDimensionOptions,
  input: DimensionInput,
): Promise<PreparedWrite> {
  const desired = requireSlug(input.title);
  const existing = await findPageBySource(options.db, options.stackId, input.source);

  if (existing !== undefined) {
    const unchanged = existing.body === input.body;
    const handle: StoredWikiWrite = {
      input,
      slug: existing.slug,
      writeStatus: unchanged ? "unchanged" : "updated",
    };
    return { unchanged, handle };
  }

  const slug = await resolveFreeSlug(options.db, options.stackId, desired, input.source);
  const handle: StoredWikiWrite = { input, slug, writeStatus: "created" };
  return { unchanged: false, handle };
}

/**
 * Write the source document row -- EVERY ingest, including an unchanged one.
 *
 * The two stores start empty relative to each other: a project migrating in has
 * files but no rows, so skipping the row because the FILE was unchanged would leave
 * the compiler seeing a Stack with zero documents and retiring every one of them.
 * `saveSourceDocument` is idempotent and reports `unchanged` on identical bytes, so
 * this costs one query, not a rewrite.
 *
 * @param options - Tenant binding and database handle.
 * @param handle - What `prepare` worked out.
 * @param tx - Coordinator's transaction to join, when it owns one.
 */
async function commitSourceDocument(
  options: WikiStoreDimensionOptions,
  handle: StoredWikiWrite,
  tx: Database | undefined,
): Promise<void> {
  await saveSourceDocument(
    options.db,
    options.stackId,
    {
      title: handle.input.title,
      document: handle.input.document,
      source: handle.input.source,
    },
    tx,
  );
}

/**
 * Upsert the compiled page row, unless this ingest is a no-op.
 *
 * @param options - Tenant binding and database handle.
 * @param handle - What `prepare` worked out.
 * @param tx - Coordinator's transaction to join, when it owns one.
 */
async function commitPageRow(
  options: WikiStoreDimensionOptions,
  handle: StoredWikiWrite,
  tx: Database | undefined,
): Promise<void> {
  // Reporting `unchanged` is what tells the coordinator this dimension did no work,
  // so an unchanged ingest writes no page row at all.
  if (handle.writeStatus === "unchanged") return;
  await withTenant(
    options.db,
    options.stackId,
    async (tenantTx) => {
      await tenantTx.execute(sql`
        insert into wiki.pages
          (stack_id, page_directory, slug, title, summary, body, source_identity)
        values (
          ${options.stackId}, ${CONCEPTS_DIRECTORY}, ${handle.slug},
          ${handle.input.title}, ${""}, ${handle.input.body}, ${handle.input.source}
        )
        on conflict (stack_id, page_directory, slug) do update set
          title = excluded.title,
          body = excluded.body,
          source_identity = excluded.source_identity,
          updated_at = now()
      `);
    },
    tx,
  );
}

/**
 * Build the wiki dimension backed by Postgres for one tenant.
 *
 * @param options - Tenant binding, database handle, and the root for `sources/`.
 * @returns The dimension.
 */
export function createWikiStoreDimension(options: WikiStoreDimensionOptions): Dimension {
  return {
    name: "wiki",

    prepare: async (input: DimensionInput): Promise<PreparedWrite> =>
      prepareWikiWrite(options, input),

    async commit(prepared: PreparedWrite, scope?: CommitScope): Promise<CommittedWrite> {
      const handle = prepared.handle as StoredWikiWrite;
      const tx = scope?.tx as Database | undefined;

      // THE ROWS, inside the coordinator's transaction when it supplied one. Order
      // between the two statements is free now: the transaction makes both
      // invisible until COMMIT.
      await commitSourceDocument(options, handle, tx);
      await commitPageRow(options, handle, tx);

      return {
        idempotencyKey: wikiIdempotencyKey(handle.input),
        summary: `wiki:${handle.writeStatus}`,
        writeStatus: handle.writeStatus,
        // `artifactPath` is deliberately ABSENT: the real one comes from the
        // PROJECTION below, which runs after the commit because no ordering makes a
        // writeFile participate in a COMMIT. Setting it here would be a second,
        // wrong answer to the same question -- the stored filename is not a path.
        afterCommit: async () => {
          const projected = await projectSourceMarkdown(options.root, handle.input);
          return {
            artifactPath: projected.artifactPath,
            // The page's verdict stays authoritative for the coordinator's no-op
            // decision; the projection only reports where the bytes went.
            writeStatus: handle.writeStatus,
          };
        },
      };
    },

    async discard(): Promise<void> {
      // Nothing to undo: `prepare` only reads and computes. The graph dimension
      // documents the same reasoning -- a prepared-but-uncommitted write has no
      // visible effect, so a transaction is not left open across the coordinator.
    },

    async forget(): Promise<void> {
      // DELIBERATELY A NO-OP, matching the filesystem dimension. `compile` owns the
      // removal story for the wiki: it detects a vanished source and marks the
      // pages only it owned as orphaned, preserving content other sources still
      // support. Deleting rows here as well would be a second answer to the same
      // question, and the two would disagree the moment orphan rules change.
    },
  };
}
