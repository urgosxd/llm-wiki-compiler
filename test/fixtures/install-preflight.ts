/**
 * @file `test/fixtures/install-preflight.ts`
 * @description Diagnose a `node_modules` tree that the test suite cannot import
 * from, and return the refusal message that names the command that repairs it.
 *
 * WHY THIS MODULE IS PURE. A `globalSetup` hook cannot be observed RED by a
 * normal test: it runs before every file and its failure is a suite-level crash,
 * not an assertion. So the detection lives here — input: the set of repo-relative
 * paths that exist; output: a verdict plus a message — and `test/global-setup.ts`
 * is left with nothing but the filesystem read that feeds it. That seam is what
 * lets `test/install-preflight.test.ts` pin each rule, including the one that
 * matters most: a healthy tree must NOT refuse, because a check that fires on a
 * correct tree makes every session red.
 *
 * WHY IT IMPORTS NOTHING. Not a single `@repo/*` import may appear here: the
 * unresolvability of those packages is the exact condition being detected, so an
 * import of one would fail at load with the very misleading
 * `Cannot find package '@repo/kg/testing/per-run-database'` error this module
 * exists to replace. Node builtins are equally absent — there is no filesystem
 * access at all, only string paths and a set membership test.
 *
 * THE TWO STATES. (a) Not a pnpm tree: `node_modules/.pnpm` is absent — and ONLY then does
 * `node_modules/.package-lock.json` say who made the tree (npm created it, and npm never reads
 * the pnpm workspace, so the `node_modules/@repo/*` links were never created). The marker is a
 * LEFTOVER rather than a diagnosis once `.pnpm` exists: an npm install can run first and leave
 * its marker behind while pnpm then builds the workspace over it, and reading the marker first
 * refuses that tree while blaming npm for a `node_modules` pnpm built. (b) pnpm tree present but
 * one or more `node_modules/@repo/*` links missing, which leaves the same broken imports behind
 * a healthier-looking tree.
 *
 * NO MESSAGE HERE TELLS THE READER TO DELETE `node_modules`. A fix that begins
 * with destruction is not a fix; `corepack pnpm install --frozen-lockfile` is
 * authoritative through the lockfile and recreates the tree and its links itself.
 */

/**
 * The one command that repairs every state diagnosed here.
 *
 * Interpolated into each refusal message, and exported so callers and tests can
 * refer to the command instead of re-typing it.
 */
export const INSTALL_COMMAND = "corepack pnpm install --frozen-lockfile";

/** Repo-relative path of the directory a pnpm install creates. Its absence means "not a pnpm tree". */
export const PNPM_TREE_MARKER = "node_modules/.pnpm";

/**
 * Repo-relative path npm leaves behind, and the marker that names npm as the installer.
 *
 * Read as "an npm tree" only when {@link PNPM_TREE_MARKER} is ABSENT: npm can install first
 * and leave this behind while pnpm builds the workspace over it.
 */
export const NPM_TREE_MARKER = "node_modules/.package-lock.json";

/** The workspace packages whose `@repo/*` links the test suite imports. */
export const WORKSPACE_PACKAGES = ["api", "foundation", "kg", "wiki"] as const;

/** One element of {@link WORKSPACE_PACKAGES}. */
export type WorkspacePackage = (typeof WORKSPACE_PACKAGES)[number];

/**
 * Repo-relative path of the pnpm workspace link for one package.
 *
 * @param name - Workspace package name, e.g. `"kg"`.
 * @returns The link path, e.g. `"node_modules/@repo/kg"`.
 */
export function workspaceLinkPath(name: WorkspacePackage): string {
  return `node_modules/@repo/${name}`;
}

/**
 * Every repo-relative path this check looks at, markers first.
 *
 * Markers lead so a reader (and the `global-setup.ts` reader that fills the
 * present set) sees the tree-level diagnosis before the per-link detail.
 *
 * @returns The pnpm marker, the npm marker, then one link path per workspace package.
 */
export function installProbePaths(): readonly string[] {
  return [PNPM_TREE_MARKER, NPM_TREE_MARKER, ...WORKSPACE_PACKAGES.map(workspaceLinkPath)];
}

/** Which state a broken tree is in. See {@link InstallVerdict}. */
export type InstallProblem = "not-a-pnpm-tree" | "missing-workspace-links";

/** The verdict: healthy, or a named problem carrying the message to refuse with. */
export type InstallVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: InstallProblem; readonly message: string };

/**
 * The sentence pair every "not a pnpm tree" refusal ends with: the misleading
 * error the broken imports produce, then the one command that repairs the tree.
 *
 * Shared by both tree-level variants because only the finding differs; a reader
 * who hits either needs the same symptom named and the same fix. Kept verbatim
 * in one place so the two variants cannot drift apart.
 *
 * @returns The symptom and fix sentences, in that order.
 */
function notAPnpmTreeTail(): string {
  return (
    `"Cannot find package '@repo/kg/testing/per-run-database'" — an error that names an internal export ` +
    `instead of the cause. Run \`${INSTALL_COMMAND}\` in the repository root to install the workspace with ` +
    `pnpm; the lockfile is authoritative, so that one command is the whole fix.`
  );
}

/**
 * Message for state A1: no pnpm layout, and the npm marker says who made what is there.
 *
 * Names the npm install as the cause, because the reader's instinct is to blame
 * the workspace rather than the package manager that never read it.
 *
 * @returns The refusal message for a tree carrying {@link NPM_TREE_MARKER} and no {@link PNPM_TREE_MARKER}.
 */
function npmTreeMessage(): string {
  return (
    `Found ${NPM_TREE_MARKER}, so this checkout's node_modules was installed by npm, not pnpm. ` +
    `npm does not read the pnpm workspace, so the node_modules/@repo/* links the test suite imports never get ` +
    `created, and collection fails with ` +
    notAPnpmTreeTail()
  );
}

/**
 * Message for state A2: no npm marker, but no pnpm layout either.
 *
 * A missing `.pnpm` cannot say which manager created the tree, so this message
 * states only what was observed and what its absence means.
 *
 * @returns The refusal message for a tree without {@link PNPM_TREE_MARKER}.
 */
function noPnpmTreeMessage(): string {
  return (
    `Found no ${PNPM_TREE_MARKER}, so this checkout's node_modules is not a pnpm-installed tree. ` +
    `The node_modules/@repo/* links the test suite imports live in that pnpm layout, so without it collection ` +
    `fails with ` +
    notAPnpmTreeTail()
  );
}

/**
 * Which `@repo/*` links a tree is missing, in {@link WORKSPACE_PACKAGES} order.
 *
 * @param paths - Repo-relative paths known to exist, compared by exact string.
 * @returns The absent link paths; empty for a tree that has every link.
 */
function missingWorkspaceLinks(paths: ReadonlySet<string>): readonly string[] {
  return WORKSPACE_PACKAGES.map(workspaceLinkPath).filter((link) => !paths.has(link));
}

/**
 * Message for state B: a pnpm tree that lost one or more workspace links.
 *
 * Names every missing link rather than only the first, because a partial install
 * usually loses several at once and one at a time sends the reader back here.
 *
 * @param missing - The absent link paths, as {@link missingWorkspaceLinks} returns them.
 * @returns The refusal message naming each missing link.
 */
function missingWorkspaceLinksMessage(missing: readonly string[]): string {
  return (
    `Found a pnpm tree, but these workspace links are missing: ${missing.join(", ")}. ` +
    `Each one is a link into the workspace that pnpm creates, and a test importing it fails with ` +
    `"Cannot find package" — an error that names an internal export instead of the cause. Run ` +
    `\`${INSTALL_COMMAND}\` in the repository root to recreate them; the lockfile is authoritative, so that ` +
    `one command is the whole fix.`
  );
}

/**
 * Message for state A1 or state A2: which manager built a tree that has no pnpm layout.
 *
 * The two variants differ only in what was observed — npm's marker, or nothing at all —
 * because a reader who can be told the cause should be, and a reader facing a bare
 * directory needs the absence stated rather than a manager guessed at.
 *
 * @param paths - Repo-relative paths known to exist, already known to lack {@link PNPM_TREE_MARKER}.
 * @returns The refusal message for state A1 or state A2.
 */
function noPnpmLayoutMessage(paths: ReadonlySet<string>): string {
  return paths.has(NPM_TREE_MARKER) ? npmTreeMessage() : noPnpmTreeMessage();
}

/**
 * Decide from the set of repo-relative paths that exist.
 *
 * Pure: no filesystem access, so a test can describe a tree exactly. The order of
 * the checks is the diagnosis order, and that order is load-bearing: the pnpm layout
 * decides FIRST, and only a tree without it is asked whether npm left a marker. The
 * marker survives an npm install that pnpm later built over, so a single checkout can
 * hold both and reading the marker first refuses a tree pnpm installed. A missing tree
 * is a stronger finding than a missing link inside one, so the links come last. Each
 * message is built by a named helper, so this function reads as two guards over the
 * finding and one healthy-tree fall-through.
 *
 * @param present - Repo-relative paths known to exist. Compared by exact string.
 * @returns `{ ok: true }` for a healthy tree, otherwise the problem and its exact message.
 */
export function diagnoseInstallTree(present: Iterable<string>): InstallVerdict {
  const paths = new Set(present);

  if (!paths.has(PNPM_TREE_MARKER)) {
    return { ok: false, problem: "not-a-pnpm-tree", message: noPnpmLayoutMessage(paths) };
  }

  const missing = missingWorkspaceLinks(paths);

  if (missing.length > 0) {
    return { ok: false, problem: "missing-workspace-links", message: missingWorkspaceLinksMessage(missing) };
  }

  return { ok: true };
}
