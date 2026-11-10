/**
 * @file test/fixtures/manifest-dependencies.ts
 * @description Decides whether a published manifest's `dependencies` can be
 * installed by a CONSUMER, which is the only question the packed-manifest guard
 * is allowed to ask.
 *
 * ## Why this module exists
 *
 * A protocol range such as `workspace:*` is a promise this checkout can keep and
 * an embedder cannot: it names a directory in this workspace, not something a
 * registry serves. `npm install <tarball>` fails on it with
 * `EUNSUPPORTEDPROTOCOL`, and that failure happens in someone else's project,
 * against their registry, after publication — the one place we cannot observe
 * it. Until this module existed nothing in the repository read the manifest of
 * an INSTALLED tarball, so "the ranges a consumer receives" was asserted
 * nowhere and could regress invisibly.
 *
 * ## Why the subject is `dependencies` and never the whole manifest
 *
 * No package manager installs the `devDependencies` of a package you install, so
 * a `workspace:*` there is invisible to an embedder by construction. Root
 * `package.json:103-106` carries four of them, they are cosmetic, and
 * `test/declared-dependencies-wiring.test.ts` holds the reasoning — read it
 * before widening this guard. A whole-manifest assertion would also contradict
 * `test/affected-escalation-wiring.test.ts`, which REQUIRES `@repo/kg` to stay
 * `workspace:*` in `devDependencies`.
 *
 * ## Why two halves, negative and positive
 *
 * "No `workspace:` value" is satisfied by an empty or mangled block, so absence
 * alone proves nothing about instalability. The positive half — every value is
 * registry-ranged or URL-shaped — is the claim that a consumer's installer has
 * something to resolve. Both halves read the same grammar, which is why they
 * live here instead of inside either assertion.
 *
 * The grammar is deliberately enumerated rather than regex-monolithic: an exact
 * version, a `^`/`~`/`>=`/`>`/`<`/`<=`/`=` comparator, a `*`/`x` wildcard, an
 * `||` union of those, and the fetchable URL schemes. Anything else — including
 * the local protocols `workspace:`, `file:`, `link:` and `portal:` — is a
 * violation, and a violation is REPORTED by name so a reader sees which entry
 * broke rather than a bare boolean.
 */

/** The workspace protocol prefix: a range that only resolves inside this repo. */
export const WORKSPACE_PROTOCOL_PREFIX = "workspace:";

/** One dependency entry whose range a consumer's installer cannot resolve. */
export interface DependencyViolation {
  readonly name: string;
  readonly range: string;
}

/** Schemes an installer fetches on its own; every other scheme names local state. */
const FETCHABLE_SCHEMES: readonly string[] = [
  "http:",
  "https:",
  "git:",
  "git+",
  "github:",
  "npm:",
];

/** The operators a semver comparator may lead with. */
const RANGE_OPERATORS: readonly string[] = ["^", "~", ">=", ">", "<=", "<", "="];

/** A version alone, or one whose numeric parts are wildcards; prerelease and build allowed. */
const VERSION_TOKEN = /^\d+(?:\.(?:\d+|[xX*]))*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** A literal "any version" token, the semver spellings of a bare wildcard. */
const BARE_WILDCARDS: readonly string[] = ["*", "x", "X"];

/** Branches of a range union, each of which must install independently. */
const UNION_SEPARATOR = "||";

/** Comparators inside one branch of a union. */
const COMPARATOR_SEPARATOR = /\s+/u;

/** The version text of a comparator, without the operator in front of it. */
function stripOperator(token: string): string {
  const operator = RANGE_OPERATORS.find((candidate) => token.startsWith(candidate));
  return operator === undefined ? token : token.slice(operator.length);
}

/** Whether the text states a version, a partial version, or a wildcard. */
function isVersion(token: string): boolean {
  return BARE_WILDCARDS.includes(token) || VERSION_TOKEN.test(token);
}

/** Whether one whitespace-separated token of a range can be compared to a version. */
function isComparator(token: string): boolean {
  return isVersion(stripOperator(token));
}

/** Whether every `||` branch of the range is a non-empty chain of comparators. */
function isRegistryRanged(range: string): boolean {
  return range.split(UNION_SEPARATOR).every((branch) => {
    const tokens = branch.trim().split(COMPARATOR_SEPARATOR).filter((token) => token.length > 0);
    return tokens.length > 0 && tokens.every(isComparator);
  });
}

/** Whether the range is a URL an installer fetches instead of resolving a version. */
function isUrlShaped(range: string): boolean {
  const normalized = range.trim().toLowerCase();
  return FETCHABLE_SCHEMES.some((scheme) => normalized.startsWith(scheme));
}

/**
 * Whether a consumer's installer can resolve this range without this workspace.
 *
 * True for a registry range (exact, ranged, wildcard or `||` union) and for a
 * fetchable URL; false for every local protocol, which is what the guard reports.
 */
export function isConsumerInstallable(range: string): boolean {
  return isUrlShaped(range) || isRegistryRanged(range);
}

/** The entries of a `dependencies` record that {@link isViolation} selects. */
function collectViolations(
  dependencies: Readonly<Record<string, string>> | undefined,
  isViolation: (range: string) => boolean,
): DependencyViolation[] {
  return Object.entries(dependencies ?? {})
    .filter(([, range]) => isViolation(range))
    .map(([name, range]) => ({ name, range }));
}

/** Every dependency a consumer's installer could not resolve, in manifest order. */
export function findUninstallableDependencies(
  dependencies: Readonly<Record<string, string>> | undefined,
): DependencyViolation[] {
  return collectViolations(dependencies, (range) => !isConsumerInstallable(range));
}

/** Every dependency pinned to one of `prefixes`, so the protocol is named explicitly. */
export function findDependenciesByProtocol(
  dependencies: Readonly<Record<string, string>> | undefined,
  prefixes: readonly string[],
): DependencyViolation[] {
  const normalized = prefixes.map((prefix) => prefix.trim().toLowerCase());
  return collectViolations(dependencies, (range) =>
    normalized.some((prefix) => range.trim().toLowerCase().startsWith(prefix)));
}

/** Render violations as `name@range` pairs, so a failure names entries instead of a boolean. */
export function describeDependencyViolations(
  violations: readonly DependencyViolation[],
): string {
  return violations.map((violation) => `${violation.name}@${violation.range}`).join(", ");
}
