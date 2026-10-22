import { crc32, deflateRawSync } from "node:zlib";

import { sql } from "drizzle-orm";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { requireApiKey, type ApiKeyMiddleware } from "../auth.js";
import { getOrGeneratePage } from "../core/page_generator.js";
import { resolveStack } from "../core/stack_resolver.js";
import {
  withRequestTransaction,
  type Database,
  type TransactionalHandler,
} from "../db.js";
import { AKSEntityPage } from "../dto.js";
import {
  apiError,
  pydanticFloat,
  pydanticString,
  pydanticUuid,
  toFastApiValidationError,
} from "../errors.js";
import type { ApiError, ValidationFailure } from "../errors.js";

/**
 * Entity page endpoints — the TypeScript port of `app/routers/pages.py`.
 *
 *   GET /aks/v1/pages/{entity_name}   one page on demand, as JSON
 *   GET /aks/v1/pages                 every page in the Stack, as a ZIP archive
 *
 * Both are mounted at `/aks/v1/pages` (`APIRouter(prefix="/aks/v1/pages")`).
 * The first request to an entity costs one LLM call; later requests are served
 * from `entity_pages` until the entity's graph changes.
 *
 * ## The ZIP is built here, not through a dependency
 *
 * Python calls `zipfile.ZipFile(..., ZIP_DEFLATED)`. Node has raw deflate and
 * CRC-32 in `node:zlib`, so the container itself is written below in ~80 lines
 * rather than adding an archive library to `package.json`. The archive is a
 * single-disk, non-ZIP64, non-encrypted file, which is the only shape this
 * endpoint can produce: every entry is a few kilobytes of markdown.
 *
 * Measured from the oracle's archive, and reproduced here because a reader of the
 * bytes can see each one:
 *
 * - entry order is `README.md` first, then one file per entity in `name` order;
 * - compression method 8 (deflate), no data descriptor (`flag_bits: 0`), because
 *   sizes are known before the header is written;
 * - `create_system: 3` (Unix) and `external_attr: 0o600 << 16` (`-rw-------`);
 * - DOS modification time is the **local** time the entry was written, which is
 *   what `ZipInfo` defaults to;
 * - the archive carries no comment and no extra field.
 *
 * Byte-for-byte equality with the oracle is impossible for a non-deterministic
 * payload (one `deflate` stream per LLM output, plus wall-clock timestamps), so
 * what is pinned is the container's *structure*: `unzip -l` output, the entry
 * list and order, and the README text.
 *
 * ## Query parameters are validated before the Stack is resolved
 *
 * FastAPI resolves every declared parameter before the handler runs, so
 * `?stack_id=nope&min_confidence=2` answers 422 with **both** entries rather
 * than a 404 for the Stack. Measured. The port parses first for the same reason.
 *
 * ## Raw SQL, not the query builder
 *
 * Same reasoning as `aks.ts`: these reads are transliterations of the Python
 * statements, and keeping them literal makes the two diffable. The page
 * generation itself lives in `core/page_generator.ts`.
 */

// ---------------------------------------------------------------------------
// Query-parameter reading
// ---------------------------------------------------------------------------

/**
 * Reads one raw query-string value, keeping FastAPI's last-occurrence rule.
 *
 * Express's default `simple` parser yields `string | string[]`; Starlette hands
 * the last occurrence to the parameter. A present-but-empty value stays `""`
 * rather than becoming absent, so `?min_confidence=` reports `input: ""` on the
 * `float_parsing` failure, exactly as measured.
 */
function readQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const last: unknown = value[value.length - 1];
    return typeof last === "string" ? last : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/** Collects `keys` from the query string, omitting absent ones. */
function readQuery(req: Request, keys: readonly string[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readQueryValue(req.query[key]);
    if (value !== undefined) {
      raw[key] = value;
    }
  }
  return raw;
}

/** Query schema for `GET /aks/v1/pages/{entity_name}`. */
const EntityPageQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
});

/** Query schema for `GET /aks/v1/pages`. */
const AllPagesQuery = z.object({
  stack_id: pydanticUuid().nullable().default(null),
  domain: pydanticString().nullable().default(null),
  min_confidence: pydanticFloat({ ge: 0, le: 1 }).default(0),
});

/** Keys each endpoint reads, in the order FastAPI declares them. */
const ENTITY_PAGE_QUERY_KEYS = ["stack_id", "domain"] as const;
const ALL_PAGES_QUERY_KEYS = ["stack_id", "domain", "min_confidence"] as const;

/** Path-parameter validator for `:entity_name`. FastAPI's `str` path param. */
const EntityNameParams = z.object({ entity_name: pydanticString() });

/** Sends an `HTTPException`-shaped body: `{"detail": "<message>"}`. */
function sendApiError(res: Response, error: ApiError): void {
  res.status(error.status).json(error.body);
}

/** Sends a `RequestValidationError`-shaped body: `{"detail": [...]}`. */
function sendValidationError(res: Response, failure: ValidationFailure): void {
  res.status(failure.status).json(failure.body);
}

// ---------------------------------------------------------------------------
// Archive assembly (pure)
// ---------------------------------------------------------------------------

/** One file inside the generated archive. */
export interface ArchiveEntry {
  readonly name: string;
  readonly content: string;
}

/**
 * The README written into every archive.
 *
 * Transcribed from the oracle's own output byte for byte, including the em dash
 * and the ISO timestamp with a `+00:00` offset — the Python code interpolates
 * `datetime.now(timezone.utc).isoformat()`, which is **not** the `Z` form the
 * JSON endpoints use. Measured archive text:
 *
 * ```
 * # W2 Pages Probe — Entity Pages
 *
 * Generated from AKS Stack `w2pg-probe-main` on 2026-10-22T05:12:48.591393+00:00.
 *
 * Total entities: 13
 *
 * Each `.md` file is a wiki-style page for one entity, generated from the compiled knowledge graph.
 * ```
 */
export function buildReadme(
  stackName: string,
  stackDomain: string,
  entityCount: number,
  generatedAt: Date,
): string {
  return (
    `# ${stackName} — Entity Pages\n\n` +
    `Generated from AKS Stack \`${stackDomain}\` ` +
    `on ${pythonUtcIsoformat(generatedAt)}.\n\n` +
    `Total entities: ${String(entityCount)}\n\n` +
    `Each \`.md\` file is a wiki-style page for one entity, ` +
    `generated from the compiled knowledge graph.\n`
  );
}

/**
 * `datetime.now(timezone.utc).isoformat()`.
 *
 * Python's `datetime.isoformat()` emits a `+00:00` offset, omits the fractional
 * part when it is exactly zero, and otherwise emits six digits. `Date` supplies
 * milliseconds, so the last three are zeros — the same rule the page timestamps
 * follow.
 */
export function pythonUtcIsoformat(instant: Date): string {
  const iso = instant.toISOString();
  const millis = iso.slice(20, 23);
  const whole = iso.slice(0, 19);
  return millis === "000" ? `${whole}+00:00` : `${whole}.${millis}000+00:00`;
}

/**
 * The filename one entity's page is stored under.
 *
 * Python's chain of `str.replace` calls, in the same order: forward slash,
 * backslash and colon become `-`, and spaces become `_`. Measured:
 * `Billing Service` -> `Billing_Service.md`.
 *
 * Only those four substitutions happen. A name containing `?`, `*` or a control
 * character keeps it, so this is *filename sanitisation by the oracle's rule*,
 * not a general-purpose sanitiser — reproducing it exactly is what keeps the two
 * archives' file lists comparable.
 */
export function pageFilename(entityName: string): string {
  const safeName = entityName
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(":", "-")
    .replaceAll(" ", "_");
  return `${safeName}.md`;
}

/** Assembles the archive's entry list in the oracle's order. */
export function buildArchiveEntries(
  readme: string,
  pages: readonly { readonly entityName: string; readonly markdown: string }[],
): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [{ name: "README.md", content: readme }];
  for (const page of pages) {
    entries.push({ name: pageFilename(page.entityName), content: page.markdown });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

/** Local file header signature, `PK\x03\x04`. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** Central directory header signature, `PK\x01\x02`. */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** End-of-central-directory signature, `PK\x05\x06`. */
const END_RECORD_SIGNATURE = 0x06054b50;

/** `ZIP_DEFLATED`. */
const COMPRESSION_DEFLATE = 8;
/** Zipfile format version 2.0, which every deflate entry requires. */
const ZIP_VERSION = 20;
/** `create_system = 3` — the archive declares Unix origin, as Python's does. */
const CREATE_SYSTEM_UNIX = 3;
/** `external_attr` for a `0o600` regular file, shifted into the high word. */
const EXTERNAL_ATTR_0600 = 0o600 * 0x10000;

/** Fixed on-disk sizes of the three record types, excluding variable fields. */
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

/**
 * Encodes a `Date` as the MS-DOS `(date, time)` pair a ZIP header carries.
 *
 * DOS timestamps have two-second resolution, a 1980 epoch and a 127-year range,
 * so both fields clamp rather than overflow. Local time is used because that is
 * what `zipfile.ZipInfo` defaults to (`time.localtime(os.stat(...)))`); the
 * archive's timestamps are therefore informative, not contractual.
 */
function dosDateTime(instant: Date): { readonly date: number; readonly time: number } {
  const year = Math.min(Math.max(instant.getFullYear(), 1980), 2107);

  // `<< 9` and `<< 5` pack five bits each; `>> 1` drops the odd second.
  const date = ((year - 1980) << 9) | ((instant.getMonth() + 1) << 5) | instant.getDate();
  const time =
    (instant.getHours() << 11) |
    (instant.getMinutes() << 5) |
    Math.floor(instant.getSeconds() / 2);

  return { date, time };
}

/**
 * Builds a ZIP archive from `entries`, deflated, the way
 * `zipfile.ZipFile(..., ZIP_DEFLATED)` would.
 *
 * Every byte offset is computed as the buffer is written, so the central
 * directory points at the real local headers and the end record points at the
 * real central directory. There is no data descriptor: each entry's sizes and
 * CRC are known before its header is emitted, which is why `flag_bits` stays 0.
 *
 * Entry names and contents are UTF-8. Python sets the UTF-8 flag (bit 11) only
 * for names it cannot represent in cp437; entity names are usually ASCII, and a
 * reader that honours the flag will decode both archives identically.
 */
export function buildZipArchive(entries: readonly ArchiveEntry[], now: Date): Buffer {
  const { date, time } = dosDateTime(now);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const uncompressed = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(uncompressed);
    const checksum = crc32(uncompressed);

    const local = Buffer.alloc(LOCAL_HEADER_SIZE);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(COMPRESSION_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    // Version made by: creator system in the high byte, version in the low byte.
    central.writeUInt16LE((CREATE_SYSTEM_UNIX << 8) | ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(COMPRESSION_DEFLATE, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(EXTERNAL_ATTR_0600, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);

  const end = Buffer.alloc(END_RECORD_SIZE);
  end.writeUInt32LE(END_RECORD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localSection.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralDirectory, end]);
}

// ---------------------------------------------------------------------------
// GET /aks/v1/pages/{entity_name}
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the name lookup reads it. */
type EntityIdRow = { readonly id: string };

/**
 * `GET /aks/v1/pages/{entity_name}` — one page, generated or cached.
 *
 * The entity is resolved **within the Stack** by exact, case-insensitive name
 * (`lower(name) = lower(%s)`), so `?domain=x` and a name from another Stack is a
 * 404 rather than a cross-Stack read. The 404 echoes the requested text.
 *
 * `get_or_generate_page` returning nothing means the row disappeared between the
 * lookup and the read; Python answers `500` with
 * `"Failed to generate entity page"` and this port emits the same JSON body.
 */
async function getEntityPage(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ENTITY_PAGE_QUERY_KEYS);
  const query = EntityPageQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  // A path parameter is always a string, so this parse cannot fail for a request
  // Express routed here; it exists so the value is narrowed without a cast.
  const entityName = EntityNameParams.parse({ entity_name: req.params["entity_name"] })
    .entity_name;

  const rows = await tx.execute<EntityIdRow>(sql`
    select id from ontology_entities
    where stack_id = ${stack.stack.id} and lower(name) = lower(${entityName})
  `);
  const row = rows[0];
  if (row === undefined) {
    sendApiError(res, apiError(404, `Entity '${entityName}' not found in Stack`));
    return;
  }

  const page = await getOrGeneratePage(tx, row.id);
  if (page === null) {
    sendApiError(res, apiError(500, "Failed to generate entity page"));
    return;
  }

  res.json(AKSEntityPage.parse(page));
}

// ---------------------------------------------------------------------------
// GET /aks/v1/pages
// ---------------------------------------------------------------------------

/** One `ontology_entities` row as the archive endpoint reads it. */
type PageTargetRow = { readonly id: string; readonly name: string };

/**
 * `GET /aks/v1/pages` — every page in the Stack as a ZIP of markdown files.
 *
 * `order by name` is what fixes the archive's entry order, so it is part of the
 * contract rather than an incidental detail. An entity whose page cannot be
 * generated is **skipped**: Python's `if not page: continue` means the archive is
 * short a file rather than failing the whole download.
 *
 * A Stack with no entities above `min_confidence` answers `404` with
 * `"Stack has no entities meeting the filter criteria"` — an empty archive is
 * never returned.
 *
 * Response headers are the oracle's, measured: `content-type: application/zip`
 * and `content-disposition: attachment; filename=<domain>-entity-pages.zip`.
 *
 * The body is a single `res.write` followed by `res.end()`, not `res.end(buffer)`
 * or `res.send(buffer)`, because those two make Express set `Content-Length`
 * while the oracle answers `transfer-encoding: chunked`. Measured:
 *
 * | Python | `res.end(buf)` | `res.write(buf); res.end()` |
 * |---|---|---|
 * | `transfer-encoding: chunked` | `content-length: 1116` | `transfer-encoding: chunked` |
 *
 * The oracle passes a `StreamingResponse` over an in-memory `BytesIO`, so it
 * never knows the length it is about to send. Writing then ending reproduces
 * that exactly; it costs nothing, because the whole buffer is already built.
 */
async function getAllPages(req: Request, res: Response, tx: Database): Promise<void> {
  const raw = readQuery(req, ALL_PAGES_QUERY_KEYS);
  const query = AllPagesQuery.safeParse(raw);
  if (!query.success) {
    sendValidationError(res, toFastApiValidationError(query.error, "query", raw));
    return;
  }

  const { min_confidence: minConfidence } = query.data;

  const stack = await resolveStack(tx, query.data.stack_id, query.data.domain);
  if (!stack.ok) {
    sendApiError(res, stack.error);
    return;
  }

  const entityRows = await tx.execute<PageTargetRow>(sql`
    select id, name from ontology_entities
    where stack_id = ${stack.stack.id} and confidence >= ${minConfidence}
    order by name
  `);

  if (entityRows.length === 0) {
    sendApiError(res, apiError(404, "Stack has no entities meeting the filter criteria"));
    return;
  }

  // One clock read for the whole archive: the README's timestamp and every
  // entry's DOS timestamp describe the same generation event.
  const now = new Date();

  const pages: { entityName: string; markdown: string }[] = [];
  for (const entityRow of entityRows) {
    const page = await getOrGeneratePage(tx, entityRow.id);
    if (page === null) {
      continue;
    }
    pages.push({ entityName: page.entity_name, markdown: page.markdown });
  }

  const readme = buildReadme(
    stack.stack.name,
    stack.stack.domain,
    entityRows.length,
    now,
  );
  const archive = buildZipArchive(buildArchiveEntries(readme, pages), now);

  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${stack.stack.domain}-entity-pages.zip`,
  );
  // Write-then-end so Express chunks the response instead of announcing a
  // length the oracle never sends. See the function's header for the measurement.
  res.write(archive);
  res.end();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** Injectable collaborators, so integration tests can bind their own pool. */
export interface PagesRouterDependencies {
  /** Request-scoped transaction wrapper; defaults to the process-wide pool. */
  readonly wrap: (handler: TransactionalHandler) => RequestHandler;
  /** Router-level auth; defaults to the process-wide `requireApiKey`. */
  readonly apiKey: ApiKeyMiddleware;
}

const DEFAULT_DEPENDENCIES: PagesRouterDependencies = {
  wrap: withRequestTransaction,
  apiKey: requireApiKey,
};

/**
 * Builds the `/aks/v1/pages` router.
 *
 * Mounted at `/aks/v1/pages`, mirroring `APIRouter(prefix="/aks/v1/pages", ...)`,
 * with auth on the router as `dependencies=[Depends(require_api_key)]` is in
 * Python.
 *
 * Registration order follows the Python decorator order: the parameterised
 * `/:entity_name` route is declared first and the bare `""` route second. That is
 * harmless here (the two paths differ in segment count) but it keeps the 405
 * `Allow` walk in `http-contract.ts` visiting layers in the same order Starlette
 * does.
 */
export function createPagesRouter(
  deps: PagesRouterDependencies = DEFAULT_DEPENDENCIES,
): Router {
  const router = Router();

  router.use(deps.apiKey);

  router.get("/:entity_name", deps.wrap(getEntityPage));
  router.get("/", deps.wrap(getAllPages));

  return router;
}
