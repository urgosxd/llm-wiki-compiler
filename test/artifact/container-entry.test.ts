/**
 * @file test/artifact/container-entry.test.ts
 * @description Guards the two things the container needs before it can start at
 * all: a MANIFEST the frozen install can resolve, and an ENTRYPOINT that names a
 * bundle the build really produces.
 *
 * ## Why this file exists, in one sentence
 *
 * Both halves of the Docker delivery can break while every fast gate stays green,
 * because nothing else in this repository reads the `Dockerfile` or
 * `docker/entry.sh` — and they did break: `docker build` failed at
 * `RUN pnpm install --frozen-lockfile` with `pnpm: not found`, and the image's
 * manifest block was missing a workspace member whose lockfile importer pnpm
 * demands. A unit test that never spawns Docker is the only tier that can catch
 * that on every pull request.
 *
 * ## What it proves
 *
 * 1. **Manifest-COPY completeness, per block.** The members come from the root
 *    manifest's `workspaces` field, read at test time, and NEVER from a list baked
 *    into this file. The Dockerfile now installs TWICE — the `build` stage's
 *    frozen install and the `prod-deps` stage's production install — so every
 *    `COPY` block that closes with a `pnpm install` must carry the complete member
 *    set, not just the first one.
 * 2. **Block equality.** The manifest-COPY blocks are also compared TO EACH OTHER,
 *    which the per-block check cannot do: two stages that drifted in the same way
 *    would each look "internally consistent", and only a sibling comparison says
 *    otherwise.
 * 3. **Why the blocks are discovered, not sliced.** This file used to scan only up
 *    to the FIRST `RUN pnpm install --frozen-lockfile`. When the root image stopped
 *    pruning and gained a second stage, that scan silently stopped one stage too
 *    early — a hole created by the very fix this guard exists to protect. The
 *    blocks are now found by their closing install command, so a third stage is
 *    covered without editing this file.
 * 4. **Lockfile-importers consistency.** The same members must appear as
 *    `pnpm-lock.yaml` importers, whose key format is READ OUT OF THE LOCKFILE (a
 *    two-space-indented `path:` under `importers:`) rather than assumed.
 * 5. **The entrypoint names the launcher.** `docker/entry.sh` must exec
 *    `node /app/dist/api.js` in BOTH host bind shapes and in `serve` mode, and
 *    must not mention `dist/cli.js` at all.
 * 6. **The launcher is a real build output.** `dist/api.js` must map to an
 *    existing tsup entry source and be listed in `REQUIRED_OUTPUTS`, so the build
 *    stamp cannot report a fresh build that lacks the file the image execs.
 *
 * ## What it deliberately does NOT assert
 *
 * It says nothing about `dist/cli.js` leaving `REQUIRED_OUTPUTS` or the tsup
 * entry list. The CLI still exists at the commit that introduces this guard and is
 * scheduled for removal later; asserting its absence here would make this file red
 * for a commit that has not happened yet, which is the opposite of a guard.
 *
 * ## Why no Docker, and no spawn
 *
 * A `docker build` costs minutes and needs a daemon, so it can never be a
 * per-commit check. Every assertion below reads a TRACKED FILE as text or JSON and
 * compares strings. The runtime proof — that the image starts in both modes — is
 * `docker build` plus a real container run, which stays a delivery step and is
 * recorded in `odd/tasks/cli-removal.md`.
 */

import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_OUTPUTS } from "../../scripts/build-stamp.js";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The build recipe whose install layers this file guards. */
const DOCKERFILE = "Dockerfile";

/** The entrypoint script the image execs from `/usr/local/bin`. */
const ENTRY_SCRIPT = "docker/entry.sh";

/** The single workspace lockfile every importer is resolved from. */
const LOCKFILE = "pnpm-lock.yaml";

/** Root manifest whose `workspaces` field is the source of the member list. */
const ROOT_MANIFEST = "package.json";

/** Opens a manifest-COPY block; the block ends at the install command below it. */
const INSTALL_LINE = /^RUN pnpm install /;

/** One `COPY <member>/package.json <member>/` line, capturing the member path. */
const MANIFEST_COPY = /^COPY (\S+)\/package\.json \1\/$/;

/** The bundle the container execs in every mode, as `entry.sh` spells it. */
const LAUNCHER_BUNDLE = "/app/dist/api.js";

/** The tsup output path `REQUIRED_OUTPUTS` and the runtime stage both name. */
const LAUNCHER_OUTPUT = "dist/api.js";

/** The little of the root manifest this file reads. */
interface RootManifest {
  readonly workspaces?: readonly string[];
}

/**
 * Read one tracked file from the repository root.
 *
 * @param relativePath - Repository-relative path.
 * @returns The file's UTF-8 content.
 */
async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), "utf8");
}

/**
 * The workspace members the root manifest declares.
 *
 * Read at test time on purpose: a hard-coded list would pass forever while a new
 * member went uncopied, which is exactly the failure this file is for.
 *
 * @returns Member directories, repository-relative, as the manifest writes them.
 */
async function declaredWorkspaceMembers(): Promise<string[]> {
  const manifest = JSON.parse(await readRepoFile(ROOT_MANIFEST)) as RootManifest;
  const members = manifest.workspaces ?? [];
  expect(members.length, `\`${ROOT_MANIFEST}\` must declare \`workspaces\``).toBeGreaterThan(0);
  return [...members];
}

/**
 * The members that really carry a `package.json`.
 *
 * A declared member without a manifest has nothing to copy, and demanding a COPY
 * of a path that does not exist would fail the build rather than guard it.
 *
 * This is the file's SINGLE derivation of the expected member set: every block is
 * compared against it, so a second derivation could disagree with the first and
 * hide the drift between them.
 *
 * @returns The members whose `<member>/package.json` exists on disk.
 */
async function membersWithManifests(): Promise<string[]> {
  const present: string[] = [];
  for (const member of await declaredWorkspaceMembers()) {
    const manifest = path.join(REPO_ROOT, member, "package.json");
    if (await stat(manifest).catch(() => null)) present.push(member);
  }
  expect(present.length, `no declared workspace member carries a \`package.json\``).toBeGreaterThan(0);
  return present;
}

/**
 * Every manifest-COPY block in the build recipe, in file order.
 *
 * A block is the run of `COPY` lines that ends at one `RUN pnpm install …`, which
 * is how the Dockerfile is written: manifests first, install last, so the
 * dependency layer caches independently of source edits. Comment and blank lines
 * inside that run are part of the block's documentation and are skipped; any other
 * instruction (`RUN`, `WORKDIR`, `FROM`) ends the run, so a block never reaches
 * across a stage boundary.
 *
 * The blocks are found BY their install command rather than by slicing the file at
 * the first one, because the image has two installs (a build stage and a
 * `prod-deps` stage) and a first-match slice silently drops the stages after it —
 * which is the exact hole this file exists to close.
 *
 * @param dockerfile - The whole build recipe.
 * @returns One array of COPY lines per install command, in file order.
 */
function manifestCopyBlocks(dockerfile: string): string[][] {
  const lines = dockerfile.split("\n");
  const blocks: string[][] = [];

  for (const [installAt, line] of lines.entries()) {
    if (!INSTALL_LINE.test(line)) continue;
    const block: string[] = [];
    for (let cursor = installAt - 1; cursor >= 0; cursor -= 1) {
      const candidate = lines[cursor] ?? "";
      if (candidate.startsWith("COPY ")) {
        block.unshift(candidate);
      } else if (candidate.trim() !== "" && !candidate.trimStart().startsWith("#")) {
        break;
      }
    }
    expect(
      block.length,
      `the \`${line}\` block has no manifest-COPY lines above it, so the frozen install would resolve nothing`,
    ).toBeGreaterThan(0);
    blocks.push(block);
  }

  expect(
    blocks.length,
    `\`${DOCKERFILE}\` must run at least one \`pnpm install\`, or the container installs nothing`,
  ).toBeGreaterThan(0);
  return blocks;
}

/**
 * The members one manifest-COPY block carries, sorted for set comparison.
 *
 * @param block - The COPY lines that precede an install command.
 * @returns Sorted member directories named by `COPY <member>/package.json`.
 */
function copiedMembers(block: readonly string[]): string[] {
  return block
    .map((line) => MANIFEST_COPY.exec(line)?.[1])
    .filter((member): member is string => member !== undefined)
    .sort();
}

/**
 * The importer keys of `pnpm-lock.yaml`, parsed from the file rather than assumed.
 *
 * The format is a two-space-indented `path:` line under the top-level
 * `importers:` key; the root importer is the literal `.`. Parsing stops at the
 * first non-indented line, which is the next top-level section.
 *
 * @param lockfile - The whole lockfile.
 * @returns Importer keys, e.g. `.` and `packages/wiki`.
 */
function lockfileImporterKeys(lockfile: string): string[] {
  const header = "\nimporters:\n";
  const start = lockfile.indexOf(header);
  expect(start, `\`${LOCKFILE}\` must contain a top-level \`importers:\` section`).toBeGreaterThan(-1);

  const keys: string[] = [];
  for (const line of lockfile.slice(start + header.length).split("\n")) {
    const importer = /^ {2}(\S[^:]*):$/.exec(line);
    if (importer) {
      keys.push(importer[1]);
    } else if (line.trim() !== "" && !line.startsWith(" ")) {
      break;
    }
  }
  return keys;
}

/**
 * The `set --` command lines inside one shell script, trimmed of leading space.
 *
 * @param script - The whole script.
 * @returns One entry per `set --` line, in file order.
 */
function setCommandLines(script: string): string[] {
  return [...script.matchAll(/^[ \t]*set -- (.+)$/gm)].map((match) => match[1].trim());
}

describe("container workspace manifests", () => {
  it("copies the complete workspace member set into every manifest-COPY block", async () => {
    const expected = (await membersWithManifests()).sort();
    const blocks = manifestCopyBlocks(await readRepoFile(DOCKERFILE));

    const drifted = blocks
      .map((block, index) => ({ index: index + 1, copied: copiedMembers(block) }))
      .filter(({ copied }) => copied.join(",") !== expected.join(","));

    expect(
      drifted,
      `\`${DOCKERFILE}\` has a manifest-COPY block that does not copy the complete workspace member set ` +
        `[${expected.join(", ")}], so the frozen install fails on the missing importer: ` +
        JSON.stringify(drifted),
    ).toEqual([]);
  });

  it("keeps every manifest-COPY block identical to its siblings", async () => {
    const blocks = manifestCopyBlocks(await readRepoFile(DOCKERFILE));
    const perBlock = blocks.map((block, index) => ({ label: `block ${index + 1}`, members: copiedMembers(block).join(", ") }));
    const [first, ...siblings] = perBlock;

    const divergent = siblings.filter((sibling) => sibling.members !== first?.members).map(({ label }) => label);

    expect(
      divergent,
      `every manifest-COPY block must copy exactly the members \`block 1\` copies [${first?.members}]; a stage ` +
        `that drifts from its sibling fails here even when both are wrong the same way: ${JSON.stringify(divergent)}`,
    ).toEqual([]);
  });

  it("resolves every copied workspace manifest from a lockfile importer", async () => {
    const importers = lockfileImporterKeys(await readRepoFile(LOCKFILE));
    const members = await membersWithManifests();

    const unimportered = members.filter((member) => !importers.includes(member));

    expect(
      unimportered,
      `\`${LOCKFILE}\` has no importer for these workspace members, so a frozen install cannot validate them: ` +
        unimportered.map((member) => `\`${member}\``).join(", "),
    ).toEqual([]);
  });
});

describe("container entrypoint", () => {
  it("starts the host listener from the launcher bundle in both bind shapes", async () => {
    const script = await readRepoFile(ENTRY_SCRIPT);

    expect(script, `\`${ENTRY_SCRIPT}\` must never exec the retired CLI bundle`).not.toContain("dist/cli.js");

    const hostShapes = setCommandLines(script).filter((line) => line.includes(" host "));
    expect(hostShapes, `\`${ENTRY_SCRIPT}\` must carry exactly the two host bind shapes`).toHaveLength(2);

    const loopback = hostShapes.filter((line) => !line.includes("--allow-lan"));
    const lan = hostShapes.filter((line) => line.includes("--allow-lan"));
    expect(loopback, `one host shape binds with no flags`).toHaveLength(1);
    expect(lan, `the other host shape opts into the LAN bind`).toHaveLength(1);

    for (const line of hostShapes) {
      expect(line, `every host shape must exec the launcher bundle`).toContain(`node ${LAUNCHER_BUNDLE} host`);
    }
  });

  it("starts the stdio surface from the launcher bundle", async () => {
    const script = await readRepoFile(ENTRY_SCRIPT);
    const serveLines = script.split("\n").filter((line) => /\bexec node \S+ serve\b/.test(line));

    expect(serveLines, `\`${ENTRY_SCRIPT}\` must exec exactly one stdio server`).toHaveLength(1);
    expect(serveLines[0], `the stdio server must be the launcher bundle`).toContain(
      `exec node ${LAUNCHER_BUNDLE} serve`,
    );
  });
});

describe("container launcher artifact", () => {
  it("maps the launcher output to an existing tsup entry source", async () => {
    const tsupConfig = await readRepoFile("tsup.config.ts");
    const entry = /entry:\s*\{\s*api:\s*"([^"]+)"\s*\}/.exec(tsupConfig);

    expect(entry, `\`tsup.config.ts\` must emit \`${LAUNCHER_OUTPUT}\` from a named \`api\` entry`).not.toBeNull();
    const source = entry?.[1] ?? "";
    expect(await stat(path.join(REPO_ROOT, source)).catch(() => null), `the tsup entry source \`${source}\` must exist`)
      .not.toBeNull();
  });

  it("requires the launcher output from the build stamp", () => {
    expect(
      REQUIRED_OUTPUTS,
      `\`REQUIRED_OUTPUTS\` must demand \`${LAUNCHER_OUTPUT}\`, or a build that lacks the entry the image execs reads as fresh`,
    ).toContain(LAUNCHER_OUTPUT);
  });
});
