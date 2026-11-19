/**
 * Fresh resolution snapshots in production concepts-then-queries scan order.
 * Retained metadata uses the shared handle-bound confinement proof and borrows
 * the streaming reader; pending records use existing candidate admission with
 * strict I/O enabled. No cache or mutation lock is owned here, so a publication
 * caller can collect fresh state while already holding its project lock.
 *
 * ## Where the pages come from, and why the caller says so
 *
 * A project's pages are either files under `wiki/` or rows in its Stack's
 * `wiki.pages`. This module used to assume the first, so on a row-backed Stack it
 * walked a directory that does not exist, produced an EMPTY index, and every
 * citation the answer made was reported broken no matter what the answer said.
 *
 * The backend is therefore an argument, not an assumption: `source` is the row
 * reader the shared seam hands a caller (`withRawPageSource`), and its absence is
 * the file mode — never a fallback, because a fallback to disk on a Stack yields
 * the empty index this module exists to stop inventing.
 *
 * ## Why an unreadable source is an ERROR
 *
 * `{ retained: [], pending: [] }` already means "this index was read and holds
 * nothing to check". A root that cannot be resolved is a different fact, and
 * collapsing it into that value is how a failed read spent a release looking like
 * a healthy empty Stack. It throws instead: see
 * {@link AnswerCitationIndexUnreadableError}.
 */
import { readdir } from "fs/promises";
import path from "path";
import type { AnswerCitationIndex, PendingCitationTarget, RetainedCitationTarget } from "./answer-types.js";
import type { PageDirectory } from "../export/types.js";
import type { RawPageSource } from "../dimensions/wiki/page-scan-source.js";
import type { RawWikiPage } from "../wiki/collect.js";
import { CONCEPTS_DIR, QUERIES_DIR } from "../utils/constants.js";
import { isInsideDir, safeRealpath } from "../utils/path-confine.js";
import { readConfinedPageWith } from "../utils/confined-read.js";
import { listCandidates } from "../compiler/candidate-read.js";
import { slugify } from "../utils/markdown.js";
import { readResolutionFrontmatter } from "./frontmatter-reader.js";

const STRICT_IO = { strictIo: true };

/**
 * The index could not be built: the caller's source was not readable.
 *
 * Deliberately NOT an empty index. An index of zero entries is a legitimate answer
 * ("this Stack has no pages yet") and every consumer already treats it as one, so the
 * unreadable case needs its own type or it cannot be told apart from a healthy one.
 *
 * The error carries the root the caller asked about, which is the only fact a
 * boundary can report without guessing why the read failed.
 */
export class AnswerCitationIndexUnreadableError extends Error {
  /**
   * @param root - The project root whose pages could not be resolved.
   */
  constructor(readonly root: string) {
    super(`the answer citation index cannot be read: ${root} is not a resolvable project root`);
    this.name = "AnswerCitationIndexUnreadableError";
  }
}

/** Preserve collector order, filename identity, and string-only viewer aliases. */
async function collectRetainedDirectory(root: string, dir: string, pageDirectory: PageDirectory): Promise<RetainedCitationTarget[]> {
  const expectedDir = path.join(root, dir);
  if (await safeRealpath(expectedDir, STRICT_IO) !== expectedDir) return [];
  const retained: RetainedCitationTarget[] = [];
  for (const file of await directoryFiles(expectedDir)) {
    if (!file.endsWith(".md")) continue;
    const real = await safeRealpath(path.join(expectedDir, file), STRICT_IO);
    if (!real || !isInsideDir(real, expectedDir)) continue;
    const read = await readConfinedPageWith(real, expectedDir, readResolutionFrontmatter, STRICT_IO);
    if (read.kind === "unreadable") throw read.cause;
    if (read.kind !== "ok") continue;
    const slug = file.slice(0, -3);
    const aliases = Array.isArray(read.value.aliases)
      ? read.value.aliases.filter((alias): alias is string => typeof alias === "string") : [];
    retained.push({ id: `${pageDirectory}/${slug}`, pageDirectory, slug, aliases });
  }
  return retained;
}

/** Directory disappearance is benign; genuine listing failures are not. */
async function directoryFiles(dir: string): Promise<string[]> {
  try { return await readdir(dir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Project the row source's pages into retained targets, in the source's order.
 *
 * The identity is `<directory>/<slug>`, the same string the disk walk mints and the
 * viewer's `PageId`, because a bare slug cannot name a page: `concepts/alpha` and
 * `queries/alpha` are two pages. Aliases are read from the SAME carrier the disk walk
 * reads (`frontmatter.aliases`, string entries only), so a citation naming a declared
 * alias resolves identically on both backends.
 *
 * @param pages - Pages as the raw source reported them, concepts before queries.
 * @returns Retained targets in the order given.
 */
function retainedFromRawPages(pages: readonly RawWikiPage[]): RetainedCitationTarget[] {
  return pages.map((page) => ({
    id: `${page.pageDirectory}/${page.slug}`,
    pageDirectory: page.pageDirectory,
    slug: page.slug,
    aliases: Array.isArray(page.frontmatter.aliases)
      ? page.frontmatter.aliases.filter((alias): alias is string => typeof alias === "string") : [],
  }));
}

/**
 * Admitted proposals that could still become a default page, in queue order.
 *
 * @param root - Project root; the candidate queue is read through the same root.
 * @returns Pending targets for the report to match against.
 */
async function collectPendingTargets(root: string): Promise<PendingCitationTarget[]> {
  const candidates = await listCandidates(root, STRICT_IO);
  return candidates.filter((candidate) => !candidate.targetEntityType
    && (candidate.targetDirectory === undefined || candidate.targetDirectory === "concepts" || candidate.targetDirectory === "queries")
    // Approval writes the literal filename slug: normalization must not invent a
    // future target that the production bare-slug resolver could never match.
    && candidate.slug.length > 0 && slugify(candidate.slug) === candidate.slug)
    .map((candidate) => ({ target: candidate.slug, candidateId: candidate.id }));
}

/**
 * Collect resolution metadata without caching or acquiring a project lock.
 *
 * @param root - Project root. Read for pending proposals in both modes, and for pages
 *   only in the file mode.
 * @param source - The row page reader the caller's seam resolved, or `undefined` to
 *   walk `wiki/` on disk. Omitted, every read is the file read it always was.
 * @returns Retained pages and admitted proposals, concepts before queries.
 * @throws {AnswerCitationIndexUnreadableError} when no `source` was supplied and `root`
 *   cannot be resolved, because then nothing was read at all and an empty index would
 *   claim otherwise.
 */
export async function collectAnswerCitationIndex(
  root: string,
  source?: RawPageSource,
): Promise<AnswerCitationIndex> {
  if (source !== undefined) {
    // Row-backed: the pages are rows, so the disk walk is not attempted and a root
    // that a Stack deployment does not have cannot fail the read.
    return { retained: retainedFromRawPages(await source.collect()), pending: await collectPendingTargets(root) };
  }
  const canonicalRoot = await safeRealpath(root, STRICT_IO);
  if (canonicalRoot === null) throw new AnswerCitationIndexUnreadableError(root);
  const concepts = await collectRetainedDirectory(canonicalRoot, CONCEPTS_DIR, "concepts");
  const queries = await collectRetainedDirectory(canonicalRoot, QUERIES_DIR, "queries");
  return { retained: [...concepts, ...queries], pending: await collectPendingTargets(canonicalRoot) };
}
