/**
 * Embedding store shape and persistence.
 *
 * Owns the logical embedding contract (types, version, read/write facade) and
 * the active embedding CONFIGURATION resolution — the
 * provider backend, endpoint, and model that together tag and validate a store.
 * No retrieval or embedding logic lives here — this is the base module every
 * other embeddings-* module uses. Format selection and atomic persistence live
 * in embeddings-storage.ts; logical v1/v2/v3 migration remains unchanged.
 *
 * Confinement + resource-cap policy (B1):
 *  - READ: no mkdir on clean projects; no-follow, size-capped reads select an
 *    authoritative binary leaf before legacy JSON. Refusal never revives JSON.
 *  - WRITE: small stores retain JSON; oversized stores automatically use one
 *    binary container. Binary limits are enforced before atomic replacement.
 *  - Field caps and identity filtering handled by embeddings-validate.ts.
 *
 * Version-discriminated access (B3, §4.3):
 *  - {@link parseEmbeddingStore} — structural version discriminator; does NOT run
 *    v3-only id/grammar validation. Unknown/malformed → null.
 *  - {@link validateV3ForSearch} — strict read-time validator; shared vector/integrity
 *    checks for any version PLUS a v3-only pageId/embeddingTextHash grammar stub.
 *  - {@link readStoreForUpdate} — write-path read; accepts a v2 store WITHOUT
 *    calling validateV3ForSearch on it, so migration can transform it safely.
 */

import { NoFollowOpenError, openFileNoFollow } from "./no-follow-open.js";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "path";
import {
  getActiveEmbeddingProviderName,
  hasEmbeddingConfigurationOverride,
  resolveEmbeddingBackend,
  resolveEmbeddingEndpoint,
} from "./embedding-provider.js";
import {
  EMBEDDINGS_FILE,
  EMBEDDING_MIN_SIMILARITY,
  EMBEDDING_MODELS,
  MAX_EMBEDDING_STORE_BYTES,
} from "./constants.js";
import { assertEmbeddingStoreValid, filterMalformedIdentities, assertFieldCaps } from "./embeddings-validate.js";
import { resolveExistingConfinedPrivateDir } from "./private-dir.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";
import { readStoredEmbeddings, persistEmbeddingStore, type ParsedStore } from "./embeddings-storage.js";
import type { EmbeddingStoreSink } from "./embeddings-storage.js";

export type { EmbeddingStoreSink };

import type { EmbeddingStoreSource } from "./embeddings-load.js";
export { parseEmbeddingStore, type ParsedStore } from "./embeddings-storage.js";
export { EmbeddingStoreFullError } from "./embeddings-errors.js";

/**
 * Current store version. Bumped 1 → 2 when chunk entries were added, and
 * 2 → 3 when records were re-keyed from a bare `slug` to a qualified `pageId`
 * (`<namespace>/<page-part>`) and a page `embeddingTextHash` was added. The live
 * writer now persists v3; v1/v2 stores on disk are migrated on the next write.
 */
export const STORE_VERSION = 3 as const;

/** A single embedded page record. */
export interface EmbeddingEntry {
  slug: string;
  title: string;
  summary: string;
  vector: number[];
  updatedAt: string;
}

/** A single embedded chunk drawn from a page body. */
export interface ChunkEmbeddingEntry {
  slug: string;
  title: string;
  chunkIndex: number;
  contentHash: string;
  text: string;
  vector: number[];
  updatedAt: string;
}

/** Root shape of .llmwiki/embeddings.json. */
export interface EmbeddingStore {
  version: 1 | 2;
  model: string;
  dimensions: number;
  entries: EmbeddingEntry[];
  /** Optional in v2 stores; absent in v1 stores. */
  chunks?: ChunkEmbeddingEntry[];
}

// ---------------------------------------------------------------------------
// v3 record types
// ---------------------------------------------------------------------------

/**
 * A single page embedding record in a v3 store.
 * Uses a qualified `pageId` (`<namespace>/<page-part>`) instead of a bare slug,
 * and includes an `embeddingTextHash` covering the exact text sent to the provider.
 */
export interface PageEmbeddingV3 {
  pageId: PageId;
  title: string;
  summary: string;
  /** SHA-256 (hex) of the exact string passed to the embedding provider. */
  embeddingTextHash: string;
  vector: number[];
  updatedAt: string;
}

/**
 * A single chunk embedding record in a v3 store.
 * Chunk identity is always the pair `(pageId, chunkIndex)` — never a
 * delimited string like `${pageId}#${chunkIndex}`.
 */
export interface ChunkEmbeddingV3 {
  pageId: PageId;
  title: string;
  /** Zero-based chunk position within the page body. */
  chunkIndex: number;
  /** SHA-256 (hex) of the chunk text (for hash-based reuse). */
  contentHash: string;
  text: string;
  vector: number[];
  updatedAt: string;
}

/** Logical root shape of a v3 embedding store in either encoding. */
export interface EmbeddingStoreV3 {
  version: 3;
  model: string;
  /**
   * Identity of the configuration that produced these vectors — see
   * {@link resolveEmbeddingFingerprint}. Optional: a store written before this
   * field existed has none, and is compared on `model` alone so upgrading does
   * not force an unrequested re-embed of the whole wiki.
   */
  fingerprint?: string;
  /**
   * Cosine floor this store's own vectors treat as "no signal", measured for the
   * model that produced them. Absent means uncalibrated: the reader must NOT filter,
   * because a guessed floor returns zero pages instead of a weaker answer.
   *
   * Persisted alongside the vectors so a reader never has to consult the
   * `EMBEDDING_MIN_SIMILARITY` table, which cannot know about a model renamed or
   * written by an older build.
   */
  minSimilarity?: number;
  dimensions: number;
  entries: PageEmbeddingV3[];
  chunks?: ChunkEmbeddingV3[];
}

/**
 * Legacy raw-JSON compatibility reader, not the format-aware production loader.
 * Resolves the .llmwiki dir, opens embeddings.json with
 * O_RDONLY|O_NOFOLLOW (symlinked leaf → null), fstat-caps the size, and returns
 * the raw UTF-8 content. Returns null for all unavailable/absent/oversized cases.
 */
async function readConfinedRaw(root: string): Promise<string | null> {
  const dir = await resolveExistingConfinedPrivateDir(root);
  if (dir === null) return null;
  const filePath = path.join(dir, path.basename(EMBEDDINGS_FILE));
  let handle;
  try {
    handle = await openFileNoFollow(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof NoFollowOpenError || code === "ENOENT" || code === "ELOOP") return null;
    throw err;
  }
  try {
    const size = (await handle.stat()).size;
    if (size > MAX_EMBEDDING_STORE_BYTES) return null;
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * Read the authoritative binary or legacy JSON store with confinement + size cap.
 * Returns null when:
 *  - .llmwiki does not exist (clean project — no mkdir);
 *  - embeddings.json does not exist;
 *  - embeddings.json is a symlink (O_NOFOLLOW → ELOOP, fail closed);
 *  - the file exceeds {@link MAX_EMBEDDING_STORE_BYTES} (fstat cap, no full parse);
 *  - the store fails vector integrity validation (whole store unavailable).
 * A symlinked .llmwiki dir throws (fail closed via private-dir confinement).
 */
export async function readEmbeddingStore(root: string): Promise<EmbeddingStore | null> {
  const result = await readStoredEmbeddings(root);
  if (result.kind !== "parsed") return null;
  try {
    const parsed = result.parsed.store;
    filterMalformedIdentities(parsed);
    assertEmbeddingStoreValid(parsed);
    return parsed as unknown as EmbeddingStore;
  } catch {
    return null;
  }
}

/**
 * Both directions of a read-modify-write, so they cannot disagree.
 *
 * A compile reads the store, reconciles it, and writes it back. If the two halves
 * resolved their location independently, a caller could read rows and write the
 * file: every compile would then update a store nothing consults, and every query
 * would rank vectors that no longer describe the corpus. Bundling them makes that
 * mismatch unrepresentable.
 */
export interface EmbeddingStoreLocation {
  /** Where the reconcile reads the current store. */
  readonly source: EmbeddingStoreSource;
  /** Where the write persists the reconciled store. */
  readonly sink: EmbeddingStoreSink;
}

/**
 * Validate and atomically persist through the format-aware confined writer.
 * JSON overflow selects binary without repeating provider work; exceeding binary
 * limits throws EmbeddingStoreFullError. Creates `.llmwiki` only for a write.
 */
export async function writeEmbeddingStore(
  root: string,
  store: EmbeddingStore | EmbeddingStoreV3,
  sink?: EmbeddingStoreSink,
): Promise<void> {
  // Validation runs for BOTH destinations. A database write bypassing the caps
  // would make the file and the table disagree about what a legal store is, and
  // the file is still the source a compile reads.
  assertEmbeddingStoreValid(store);
  assertFieldCaps(store as unknown as Record<string, unknown>);
  if (sink !== undefined) {
    await sink.write(store);
    return;
  }
  await persistEmbeddingStore(root, store);
}

/** Result of {@link validateV3ForSearch}. */
export interface SearchValidationResult {
  /** False when the whole store is unavailable (bad vectors or over-cap). */
  available: boolean;
  /** Warning messages for records dropped for malformed identity during this pass. */
  droppedIds: string[];
}

/**
 * Strict READ-time validator for any-version store. Applies the shared
 * vector/dimension/resource integrity (same policy as B1 {@link assertEmbeddingStoreValid}).
 * Also runs a v3-only pageId/embeddingTextHash grammar stub when `version === 3`.
 *
 * v3-only validation NEVER runs on a v2 store, so tightening this function
 * cannot reject healthy v2 stores that arrive via {@link readStoreForUpdate}.
 */
export function validateV3ForSearch(parsed: ParsedStore): SearchValidationResult {
  // v3 records are keyed by `pageId` (not `slug`), so identity filtering must be
  // pageId-grammar-aware; a v2 store still filters on `slug` as before.
  const droppedIds =
    parsed.version === 3
      ? filterMalformedPageIds(parsed.store)
      : filterMalformedIdentities(parsed.store).filter((w) => w.includes("dropped:"));
  try {
    assertEmbeddingStoreValid(parsed.store);
  } catch {
    return { available: false, droppedIds };
  }
  return { available: true, droppedIds };
}

/**
 * Drop v3 entries/chunks whose `pageId` fails the qualified-id grammar, mutating
 * the store in place. Returns one `dropped:`-tagged warning per removed record so
 * the read pipeline can surface them. The vector-integrity gate still runs after.
 */
function filterMalformedPageIds(store: Record<string, unknown>): string[] {
  const dropped: string[] = [];
  for (const field of ["entries", "chunks"] as const) {
    const arr = store[field];
    if (!Array.isArray(arr)) continue;
    store[field] = arr.filter((item) => {
      const id = (item as Record<string, unknown> | null)?.pageId;
      if (typeof id === "string" && parseQualifiedPageId(id)) return true;
      dropped.push(`embedding ${field} dropped: malformed pageId`);
      return false;
    });
  }
  return dropped;
}

/**
 * Write-path read: reads the embedding store via the same B1 confined reader but
 * accepts a v2 store WITHOUT calling {@link validateV3ForSearch} on it. This lets
 * a subsequent migration transform a v2 store to v3 without pre-validation rejection.
 * Returns null when the file is absent, oversized, unconfined, or unparseable.
 */
export async function readStoreForUpdate(root: string): Promise<ParsedStore | null> {
  const result = await readStoredEmbeddings(root);
  return result.kind === "parsed" ? result.parsed : null;
}

/**
 * Read the store a read-modify-write is about to replace.
 *
 * Takes the source rather than a root so the caller that chose where to read from
 * uses the same answer here. Returns null for absent or unreadable, matching
 * {@link readStoreForUpdate}: a store that cannot be read is treated as absent by
 * the migration, which rebuilds instead of guessing what it held.
 *
 * @param source - Where the store lives.
 * @returns The parsed store, or null when absent or unreadable.
 */
export async function readStoreForUpdateFrom(source: EmbeddingStoreSource): Promise<ParsedStore | null> {
  const result = await source.read();
  return result.kind === "parsed" ? result.parsed : null;
}

/**
 * Choose the active embedding model name, defaulting to anthropic's voyage model.
 *
 * LLMWIKI_EMBEDDING_MODEL is honoured only when the effective embedding provider
 * is openai, ollama or orcarouter. Anthropic and claude-agent always
 * ignore it, even when LLMWIKI_EMBEDDING_PROVIDER names one of them explicitly:
 * both delegate to Voyage's `VoyageEmbeddingProvider.embed()`, which calls the
 * Voyage API with no model argument and so always uses the hardcoded
 * EMBEDDING_MODELS.anthropic model. Honouring a configured name here would tag
 * the store — whose model field is its invalidation key — with a model that was
 * never actually used to produce its vectors, and a changed model rebuilds the
 * entire store.
 */
export function resolveEmbeddingModel(): string {
  const providerName = getActiveEmbeddingProviderName();
  const configuredModel = process.env.LLMWIKI_EMBEDDING_MODEL?.trim();
  const honoursConfigured = ["openai", "ollama", "orcarouter"].includes(providerName);
  if (configuredModel && honoursConfigured) {
    return configuredModel;
  }
  return EMBEDDING_MODELS[providerName] ?? EMBEDDING_MODELS.anthropic;
}

/**
 * The three values a store's fingerprint is computed from.
 *
 * Recorded beside the digest in `wiki.embedding_store_meta` because a digest is
 * one-way: without these, a corpus cannot say which backend and endpoint built it
 * once the configuration that produced it has moved on.
 */
export interface EmbeddingFingerprintIdentity {
  /** Backend the vectors were produced against — see `resolveEmbeddingBackend`. */
  readonly backend: string;
  /** Model name the vectors were produced with. */
  readonly model: string;
  /** Endpoint serving that backend, or "" for a fixed one. */
  readonly endpoint: string;
}

/**
 * Resolve the fingerprint inputs from the ACTIVE embedding configuration.
 *
 * Split out of `resolveEmbeddingFingerprint` so the inputs can be recorded NEXT TO the
 * digest they produce. One resolver, deliberately: a second resolution somewhere else
 * would be free to disagree with the values the digest was computed from, and a stored
 * input that does not hash to its own fingerprint is worse than no input at all.
 */
export function resolveEmbeddingFingerprintIdentity(): EmbeddingFingerprintIdentity {
  const providerName = getActiveEmbeddingProviderName();
  // Keyed on the BACKEND, not the provider name: anthropic and claude-agent both
  // embed via Voyage, so moving between them must not trigger a rebuild.
  return {
    backend: resolveEmbeddingBackend(providerName),
    model: resolveEmbeddingModel(),
    endpoint: resolveEmbeddingEndpoint(providerName),
  };
}

/**
 * The digest `identity` produces.
 *
 * NUL-separated: no env value can contain one, so no pair of distinct configurations
 * can collide by concatenation. The join order, separator and encoding ARE the
 * store's invalidation key — changing any of them re-embeds every existing wiki.
 *
 * HASHED because this is persisted. The endpoint component is a free-form URL that
 * routinely carries a credential as userinfo or a query parameter, and
 * .llmwiki/embeddings.json gets committed, copied between machines, and pasted into
 * bug reports. Nothing ever reads the fingerprint back — it is only compared for
 * equality — so opacity costs nothing, and `model` remains on the store in cleartext
 * for diagnostics.
 */
export function embeddingIdentityDigest(identity: EmbeddingFingerprintIdentity): string {
  const composed = [identity.backend, identity.model, identity.endpoint].join("\0");
  return createHash("sha256").update(composed, "utf8").digest("hex");
}

/**
 * Identity of the configuration that PRODUCES a store's vectors: the embedding
 * provider, its model, and the endpoint serving it.
 *
 * The model name alone is not that identity. It was a sound proxy while the
 * embedding backend was pinned to the chat provider — the only pair sharing a
 * model tag was anthropic/claude-agent, which really is the same Voyage
 * backend. LLMWIKI_EMBEDDING_PROVIDER broke the proxy by making the backend
 * vary on its own, so two configurations can now tag a store identically while
 * producing vectors that do not share a space:
 *
 *  - setting or unsetting OPENAI_EMBEDDINGS_BASE_URL — both tag
 *    `text-embedding-3-small`, one is cloud OpenAI and the other is whatever a
 *    local server answers to under that alias;
 *  - moving between `openai` and `ollama` with LLMWIKI_EMBEDDING_MODEL pinned to
 *    a name both serve (`nomic-embed-text`, `bge-m3`).
 *
 * Neither changes the dimension, so nothing downstream catches it: the store is
 * silently mixed and cosine ranking degrades into noise with no error. Folding
 * provider and endpoint into the invalidation key is what makes that a clean
 * rebuild instead.
 */
export function resolveEmbeddingFingerprint(): string {
  return embeddingIdentityDigest(resolveEmbeddingFingerprintIdentity());
}

/**
 * The cosine floor the ACTIVE embedding model declares, or undefined when it has
 * none measured.
 *
 * Read from {@link EMBEDDING_MIN_SIMILARITY} at WRITE time only, so the value lands
 * on the store and every later read uses what was recorded rather than what today's
 * build happens to believe. A model absent from the table is uncalibrated, and an
 * uncalibrated model must not filter -- see {@link EmbeddingStoreV3.minSimilarity}.
 *
 * @param model - Model name the store is being written with.
 * @returns The measured floor, or undefined.
 */
export function resolveMinSimilarityForModel(model: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_MIN_SIMILARITY, model)
    ? EMBEDDING_MIN_SIMILARITY[model]
    : undefined;
}

/**
 * True when `store` was built by the ACTIVE embedding configuration, so its
 * vectors may be preserved and searched.
 *
 * A store that predates {@link resolveEmbeddingFingerprint} carries no record of
 * its provenance, leaving only the model name to compare. Forcing every existing
 * project into a full re-embed on upgrade would be a worse default than keeping
 * that weaker check until the next write stamps a fingerprint — but only while
 * nothing overrides the embedding backend or its endpoint. Under an override the
 * name is known to be ambiguous: repointing at a local OpenAI-compatible server
 * keeps the model tag identical while producing vectors from another space.
 *
 * Preserving there does not merely postpone the rebuild. A partial update mixes
 * old and new vectors and then stamps the result with the current fingerprint,
 * so the mixed store is trusted permanently by every check that follows. The
 * rebuild is a bounded one-time cost; the laundering is not recoverable.
 */
export function storeMatchesActiveEmbedding(store: Record<string, unknown> | null | undefined): boolean {
  if (!store) return false;
  if (typeof store.fingerprint === "string") return store.fingerprint === resolveEmbeddingFingerprint();
  if (hasEmbeddingConfigurationOverride()) return false;
  return store.model === resolveEmbeddingModel();
}

/**
 * A store whose recorded embedding space is not the one the ACTIVE configuration
 * produces.
 *
 * A distinct class rather than a generic `Error` because this is the one failure
 * a caller must never confuse with "there is nothing relevant": ranking across two
 * spaces is not a weaker answer, it is a wrong one, and code that catches broadly
 * still has to be able to tell them apart.
 */
export class EmbeddingSpaceMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingSpaceMismatchError";
  }
}

/**
 * The refusal a store from another embedding space deserves, or null when there is
 * nothing to refuse.
 *
 * `null` covers BOTH acceptable states on purpose, because they must reach the
 * caller identically:
 *  - the store agrees with the active configuration (the normal path), and
 *  - there is NO store at all — a first-run deployment has nothing to disagree
 *    with, and refusing there would break every fresh install.
 *
 * A throw from `storeMatchesActiveEmbedding` (an unresolvable configuration, e.g. a
 * misspelled LLMWIKI_EMBEDDING_PROVIDER) is treated as a disagreement: the store
 * cannot be VOUCHED for, and a read path that several callers do not guard must
 * fail closed rather than rank vectors it cannot attribute.
 *
 * @param store - The header of the store about to be read, or null/undefined.
 * @returns The named refusal, or null.
 */
export function embeddingSpaceMismatch(
  store: Record<string, unknown> | null | undefined,
): EmbeddingSpaceMismatchError | null {
  if (!store) return null;
  if (matchesSafely(store)) return null;
  return new EmbeddingSpaceMismatchError(describeSpaceMismatch(store));
}

/** Whether `store` matches, failing CLOSED when the active side cannot be resolved. */
function matchesSafely(store: Record<string, unknown>): boolean {
  try {
    return storeMatchesActiveEmbedding(store);
  } catch {
    return false;
  }
}

/** Shown in place of the store's model when none was recorded. */
const NO_MODEL = "(none recorded)";

/**
 * Shown in place of a recorded model id whose SHAPE this refusal will not print.
 *
 * A distinct marker from {@link NO_MODEL} on purpose: something WAS recorded, and a
 * diagnostic that said otherwise would be false about the very row being refused.
 */
const WITHHELD_MODEL = "(withheld: not a model id)";

/** Shown in place of a fingerprint this refusal has no printable value for. */
const NO_FINGERPRINT = "(not recorded)";

/**
 * Shown in place of a fingerprint that IS recorded but cannot be printed safely.
 *
 * Separate from {@link NO_FINGERPRINT} for the same reason as {@link WITHHELD_MODEL}:
 * "nothing was recorded" and "something was recorded that this build will not print"
 * are different facts, and the second one is actionable.
 */
const WITHHELD_FINGERPRINT = "(recorded, not printable)";

/**
 * The characters a model id is made of, per the ids every backend records.
 *
 * Deliberately conservative: alphanumerics plus the separators real ids use (`.`, `_`,
 * `-`, `/`, `:`) — `hf:nomic-ai/nomic-embed-text-v1.5`, `text-embedding-3-small`,
 * `qwen2.5:7b`. No whitespace, no quotes, and a bounded length.
 */
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/**
 * A recorded model id, or null when it does not have the shape of one.
 *
 * WHY A SHAPE TEST AND NOT A TRUST EXERCISE. `store.model` reaches this message
 * verbatim, and a store header can be hand-edited — or written by another build — so
 * the value is not guaranteed to be a model id at all. `//` and `@` are then refused
 * explicitly, because they are what turns a string into a URL: a scheme separator and
 * the userinfo delimiter that carries a credential.
 *
 * Environment-derived model names never reach here unshaped, so this is defence in
 * depth rather than a live leak: the guard exists so that a hand-edited row cannot
 * put an endpoint into an operator's logs. A bare `host:port/path` string would still
 * pass — it fits the shape of an id — which is stated rather than hidden: it carries
 * no credential, and nothing in an id namespace can tell it from `qwen2.5:7b`.
 *
 * @param value - The recorded model, of unknown shape.
 * @returns The value, or null when it must be withheld.
 */
function printableModelId(value: string): string | null {
  if (!MODEL_ID_SHAPE.test(value)) return null;
  if (value.includes("//") || value.includes("@")) return null;
  return value;
}

/**
 * The stored model as a message fragment, quoted when printable and marked otherwise.
 *
 * @param recorded - `store.model`, or `""` when absent.
 * @returns `"id"`, `(none recorded)` or `(withheld: not a model id)`.
 */
function displayModel(recorded: string): string {
  if (recorded === "") return NO_MODEL;
  const printable = printableModelId(recorded);
  return printable === null ? WITHHELD_MODEL : `"${printable}"`;
}

/** Whether the header records a fingerprint at all, whatever its shape. */
function fingerprintWasRecorded(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * A fingerprint shortened for display, or null when there is nothing printable.
 *
 * Printing a PREFIX is safe only because a fingerprint is opaque: it is
 * {@link embeddingIdentityDigest}, a truncated SHA-256 hex string, and nothing
 * reads it back. It is never the raw configuration, so no endpoint and no
 * credential in that endpoint can be recovered from it.
 *
 * A stored value that is not that shape is withheld entirely. A fingerprint
 * written by another build is not guaranteed to be a digest, and this function
 * has no way to tell one from a raw string that embeds a URL.
 *
 * @param value - The fingerprint, of unknown shape.
 * @returns A 12-character prefix, or null.
 */
function shortenedFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.slice(0, 12);
}

/** The ACTIVE fingerprint shortened for display, or null when unresolvable. */
function activeFingerprintShort(): string | null {
  try {
    return shortenedFingerprint(resolveEmbeddingFingerprint());
  } catch {
    return null;
  }
}

/** Why any mismatch refuses, and the two ways out of it. */
const MISMATCH_REMEDY = [
  "Vectors from two spaces are not comparable, so retrieval is refused instead of answering with noise.",
  "Rebuild the index with the MCP tool `compile_wiki`, or restore the embedding configuration it was built with.",
].join(" ");

/**
 * The operator-facing message: BOTH sides, so it is clear which one to change.
 *
 * Model ids and dimension counts are configuration and are printed — but only when
 * they have the SHAPE of one (see {@link printableModelId}): the stored model arrives
 * from a store header, which can be hand-edited, and a URL in an operator's log is
 * how a credentialed endpoint escapes. An environment variable's VALUE never is
 * printed: an endpoint routinely carries a credential as userinfo or a query
 * parameter, which is why {@link embeddingIdentityDigest} hashes it.
 *
 * The active side's WIDTH is deliberately absent rather than guessed. Dimensions are
 * a property of what the provider returns, not of the configuration, and nothing
 * records them before the first embedding — inventing a number here would be a
 * confident statement about a fact this path cannot observe.
 *
 * Two mismatches are possible and they need different sentences. Different model ids
 * is self-describing. The SAME model id under a different fingerprint is not: naming
 * that id on both sides would present the one fact that agrees as the disagreement
 * and hide the endpoint or provider that actually moved.
 */
function describeSpaceMismatch(store: Record<string, unknown>): string {
  const recordedModel = typeof store.model === "string" ? store.model : "";
  const dimensions = typeof store.dimensions === "number" ? store.dimensions : 0;
  const activeModel = activeModelName();
  // The comparison uses the RAW value (two equal ids is one fact, not two sides),
  // while the printed form is guarded: an unprintable stored model is named as
  // withheld instead of being quoted into the log it would leak into.
  const sides =
    recordedModel !== "" && recordedModel === activeModel
      ? sameModelSides(recordedModel, dimensions, store.fingerprint)
      : differentModelSides(displayModel(recordedModel), dimensions, activeModel);
  return `Embedding space mismatch: ${sides} ${MISMATCH_REMEDY}`;
}

/** Both sides disagree on the model id itself, so both ids are printed. */
function differentModelSides(storedModel: string, dimensions: number, activeModel: string): string {
  return [
    `the stored index holds vectors from model ${storedModel} at ${dimensions} dimensions;`,
    `the active embedding configuration resolves to model "${activeModel}".`,
  ].join(" ");
}

/**
 * Both sides agree on the model id and disagree on the configuration behind it.
 *
 * The id is printed ONCE, as the fact that is not in dispute, and then the
 * fingerprints — the only thing that differs — so an operator can see that the
 * configuration moved without being told two equal ids are two sides.
 */
function sameModelSides(model: string, dimensions: number, storedFingerprint: unknown): string {
  const stored = shortenedFingerprint(storedFingerprint);
  return [
    `the stored index holds vectors from model "${model}" at ${dimensions} dimensions, and the active`,
    "embedding configuration resolves to that same model id through a different embedding configuration",
    "— a different endpoint or provider — so the two sides are not the same vector space.",
    `Stored configuration fingerprint ${stored ?? absentOrWithheld(storedFingerprint)};`,
    `active configuration fingerprint ${activeFingerprintShort() ?? NO_FINGERPRINT}.`,
    stored === null ? missingFingerprintSentence(storedFingerprint) : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/**
 * The marker for a stored fingerprint that is either absent or unprintable.
 *
 * @param storedFingerprint - The header's fingerprint, of unknown shape.
 * @returns `(not recorded)` or `(recorded, not printable)`.
 */
function absentOrWithheld(storedFingerprint: unknown): string {
  return fingerprintWasRecorded(storedFingerprint) ? WITHHELD_FINGERPRINT : NO_FINGERPRINT;
}

/**
 * Why a store with no PRINTABLE fingerprint still cannot be vouched for.
 *
 * Two situations, two sentences. The withheld one says a value is there and that
 * this build will not print it — never that nothing was recorded, which would be a
 * false statement about a header that does hold something, and never any part of the
 * withheld value itself.
 *
 * @param storedFingerprint - The header's fingerprint, of unknown shape.
 * @returns The sentence for whichever situation applies.
 */
function missingFingerprintSentence(storedFingerprint: unknown): string {
  const cannotVouch = "and it cannot be vouched for while the embedding backend or endpoint is overridden.";
  return fingerprintWasRecorded(storedFingerprint)
    ? `The store records a fingerprint that this build will not print, ${cannotVouch}`
    : `The store records no fingerprint of its own, ${cannotVouch}`;
}

/** The active model name, or a marker when the configuration cannot be resolved. */
function activeModelName(): string {
  try {
    return resolveEmbeddingModel();
  } catch {
    return "(unresolvable embedding configuration)";
  }
}
