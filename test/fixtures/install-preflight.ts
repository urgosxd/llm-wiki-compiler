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
 * THE TWO STATES. (a) Not a pnpm tree: `node_modules/.package-lock.json` exists
 * (npm created the tree, and npm never reads the pnpm workspace, so the
 * `node_modules/@repo/*` links were never created) or `node_modules/.pnpm` is
 * absent. (b) pnpm tree present but one or more `node_modules/@repo/*` links
 * missing, which leaves the same broken imports behind a healthier-looking tree.
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

/** Repo-relative path npm leaves behind. Its presence means "an npm tree, not a pnpm workspace". */
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
 * Message for state A1: the npm marker proves the tree came from npm.
 *
 * Names the npm install as the cause, because the reader's instinct is to blame
 * the workspace rather than the package manager that never read it.
 *
 * @returns The refusal message for a tree carrying {@link NPM_TREE_MARKER}.
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
 * Decide from the set of repo-relative paths that exist.
 *
 * Pure: no filesystem access, so a test can describe a tree exactly. The order of
 * the checks is the diagnosis order — an npm marker contradicts a pnpm tree even
 * when `.pnpm` survived, and a missing tree is a stronger finding than a missing
 * link inside one. Each message is built by a named helper, so this function
 * reads as three guards over the finding and one healthy-tree fall-through.
 *
 * @param present - Repo-relative paths known to exist. Compared by exact string.
 * @returns `{ ok: true }` for a healthy tree, otherwise the problem and its exact message.
 */
export function diagnoseInstallTree(present: Iterable<string>): InstallVerdict {
  const paths = new Set(present);

  if (paths.has(NPM_TREE_MARKER)) {
    return { ok: false, problem: "not-a-pnpm-tree", message: npmTreeMessage() };
  }

  if (!paths.has(PNPM_TREE_MARKER)) {
    return { ok: false, problem: "not-a-pnpm-tree", message: noPnpmTreeMessage() };
  }

  const missing = missingWorkspaceLinks(paths);

  if (missing.length > 0) {
    return { ok: false, problem: "missing-workspace-links", message: missingWorkspaceLinksMessage(missing) };
  }

  return { ok: true };
}
