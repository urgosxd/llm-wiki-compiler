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
 * ## Why this ALSO writes the source markdown (the L1 bridge)
 *
 * The page goes to Postgres; the raw markdown still goes to `sources/` through
 * `saveSource`, and its path is returned as `artifactPath`. That looks like the
 * migration failing halfway, and for now it is exactly that -- deliberately.
 *
 * `compile` is not migrated. It discovers work by hashing `sources/`
 * (`compiler/hasher.ts:34-43`), so a dimension that wrote only a row would be
 * invisible to it and the ingest -> compile path would silently die. And the
 * ingest caller refuses an outcome without an `artifactPath`
 * (`services/ingest/service.ts:120`), so a dimension that returns none breaks
 * every ingest outright.
 *
 * The split is therefore the plan's own layering, not an oversight: L2 (compiled
 * pages) is in the database from here on, and L1 (raw bytes) stays on disk until
 * Wave 4 moves it. `schema.sql` already says the same thing about why `body` is
 * stored inline while L1 waits.
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
import { saveSource } from "../../utils/source-writer.js";
import { saveSourceDocument } from "./source-documents-store.js";
import type { WriteStatus } from "../../utils/types.js";
import type {
  CommittedWrite,
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
interface StoredWriteHandle {
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
 * Build the wiki dimension backed by Postgres for one tenant.
 *
 * @param options - Tenant binding, database handle, and the root for `sources/`.
 * @returns The dimension.
 */
export function createWikiStoreDimension(options: WikiStoreDimensionOptions): Dimension {
  return {
    name: "wiki",

    async prepare(input: DimensionInput): Promise<PreparedWrite> {
      const desired = requireSlug(input.title);
      const existing = await findPageBySource(options.db, options.stackId, input.source);

      // An existing page for this source updates in place regardless of title:
      // the identity is the key, exactly as `saveSource` treats it.
      if (existing !== undefined) {
        const unchanged = existing.body === input.body;
        const handle: StoredWriteHandle = {
          input,
          slug: existing.slug,
          writeStatus: unchanged ? "unchanged" : "updated",
        };
        return { unchanged, handle };
      }

      const slug = await resolveFreeSlug(options.db, options.stackId, desired, input.source);
      const handle: StoredWriteHandle = { input, slug, writeStatus: "created" };
      return { unchanged: false, handle };
    },

    async commit(prepared: PreparedWrite): Promise<CommittedWrite> {
      const handle = prepared.handle as StoredWriteHandle;

      // THE SOURCE MARKDOWN FIRST, and always -- not only when the page changed.
      //
      // Two reasons, both load-bearing while L1 is still on disk. The ingest
      // caller throws when `artifactPath` is undefined
      // (`services/ingest/service.ts:120`), so this dimension MUST return one.
      // And `compile` discovers work by hashing `sources/`
      // (`compiler/hasher.ts:34-43`), so an ingest that only wrote a row would be
      // invisible to the compiler and the ingest->compile path would be dead.
      //
      // Deliberately before the row insert: `saveSource` owns the empty-slug and
      // basename-collision guards and can throw, and a throw here must not leave a
      // page row pointing at a source file that does not exist. `saveSource` is
      // itself idempotent, so re-writing identical bytes reports "unchanged"
      // rather than touching the file.
      const saved = await saveSource(
        options.root,
        handle.input.title,
        handle.input.document,
        handle.input.source,
      );

      // Write the row on EVERY ingest, including one the file writer called
      // unchanged. The two stores start empty relative to each other: a project
      // migrating in has files but no rows, so skipping the row because the FILE
      // was unchanged would leave the compiler seeing a Stack with zero documents
      // and retiring every one of them. `saveSourceDocument` is idempotent and
      // reports `unchanged` on identical bytes, so this costs one query, not a
      // rewrite.
      await saveSourceDocument(options.db, options.stackId, {
        title: handle.input.title,
        document: handle.input.document,
        source: handle.input.source,
      });

      // An unchanged page still commits, but writes nothing: reporting `unchanged`
      // is what tells the coordinator this dimension was a no-op.
      if (handle.writeStatus !== "unchanged") {
        await withTenant(options.db, options.stackId, async (tx) => {
          await tx.execute(sql`
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
        });
      }

      return {
        idempotencyKey: wikiIdempotencyKey(handle.input),
        summary: `wiki:${handle.writeStatus}`,
        writeStatus: handle.writeStatus,
        artifactPath: saved.path,
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
