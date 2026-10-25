/**
 * @file src/dimensions/wiki/source-documents-store.ts
 * @description Row-backed replacement for `sources/` — the wiki's raw document corpus.
 *
 * ## What this replaces
 *
 * `saveSource` wrote markdown into `sources/<slug>.md` and returned the path. The
 * directory carried two jobs at once: the bytes, and the answer to "what work has
 * not been compiled yet", which `compiler/hasher.ts` derived by listing it. The
 * second is why the first could not move; with discovery from rows, the directory
 * has nothing left to do.
 *
 * ## The guarantees `saveSource` carried, kept one for one
 *
 * That function was not a plain file write, and losing any of these silently would
 * be worse than keeping the directory:
 *
 *  - **Identity, not title, is the key.** Re-ingesting the same source under a new
 *    title updates the same document. Here that is the primary key
 *    `(stack_id, source_identity)`.
 *  - **The empty-slug guard.** A title of pure punctuation cannot produce a
 *    filename, and a silently empty one would land at `sources/.md`. The guard is
 *    preserved because `filename` is stored and later read back by the compiler.
 *  - **Collision disambiguation.** Two distinct sources that slugify identically
 *    must not overwrite each other. Uniqueness of `source_identity` gives this for
 *    free: two identities are two rows, whatever their slugs.
 *  - **`unchanged` is a real answer.** Re-ingesting identical bytes (ignoring the
 *    volatile `ingestedAt`) must report `unchanged` and write nothing, because the
 *    coordinator treats that as a no-op dimension.
 *
 * ## What is deliberately NOT carried
 *
 * Symlink and confinement checks. Those exist because a path could point outside
 * the project; a row has no path to escape, so the property holds by construction
 * rather than by refusal.
 */
import { sql } from "drizzle-orm";
import type { Database } from "llmwiki-kg";
import { createHash } from "node:crypto";
import { slugify } from "../../utils/markdown.js";
import { stableContent } from "../../utils/source-writer.js";
import type { ChangeDetectionSource } from "../../compiler/hasher.js";

/** Outcome of writing one document, matching the file writer's vocabulary. */
export type SourceWriteStatus = "created" | "updated" | "unchanged";

/** A document as the compiler reads it back. */
export interface StoredSourceDocument {
  readonly sourceIdentity: string;
  readonly title: string;
  readonly filename: string;
  readonly content: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/** A row shape as the driver returns it. */
interface SourceDocumentRow extends Record<string, unknown> {
  source_identity: string;
  title: string;
  filename: string;
  content: string;
  content_hash: string;
  size_bytes: number;
}

/**
 * Bind the tenant for the duration of the transaction.
 *
 * Every statement here is tenanted, and without the binding the policy matches
 * nothing: a read returns zero rows for a Stack that has documents, and a write is
 * refused. `set_config(..., is_local = true)` is the parameterised `SET LOCAL`, so
 * the binding ends with the transaction and cannot leak onto a pooled connection.
 *
 * @param db - Connection about to run a tenanted statement.
 * @param stackId - Stack whose documents are being read or written.
 */
async function bindStack(db: Database, stackId: string): Promise<void> {
  await db.execute(sql`select set_config('app.stack_id', ${stackId}, true)`);
}

/**
 * Hash a document for change detection.
 *
 * SHA-256 over the exact bytes, because that is what `detectChanges` compares to
 * decide whether a document needs recompiling. Any normalization here would make a
 * changed document look unchanged, which is the one failure incremental
 * compilation cannot recover from: the stale page would survive forever.
 *
 * @param content - The document text.
 * @returns Lowercase hex digest.
 */
export function hashSourceContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Strip fields that must not count as a change.
 *
 * `saveSource` did the same before comparing: `ingestedAt` moves on every ingest,
 * so including it would report every re-ingest as an update and make the
 * coordinator think the dimension did work it did not do.
 *
 * @param document - Full markdown including frontmatter.
 * @returns The document with volatile frontmatter fields removed.
 */
export function stableSourceContent(document: string): string {
  return stableContent(document);
}

/**
 * Derive the filename a document is stored under.
 *
 * Preserved from the file writer for two reasons: existing compiler state keys
 * documents by filename, and the empty-slug guard is a real correctness rule rather
 * than a formatting preference — a title of pure punctuation has no filename to
 * derive.
 *
 * @param title - Human-readable title.
 * @returns A slug safe to store.
 * @throws When the title yields no slug at all.
 */
export function sourceFilename(title: string): string {
  const slug = slugify(title);
  if (!slug) {
    throw new Error(
      `Could not derive a filename from title "${title}". ` +
        "The title contains no letter or number characters. " +
        "Rename the source file to one with at least one letter or digit.",
    );
  }
  return `${slug}.md`;
}

/**
 * Write one wiki document, creating or updating by source identity.
 *
 * Runs inside a transaction so the "did it change" read and the write cannot be
 * interleaved by a concurrent ingest of the same identity.
 *
 * @param db - Database handle.
 * @param stackId - Stack that owns this document.
 * @param document - Title, full markdown (frontmatter + body), and source identity.
 * @returns The stored filename and whether anything changed.
 */
export async function saveSourceDocument(
  db: Database,
  stackId: string,
  document: { title: string; document: string; source: string },
): Promise<{ filename: string; writeStatus: SourceWriteStatus }> {
  const filename = sourceFilename(document.title);
  const contentHash = hashSourceContent(stableSourceContent(document.document));
  const sizeBytes = Buffer.byteLength(document.document, "utf-8");

  return db.transaction(async (tx) => {
    await bindStack(tx, stackId);
    const existing = await tx.execute<{ content_hash: string }>(
      sql`select content_hash from wiki.source_documents
          where stack_id = ${stackId} and source_identity = ${document.source}`,
    );
    const prior = existing[0]?.content_hash;

    // Identical bytes: report it and write nothing, so the coordinator sees a
    // no-op rather than work that did not happen. `changed_at` therefore only
    // moves when the content really changed, which is what lets `detectChanges`
    // trust it as the needs-recompiling signal.
    if (prior === contentHash) {
      return { filename, writeStatus: "unchanged" as const };
    }

    await tx.execute(sql`
      insert into wiki.source_documents
        (stack_id, source_identity, title, filename, content, content_hash, size_bytes, changed_at)
      values (${stackId}, ${document.source}, ${document.title}, ${filename},
              ${document.document}, ${contentHash}, ${sizeBytes}, now())
      on conflict (stack_id, source_identity) do update set
        title = excluded.title,
        filename = excluded.filename,
        content = excluded.content,
        content_hash = excluded.content_hash,
        size_bytes = excluded.size_bytes,
        changed_at = now()
    `);
    return { filename, writeStatus: prior === undefined ? ("created" as const) : ("updated" as const) };
  });
}

/**
 * Read every document in a Stack, ordered so a compile is reproducible.
 *
 * This is the replacement for `readdir` over `sources/`: same set, same order, but
 * the answer comes from rows.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose corpus to read.
 * @returns Documents ordered by filename.
 */
export async function listSourceDocuments(db: Database, stackId: string): Promise<StoredSourceDocument[]> {
  await bindStack(db, stackId);
  // Both the binding and an explicit predicate: under a superuser owner the policy
  // is inert, so a query relying on it alone would return every Stack's corpus.
  const rows = await db.execute<SourceDocumentRow>(
    sql`select source_identity, title, filename, content, content_hash, size_bytes
        from wiki.source_documents
        where stack_id = ${stackId}
        order by filename asc`,
  );
  return rows.map((row) => ({
    sourceIdentity: row.source_identity,
    title: row.title,
    filename: row.filename,
    content: row.content,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
  }));
}

/**
 * Adapt the document table to the compiler's change-detection seam.
 *
 * Returns the identity and the stored hash together, because handing back only
 * identities would force the compiler to re-read every document to hash it -- which
 * is the `readdir` cost this migration exists to remove.
 *
 * @param db - Database handle.
 * @param stackId - Stack whose corpus to scan.
 * @returns A source the compiler can diff against its previous state.
 */
export function sourceDocumentsChangeSource(
  db: Database,
  stackId: string,
): ChangeDetectionSource {
  return {
    list: async () => {
      const documents = await listSourceDocuments(db, stackId);
      return documents.map((doc) => ({
        sourceIdentity: doc.sourceIdentity,
        contentHash: doc.contentHash,
      }));
    },
  };
}
