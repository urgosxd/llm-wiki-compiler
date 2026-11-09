/**
 * @file test/config-prose-rot-guard.test.ts
 * @description Makes configuration and prose rot self-detecting, so the next
 * stale reference fails loudly in CI instead of waiting for the next manual
 * audit.
 *
 * WHY THIS EXISTS. This repository accumulates documents that describe a
 * repository that no longer exists. Each of these was found by hand, one audit
 * at a time: `.fallowrc.json` had 17 of 18 `ignoreExports` entries pointing at
 * files that do not exist; `tsconfig.json` carried alias groups aimed at a
 * deleted directory; `contract-cordination.json` carried 16 dead `sharedPaths`;
 * `AGENTS.md` claimed a three-digit-plus file count for a suite that was
 * smaller; and the header of `scripts/test-partition.ts` carried six counts,
 * every one wrong. None of it was caught by a gate, because no gate read those
 * files.
 *
 * THE RULE THIS TEST OBEYS ITSELF: it DERIVES truth and never bakes it. Every
 * assertion reads the config or document in question and asks the filesystem
 * whether what it names still exists. There is no expected path list, no
 * expected count, and nothing to edit here when the repository grows or shrinks.
 * A test that hardcoded the suite size would be the same defect it exists to
 * catch, one level up — which is why {@link BAKED_COUNT_PATTERNS} rejects any
 * counts in prose rather than checking that a count is right.
 *
 * Each guard is proved twice: once against the real repository, and once against
 * a planted defect fed straight to the same finder, so a guard that quietly
 * degraded into "always returns []" fails instead of passing.
 *
 * SCOPE — what this guard does NOT cover. It proves a name resolves, not that it
 * resolves to the right thing: an alias aimed at the wrong existing file passes.
 * It scans the two prose surfaces that carried count claims (`AGENTS.md` and the
 * `scripts/test-partition.ts` header), not every document in the tree.
 *
 * Unit tier: file reads, JSON parsing and one directory walk. No child process,
 * no git, no database, no network.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file's location so the walk is cwd-independent. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directory names the walk never descends into. `node_modules` and `.worktrees`
 * are mandatory: neither is this repository's content, and a sibling worktree
 * holds a second copy of every path this test asserts about.
 */
const SKIPPED_TREES = new Set(["node_modules", ".git", "dist", ".worktrees", ".llmwiki", "coverage", ".fallow", "baselines"]);

/** Only configs with this basename shape declare compiler options a consumer resolves. */
const TSCONFIG_NAME = /^tsconfig.*\.json$/;

/**
 * The two prose surfaces that carried baked suite-size counts. `AGENTS.md` is
 * scanned whole; a `.ts` file is scanned through its header comment only, since
 * a count inside code is a constant, not prose.
 */
const PROSE_FILES = ["AGENTS.md", "scripts/test-partition.ts"];

/**
 * Count phrasing that must never appear as prose again: a three-digit-or-more
 * number (comma separators allowed, optional `+`) directly followed by
 * `files`/`tests`.
 *
 * NARROWED DELIBERATELY against the content that exists today. `AGENTS.md`
 * carries durations and sizes — "~9 minutes", "~42 s", "~48 s", "400-line
 * files", "40-line functions" — and none of them is a count of files or tests.
 * So the unit must be the literal word `files`/`tests` separated from the number
 * by whitespace only: a hyphenated "400-line files" is a size, and a duration
 * carries a time unit, so both are out of scope by construction rather than by
 * an exception list.
 */
const BAKED_COUNT_PATTERNS = [
  /\b(?:\d{1,3}(?:,\d{3})+|\d{3,})\+?\s+(?:test\s+)?(?:files|tests)\b/g,
  /\b(?:one|two|three|four|five|six|seven|eight|nine)\s+(?:hundred|thousand)\+?\s+(?:test\s+)?(?:files|tests)\b/gi,
  /\b(?:hundreds|thousands)\s+of\s+(?:test\s+)?(?:files|tests)\b/gi,
];

/** The slice of `.fallowrc.json` this guard reads. */
interface FallowConfig {
  ignoreExports?: { file: string }[];
}

/** The slice of a `tsconfig*.json` this guard reads. */
interface TsConfigFile {
  compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
}

/** The slice of `contract-cordination.json` this guard reads. */
interface CoordinationContract {
  sharedPaths?: string[];
}

/** Answers "does this config-declared path exist?" for a finder under test. */
type Resolver = (target: string) => boolean;

/** Repository-relative POSIX paths of every file under `REPO_ROOT` the walk reaches. */
function listRepositoryFiles(): string[] {
  const found: string[] = [];
  collectFiles(REPO_ROOT, found);
  return found;
}

/** Depth-first file collection, skipping the trees that are not repository content. */
function collectFiles(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_TREES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(full, found);
    else found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
  }
}

/** Compile a repository-relative glob: `**` spans separators, `*` does not. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*|\*/g, (run) => (run === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${escaped}$`);
}

/**
 * A resolver backed by the real filesystem: a wildcard target resolves when at
 * least one on-disk file matches it, and a literal target resolves when it
 * exists as a file or a directory.
 */
function filesystemResolver(files: readonly string[]): Resolver {
  return (target) => {
    const normalized = target.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized.includes("*")) return existsSync(path.join(REPO_ROOT, normalized));
    const matcher = globToRegExp(normalized);
    return files.some((file) => matcher.test(file));
  };
}

/**
 * Re-base a config-declared target onto the directory the TypeScript compiler
 * would use, which is the config's own directory unless it declares a
 * `compilerOptions.baseUrl` — in which case `paths` are resolved against
 * `baseUrl`, itself relative to the config file. Resolving against the
 * repository root instead would check a nested config such as
 * `packages/llmwiki-kg/ts/tsconfig.json` against paths it never meant, and a
 * root-level file with the same tail would make a dead alias look alive.
 */
function resolveAgainst(configPath: string, baseUrl: string | undefined, target: string): string {
  const origin = path.posix.join(path.posix.dirname(configPath), baseUrl ?? ".");
  return origin === "." ? target : path.posix.join(origin, target);
}

/** Read and parse a repository JSON file. */
function readRepositoryJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8")) as T;
}

/** Read a repository text file. */
function readRepositoryText(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

/** Every `ignoreExports[].file` in the fallow config that no longer exists. */
function findDeadIgnoreExports(config: FallowConfig, resolves: Resolver): string[] {
  return (config.ignoreExports ?? [])
    .map((entry) => entry.file)
    .filter((file) => !resolves(file))
    .map((file) => `.fallowrc.json ignoreExports[].file does not exist: ${file}`);
}

/** Every alias target a config declares that no longer resolves, with config, key and target named. */
function findDeadAliasTargets(configPath: string, config: TsConfigFile, resolves: Resolver): string[] {
  return Object.entries(config.compilerOptions?.paths ?? {}).flatMap(([alias, targets]) =>
    targets
      .filter((target) => !resolves(resolveAgainst(configPath, config.compilerOptions?.baseUrl, target)))
      .map((target) => `${configPath} compilerOptions.paths["${alias}"] target does not resolve: ${target}`),
  );
}

/**
 * Every `sharedPaths` entry that no longer exists.
 *
 * NO ALLOWLIST, ON PURPOSE. An allowlist is what turns this guard back into
 * prose: each entry is an exemption a future reader has to trust. Every entry in
 * the contract can exist by design, so none is exempt, and a future entry that
 * genuinely cannot exist should be argued for here in a comment before it is
 * excused.
 */
function findDeadSharedPaths(contract: CoordinationContract, resolves: Resolver): string[] {
  return (contract.sharedPaths ?? [])
    .filter((entry) => !resolves(entry))
    .map((entry) => `contract-cordination.json sharedPaths entry does not exist: ${entry}`);
}

/** The prose region of a document: the whole file, or a `.ts` file's header comment. */
function proseRegion(relative: string, text: string): string {
  if (!relative.endsWith(".ts")) return text;
  return /^\/\*\*([\s\S]*?)\*\//.exec(text)?.[1] ?? "";
}

/** Every baked suite-size count in one document's prose, quoted with its file. */
function findBakedCounts(relative: string, text: string): string[] {
  const region = proseRegion(relative, text);
  return BAKED_COUNT_PATTERNS.flatMap((pattern) =>
    [...region.matchAll(pattern)].map((match) => `${relative} carries a baked suite-size count in prose: "${match[0]}"`),
  );
}

describe("fallow ignoreExports guard", () => {
  it("every .fallowrc.json ignoreExports file exists", () => {
    const dead = findDeadIgnoreExports(readRepositoryJson<FallowConfig>(".fallowrc.json"), filesystemResolver(listRepositoryFiles()));
    expect(dead).toEqual([]);
  });

  it("the ignoreExports guard reports a planted dead file by path", () => {
    const config: FallowConfig = { ignoreExports: [{ file: "packages/wiki/src/utils/output.ts" }, { file: "src/gone/deleted.ts" }] };
    expect(findDeadIgnoreExports(config, filesystemResolver(listRepositoryFiles()))).toEqual([
      ".fallowrc.json ignoreExports[].file does not exist: src/gone/deleted.ts",
    ]);
  });

});

describe("tsconfig alias target guard", () => {
  it("every tsconfig that declares compilerOptions.paths resolves all of its targets", () => {
    const files = listRepositoryFiles();
    const resolves = filesystemResolver(files);
    const dead = files
      .filter((file) => TSCONFIG_NAME.test(path.posix.basename(file)))
      .flatMap((file) => findDeadAliasTargets(file, readRepositoryJson<TsConfigFile>(file), resolves));
    expect(dead).toEqual([]);
  });

  it("the alias guard reports a planted dead target with config, key and target, and resolves wildcards", () => {
    const config: TsConfigFile = { compilerOptions: { paths: { "gone-alias": ["./src/deleted/*"], "live-alias": ["./packages/wiki/src/utils/*.ts"] } } };
    expect(findDeadAliasTargets("tsconfig.json", config, filesystemResolver(listRepositoryFiles()))).toEqual([
      'tsconfig.json compilerOptions.paths["gone-alias"] target does not resolve: ./src/deleted/*',
    ]);
  });

  it("the alias guard resolves a nested config's targets against that config's own directory", () => {
    // The discriminator: `./src/server.ts` exists inside
    // `packages/llmwiki-kg/ts/` and does not exist at the repository root, so a
    // root-relative resolver reports it dead and a config-relative one does not.
    // The ghost target fails under both readings, proving the finder still runs.
    const config: TsConfigFile = { compilerOptions: { paths: { nested: ["./src/server.ts"], ghost: ["./src/does-not-exist.ts"] } } };
    expect(findDeadAliasTargets("packages/llmwiki-kg/ts/tsconfig.json", config, filesystemResolver(listRepositoryFiles()))).toEqual([
      'packages/llmwiki-kg/ts/tsconfig.json compilerOptions.paths["ghost"] target does not resolve: ./src/does-not-exist.ts',
    ]);
  });

  it("the alias guard resolves a declared baseUrl instead of the config directory", () => {
    // TypeScript resolves `paths` against `baseUrl` when a config declares one,
    // so a guard that ignored it would report a live alias dead and invite
    // somebody to "fix" the guard by weakening it. THE DISCRIMINATOR IS CHECKED
    // AGAINST THE REAL TREE, NOT ASSERTED FROM MEMORY: the target must exist
    // under `baseUrl` and must not exist relative to the config's directory, so
    // the two resolutions disagree. If that ever stops being true this test
    // fails loudly instead of decaying into a guard that proves nothing.
    const configPath = "tsconfig.json";
    const baseUrl = "./packages/wiki/src/utils";
    const target = "./output.ts";
    expect(existsSync(path.join(REPO_ROOT, "packages/wiki/src/utils/output.ts")), "discriminator lost: the target is not on disk under baseUrl").toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "output.ts")), "discriminator lost: the target now also exists relative to the config directory").toBe(false);
    const config: TsConfigFile = { compilerOptions: { baseUrl, paths: { "from-base-url": [target], ghost: ["./does-not-exist.ts"] } } };
    expect(findDeadAliasTargets(configPath, config, filesystemResolver(listRepositoryFiles()))).toEqual([
      'tsconfig.json compilerOptions.paths["ghost"] target does not resolve: ./does-not-exist.ts',
    ]);
  });

});

describe("coordination sharedPaths guard", () => {
  it("every contract-cordination.json sharedPaths entry exists", () => {
    const dead = findDeadSharedPaths(readRepositoryJson<CoordinationContract>("contract-cordination.json"), filesystemResolver(listRepositoryFiles()));
    expect(dead).toEqual([]);
  });

  it("the sharedPaths guard reports a planted dead entry by path", () => {
    const contract: CoordinationContract = { sharedPaths: ["packages/wiki/src/utils/**", "src/ghost/**", "tsconfig*.json"] };
    expect(findDeadSharedPaths(contract, filesystemResolver(listRepositoryFiles()))).toEqual([
      "contract-cordination.json sharedPaths entry does not exist: src/ghost/**",
    ]);
  });

});

describe("guards are not silently vacuous", () => {
  it("every config guard derives a non-empty collection from the real repository", () => {
    // A finder that falls back to `?? []` passes forever if a future commit
    // renames the key it reads: the guard stops checking and CI stays green.
    // Derived, never baked: each assertion only asserts that the collection the
    // guard walks is non-empty, with no path, alias or count written down here.
    const discovered = listRepositoryFiles().filter((file) => TSCONFIG_NAME.test(path.posix.basename(file)));
    const ignoreExports = readRepositoryJson<FallowConfig>(".fallowrc.json").ignoreExports ?? [];
    expect(ignoreExports.length, ".fallowrc.json ignoreExports is empty: the ignoreExports guard would check nothing").toBeGreaterThan(0);
    const sharedPaths = readRepositoryJson<CoordinationContract>("contract-cordination.json").sharedPaths ?? [];
    expect(sharedPaths.length, "contract-cordination.json sharedPaths is empty: the sharedPaths guard would check nothing").toBeGreaterThan(0);
    const declaringPaths = discovered.filter((file) => Object.keys(readRepositoryJson<TsConfigFile>(file).compilerOptions?.paths ?? {}).length > 0);
    expect(declaringPaths.length, `no tsconfig*.json declares compilerOptions.paths: the alias guard would check nothing (discovered: ${discovered.join(", ")})`).toBeGreaterThan(0);
  });

});

describe("prose baked-count guard", () => {
  it("AGENTS.md and the test-partition header carry no baked suite-size count", () => {
    const texts = PROSE_FILES.map((file) => readRepositoryText(file));
    expect(texts.map((text, index) => proseRegion(PROSE_FILES[index] ?? "", text).trim().length > 0)).toEqual([true, true]);
    expect(PROSE_FILES.flatMap((file, index) => findBakedCounts(file, texts[index] ?? ""))).toEqual([]);
  });

  it("the prose guard reports planted counts and ignores durations, hyphenated sizes and code", () => {
    const planted = "Runs in ~9 minutes. The tree has 1300+ files, 12,000 tests and three hundred files. 400-line files are fine; ~42 s is a build.";
    expect(findBakedCounts("AGENTS.md", planted)).toEqual([
      'AGENTS.md carries a baked suite-size count in prose: "1300+ files"',
      'AGENTS.md carries a baked suite-size count in prose: "12,000 tests"',
      'AGENTS.md carries a baked suite-size count in prose: "three hundred files"',
    ]);
    expect(findBakedCounts("scripts/test-partition.ts", "/** Units run fast. */\nconst FILES = 918; // 918 files here is code, not prose\n")).toEqual([]);
  });
});
