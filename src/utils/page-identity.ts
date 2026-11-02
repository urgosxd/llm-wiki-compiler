/**
 * @file src/utils/page-identity.ts
 * @description The two identity predicates every page path and slug must satisfy.
 *
 * ## Why these live in `utils` and not in `profile`
 *
 * Both were defined in `profile/identity.ts` alongside the branded `EntityId`
 * primitives, and the profile system is gone. But these two are NOT about
 * entities: they are the floor a DEFAULT page filename and a slug are held to,
 * and 22 and 37 call sites respectively depend on them — path confinement,
 * the write planner, the candidate store, the viewer.
 *
 * Moving them here rather than deleting them with their old neighbourhood is the
 * whole point: the entity brand was incidental, the safety check is not.
 *
 * ## The two grammars are deliberately different
 *
 * `isSlugSafe` is the strict ASCII slug grammar. `isSafeFilenameComponent` is
 * the looser FILESYSTEM floor that default pages keep: a default page retains its
 * Unicode `slugify` stem (`café-society`, `机器学习`), so a Unicode letter must
 * pass while a path separator, a space, a NUL, the dot-only names and a
 * leading-dot name must not. Collapsing the two would either reject legitimate
 * Unicode slugs or admit a traversal.
 */

/** The slug-safe grammar: lowercase alphanumerics and internal hyphens. */
const SLUG_SAFE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Type guard: does `s` match the strict slug-safe grammar?
 *
 * @param s - Candidate slug.
 * @returns True when `s` is lowercase alphanumerics with internal hyphens only.
 */
export function isSlugSafe(s: string): boolean {
  return SLUG_SAFE_PATTERN.test(s);
}

/**
 * The DEFAULT-page identity floor: is `s` a single safe path component?
 *
 * Allows Unicode letters/digits/hyphens (whatever `slugify` produces) while
 * rejecting anything that could escape or hide the file: path separators (`/`,
 * `\`), spaces, NUL, the dot-only names `.`/`..`, and a leading-dot (hidden)
 * name.
 *
 * @param s - Candidate filename component.
 * @returns True when `s` is safe as one path segment.
 */
export function isSafeFilenameComponent(s: string): boolean {
  return s.length > 0 && !/[/\\ \0]/.test(s) && s !== "." && s !== ".." && !s.startsWith(".");
}
