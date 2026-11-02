/**
 * Profile pack type definitions (schemaVersion 1, v0).
 *
 * A profile pack describes the entity types a wiki compiles into: their
 * directories, fields, retrieval behaviour, and lifecycle. This is the v0
 * surface — purely declarative. There is intentionally NO computed-field or
 * required-if logic yet; those are deferred to a later schema version.
 *
 * Identity is modelled with branded string types so that a raw filesystem
 * stem can never be mistaken for a validated slug or entity id at compile
 * time. The only way to obtain a SlugSafe or EntityId is through the
 * constructors in `./identity.js`.
 */

import path from "path";
import { toPosixPath } from "../utils/path-confine.js";
/**
 * The kinds of structured problem an entity-page collector could report.
 *
 * These lived in `collect.ts`, which was removed with the profile substrate: the
 * collector walked DECLARED entity types, and there are none. The types stay
 * because {@link EntityProblemView} is a wire DTO that other layers still shape
 * and because the union is the closed vocabulary a consumer switches on — but
 * only `invalid-directory` remains producible, since a page cannot violate a
 * field contract that no longer exists.
 */
export type EntityProblemKind =
  | "invalid-directory"
  | "non-slug-safe-filename"
  | "slug-mismatch"
  | "field-violation";

/** A structured, non-fatal problem found while collecting entity pages. */
export interface EntityProblem {
  kind: EntityProblemKind;
  /** The declared entity type the problem belongs to. */
  entityType: string;
  /** Absolute path of the offending page (absent for directory-level problems). */
  filePath?: string;
  /** Human-readable description, safe to surface to agents/users. */
  message: string;
}

/** A string proven to match the slug-safe grammar (`^[a-z0-9][a-z0-9-]*$`). */
export type SlugSafe = string & { readonly __slugSafe: unique symbol };

/** A composed, validated `type/slug` entity identifier. */
export type EntityId = string & { readonly __entityId: unique symbol };




/**
 * How an entity type participates in search and context retrieval.
 *
 * NOTE: a read-confidentiality control (`readExposure`) was intentionally
 * removed for v0 — nothing enforces it this slice, and shipping an unenforced
 * confidentiality field is false assurance. It returns in the phase that
 * actually enforces read-confidentiality.
 */
export interface RetrievalDef {
  includeInSearch?: boolean;
  includeInContext?: boolean;
  defaultWeight?: number;
}






















/**
 * The reserved `contentTiers` token that reveals a record's markdown BODY (as
 * opposed to a declared frontmatter field). Shared by the load validator and the
 * context projection so the one reserved literal is spelled exactly once.
 */
const BODY_TIER_TOKEN = "body";

/** Declarative definition of one entity type within a profile pack. */
/**
 * One page namespace. It carries its directory and nothing else.
 *
 * Seven fields used to live here — `titleField`, `requiredFields`, `fields`,
 * `retrieval`, `lifecycle`, `contentTiers`, `export` — describing what a project
 * could DECLARE about its own entity types. With `concepts` and `queries` fixed
 * and nothing configurable, no code path reads any of them, and a type nobody can
 * populate is not a contract. `retrieval` in particular is now the rule rather
 * than a setting: both namespaces always enter search and context.
 */
export interface EntityTypeDef {
  directory: string;
}



/** A profile pack: the full declarative description of a wiki's entity types. */
export interface ProfilePack {
  schemaVersion: 1;
  profileId: string;
  profileVersion?: string;
  displayName?: string;
  extends?: string[];
  entities: Record<string, EntityTypeDef>;
  // `relations`, `workflows`, `workflowActions`, `artifacts` and `connectors` were
  // REMOVED with the subsystems that consumed them. A profile is now its identity
  // plus its two fixed namespaces; there is nothing left to declare.
}

/** A profile resolved from disk (or built-in), with its source and digest. */
export interface LoadedProfile {
  profile: ProfilePack;
  loadedFrom: string | null;
  digest: string;
}

/**
 * A reference to a single entity page on disk, carrying its validated slug
 * and minted id.
 *
 * EntityPageRef and EntityId are for NON-DEFAULT profiles only. Default-profile
 * pages keep their raw filesystem stems in RawWikiPage and never become an
 * EntityId — the default pipeline does not validate or mint identities.
 */
export interface EntityPageRef {
  entityType: string;
  directory: string;
  slug: SlugSafe;
  id: EntityId;
  filePath: string;
}

/**
 * A non-default profile entity page: identity (`EntityPageRef`) plus content.
 *
 * Where `EntityPageRef` is identity-only, `EntityPage` additionally carries the
 * page's parsed `frontmatter`, its markdown `body`, and a convenience `title`
 * resolved from the type's declared `titleField` (falling back to the literal
 * `title` key for a type that declares none), or `undefined` when the page
 * carries no usable one. It is produced by the content-carrying collector so
 * downstream read surfaces can render a page without re-reading it. Surfaces
 * that must judge or publish what the page literally WROTE read the frontmatter
 * key directly instead — see `pageTitle` in collect.ts.
 *
 * This is the INTERNAL collector output: it carries an ABSOLUTE `filePath`
 * (inherited from `EntityPageRef`). Never expose it directly on a public read
 * surface — map it through {@link toEntityPageView} first so the machine-local
 * path is dropped in favour of a project-relative one.
 */
export interface EntityPage extends EntityPageRef {
  frontmatter: Record<string, unknown>;
  body: string;
  title?: string;
}

/**
 * The PUBLIC surface DTO for a non-default profile entity page.
 *
 * Unlike the internal {@link EntityPage}, this NEVER carries an absolute
 * `filePath` — only a PROJECT-RELATIVE `path` (`${directory}/${slug}.md`) — so
 * read surfaces (`listPages`, JSON export) cannot leak machine-local paths. The
 * `body` is OPTIONAL and OMITTED entirely (not blanked to `""`) when the caller
 * did not request it, so an absent body is distinguishable from a genuinely
 * empty page.
 *
 * @experimental Shape may change in a future release.
 */
export interface EntityPageView {
  entityType: string;
  directory: string;
  slug: string;
  id: string;
  /** Project-relative page path (`${directory}/${slug}.md`); never absolute. */
  path: string;
  title?: string;
  frontmatter: Record<string, unknown>;
  /** Markdown body; OMITTED (key absent) when bodies were not requested. */
  body?: string;
}

/**
 * Map an internal {@link EntityPage} to its public {@link EntityPageView}.
 *
 * Drops the absolute `filePath` in favour of the project-relative `path`, and
 * OMITS `body` entirely when `includeBody` is false (mirroring how the legacy
 * `Page` shape omits — rather than blanks — an unrequested body).
 *
 * @param page - The internal collector entity page.
 * @param includeBody - When true, carry the markdown body into the view.
 * @returns The public, path-safe entity-page view.
 */
export function toEntityPageView(page: EntityPage, includeBody: boolean): EntityPageView {
  const view: EntityPageView = {
    entityType: page.entityType,
    directory: page.directory,
    slug: page.slug,
    id: page.id,
    path: `${page.directory}/${page.slug}.md`,
    frontmatter: page.frontmatter,
    ...(page.title !== undefined ? { title: page.title } : {}),
    ...(includeBody ? { body: page.body } : {}),
  };
  return view;
}

/**
 * The PUBLIC surface DTO for a structured non-default-profile collector problem.
 *
 * Unlike the internal {@link EntityProblem}, this NEVER carries an absolute
 * `filePath` — only a PROJECT-RELATIVE `path` (`path.relative(root, filePath)`),
 * which is OMITTED entirely (key absent) for directory-level problems that have
 * no file. Carrying the structured `kind`/`entityType` (rather than a flattened
 * message string) lets a surface group, count, or filter problems, and keeps
 * repeated field violations distinguishable.
 *
 * @experimental Shape may change in a future release.
 */
export interface EntityProblemView {
  /**
   * The problem kind. An entity-page/dir collector problem ({@link EntityProblemKind});
   * `"relation-store"` for a fail-closed relation-store read (corrupt / too-new);
   * `"event-store"` for a fail-closed event-store read OR a broken/truncated
   * hash chain;
   * `"artifact-store"` for a hash-pinned artifactRef (page field or relation
   * attribute) that resolves to a non-`ok` health (dangling / bytes-tampered /
   * hash-mismatch / schema-invalid / unreadable / store-unavailable) — see
   * `./artifact-lint.js`;
   * `"lifecycle-relation-requirement-unmet"` for a page CURRENTLY in a gated
   * lifecycle state whose relation-count precondition NO LONGER holds against the
   * live relation graph (a standing-invariant violation);
   * `"lifecycle-relation-requirement-unverifiable"` when that standing check could
   * NOT read the relation store (cannot verify, not a confirmed violation). The
   * store-level and standing kinds are surfaced through the SAME problems channel
   * so a status/viewer envelope never reports a degraded project as silently healthy.
   */
  kind:
    | EntityProblemKind
    | "relation-store"
    | "event-store"
    | "artifact-store"
    | "lifecycle-relation-requirement-unmet"
    | "lifecycle-relation-requirement-unverifiable";
  /**
   * Declared entity type the problem belongs to. ABSENT for a store-level
   * (`relation-store`) problem, which is not scoped to any entity type.
   */
  entityType?: string;
  /**
   * Project-relative offending page path; ABSENT for directory-level problems.
   * Never absolute, and always `/`-separated on every platform — this is
   * portable content, not a filesystem argument.
   */
  path?: string;
  message: string;
}

/**
 * Map an internal {@link EntityProblem} to its public {@link EntityProblemView}.
 *
 * Drops the absolute `filePath` in favour of a project-relative `path`,
 * OMITTING the key entirely when the problem is directory-level (no `filePath`)
 * so an absent path is never a misleading empty string and an absolute path can
 * never leak.
 *
 * The relative path is forced back to POSIX: `path.relative` emits the PLATFORM
 * separator, so on win32 this public view would otherwise promise
 * `wiki/notes/x.md` and hand every consumer `wiki\notes\x.md` (issue #163, one
 * layer out from the declared-path fix).
 *
 * @param problem - The internal structured collector problem.
 * @param root - Absolute project root, used to relativize `filePath`.
 * @returns The public, path-safe problem view.
 */
export function toEntityProblemView(problem: EntityProblem, root: string): EntityProblemView {
  return {
    kind: problem.kind,
    entityType: problem.entityType,
    ...(problem.filePath !== undefined ? { path: toPosixPath(path.relative(root, problem.filePath)) } : {}),
    message: problem.message,
  };
}

/** Brand tripwires. `SlugSafe` sat three lines above `EntityId` and was missed. */
import type { BrandAssertFalse, BrandAssignable, BrandProbe } from "../types/brand-assertions.js";

type _SlugSafeIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, SlugSafe>>;
type _EntityIdIsBranded = BrandAssertFalse<BrandAssignable<BrandProbe, EntityId>>;
