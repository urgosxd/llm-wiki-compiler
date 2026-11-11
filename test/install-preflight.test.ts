/**
 * @file Refuse a checkout installed by the wrong package manager, BEFORE the
 * first confusing failure, under a message that names the command that fixes it.
 *
 * A checkout whose `node_modules` came from npm carries
 * `node_modules/.package-lock.json`, and npm never reads the pnpm workspace, so
 * `node_modules/@repo/{api,foundation,kg,wiki}` is never created. The suite then
 * dies at collection with `Cannot find package
 * '@repo/kg/testing/per-run-database'` — an error naming an internal workspace
 * export, which tells the reader nothing about the cause. This case pins the
 * diagnosis instead: which state was found, what it means, and the one command
 * that repairs it.
 *
 * The detection lives in a PURE module (`test/fixtures/install-preflight.ts`),
 * because a `globalSetup` hook cannot be observed RED by a normal test. Every
 * assertion below therefore goes through the public function `diagnoseInstallTree`
 * and never renders the hook.
 *
 * The refusal messages are asserted VERBATIM against local constants, so a
 * paraphrase, a reordering, or a shortened "run pnpm install" fails here rather
 * than reaching a reader who is already confused.
 */
import { describe, expect, it } from "vitest";
import {
  INSTALL_COMMAND,
  NPM_TREE_MARKER,
  PNPM_TREE_MARKER,
  WORKSPACE_PACKAGES,
  diagnoseInstallTree,
  type InstallProblem,
  workspaceLinkPath,
} from "./fixtures/install-preflight.js";

/** Every `@repo/*` link a healthy tree carries, in `WORKSPACE_PACKAGES` order. */
const ALL_LINKS = WORKSPACE_PACKAGES.map(workspaceLinkPath);

/**
 * Run the preflight and narrow the union to its refusal arm.
 *
 * A matcher narrows nothing for the compiler: after `expect(verdict.ok).toBe(false)`
 * the verdict is still the whole `InstallVerdict` union, so reading `.problem` and
 * `.message` is a type error on the `{ ok: true }` arm and the test type-check ratchet
 * refuses the new diagnostic. A control-flow check is what TypeScript does narrow on,
 * so the narrowing lives here instead of in a matcher — and it still FAILS the test
 * when a tree that should have been refused came back healthy, which is the assertion
 * the matcher was making.
 *
 * @param present - Repo-relative paths known to exist, as `diagnoseInstallTree` takes them.
 * @returns The refusal's problem label and its exact message.
 */
function refusalFrom(present: readonly string[]): { problem: InstallProblem; message: string } {
  const verdict = diagnoseInstallTree(present);
  if (verdict.ok) throw new Error("expected the install preflight to refuse, but it reported a healthy tree");
  return { problem: verdict.problem, message: verdict.message };
}

/** Found an npm-installed tree: `.package-lock.json` exists. */
const MESSAGE_NPM_TREE =
  `Found node_modules/.package-lock.json, so this checkout's node_modules was installed by npm, not pnpm. ` +
  `npm does not read the pnpm workspace, so the node_modules/@repo/* links the test suite imports never get created, ` +
  `and collection fails with "Cannot find package '@repo/kg/testing/per-run-database'" — an error that names an ` +
  `internal export instead of the cause. Run \`corepack pnpm install --frozen-lockfile\` in the repository root to ` +
  `install the workspace with pnpm; the lockfile is authoritative, so that one command is the whole fix.`;

/** Found no pnpm layout at all: `node_modules/.pnpm` is absent. */
const MESSAGE_NO_PNPM_TREE =
  `Found no node_modules/.pnpm, so this checkout's node_modules is not a pnpm-installed tree. ` +
  `The node_modules/@repo/* links the test suite imports live in that pnpm layout, so without it collection fails ` +
  `with "Cannot find package '@repo/kg/testing/per-run-database'" — an error that names an internal export instead ` +
  `of the cause. Run \`corepack pnpm install --frozen-lockfile\` in the repository root to install the workspace ` +
  `with pnpm; the lockfile is authoritative, so that one command is the whole fix.`;

/** pnpm tree present, but the workspace links inside it are missing. */
const MESSAGE_MISSING_LINK =
  `Found a pnpm tree, but these workspace links are missing: node_modules/@repo/kg. ` +
  `Each one is a link into the workspace that pnpm creates, and a test importing it fails with "Cannot find package" ` +
  `— an error that names an internal export instead of the cause. Run \`corepack pnpm install --frozen-lockfile\` in ` +
  `the repository root to recreate them; the lockfile is authoritative, so that one command is the whole fix.`;

describe("diagnoseInstallTree", () => {
  it("refuses an npm-installed tree and names the install command", () => {
    const verdict = refusalFrom([NPM_TREE_MARKER]);

    expect(verdict).toEqual({
      problem: "not-a-pnpm-tree",
      message: MESSAGE_NPM_TREE,
    });
    expect(verdict.message).toContain(INSTALL_COMMAND);
  });

  it("refuses a tree with no pnpm layout even when the links are there", () => {
    const verdict = refusalFrom(ALL_LINKS);

    expect(verdict).toEqual({
      problem: "not-a-pnpm-tree",
      message: MESSAGE_NO_PNPM_TREE,
    });
  });

  it("refuses a pnpm tree whose workspace links are missing, naming each one", () => {
    const present = [PNPM_TREE_MARKER, ...ALL_LINKS.filter((link) => link !== "node_modules/@repo/kg")];
    const verdict = refusalFrom(present);

    expect(verdict).toEqual({
      problem: "missing-workspace-links",
      message: MESSAGE_MISSING_LINK,
    });
    expect(verdict.message).toContain("node_modules/@repo/kg");
  });

  // The rule that matters most: a check that fires on a correct tree makes every session red.
  it("does not refuse a healthy tree", () => {
    const verdict = diagnoseInstallTree([PNPM_TREE_MARKER, ...ALL_LINKS]);

    expect(verdict).toStrictEqual({ ok: true });
    // The healthy arm carries no message; `in` reads that safely off the union, which
    // the removed `.message` access could not do without failing the test type-check.
    expect("message" in verdict).toBe(false);
  });
});

/**
 * Every state that can reach a refusal, in the order the diagnosis tests them.
 *
 * Module scope, not the test body: three inline tree literals push the enclosing
 * `describe` past this repo's 39-line function ceiling, and the trees are fixture
 * data rather than steps of one test.
 */
const REFUSING_TREES = [
  // The npm marker: an npm-created tree, so the workspace links never existed.
  [NPM_TREE_MARKER],
  // Every link present, but no pnpm layout at all.
  ALL_LINKS,
  // A pnpm tree that lost one workspace link.
  [PNPM_TREE_MARKER, ...ALL_LINKS.filter((link) => link !== workspaceLinkPath("kg"))],
] as const;

// S3 and S4 hold for EVERY state that can refuse, not only the two that name the command.
describe("refusal messages", () => {
  it("every refusal carries the install command and never recommends destroying node_modules", () => {
    for (const present of REFUSING_TREES) {
      const { message } = refusalFrom(present);

      expect(message).toContain(INSTALL_COMMAND);
      // A fix that begins with destruction is not a fix: the command recreates the tree itself.
      expect(message).not.toMatch(/delete|rm -rf|remove node_modules/i);
    }
  });
});
