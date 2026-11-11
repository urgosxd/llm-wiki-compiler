/**
 * @file Derive which collected test files reach a given source file, by crawling vite's module graph.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `vitest related`. The per-package test
 * selection this feeds must be DERIVED, never enumerated: a hand-written path list
 * rots the moment someone adds a directory, and nothing fails when it does.
 * `vitest related` builds exactly the graph that is wanted — aliases from
 * `vitest.config.ts`, resolution as vitest itself resolves — but it cannot return
 * the selection as data. Its CLI takes file paths, `--filesOnly` and
 * `--testNamePattern`; it prints selected files and offers no flag that yields the
 * set. Worse, an argument matching no collected file (`related <dir>`, a glob)
 * contributes no reverse-dependency edges and exits `0` with an empty selection —
 * green having run nothing. So this module drives the same graph directly, with the
 * same config, and is pinned to `related`'s answers by
 * `test/module-graph-crawl.test.ts`.
 *
 * WHY `transformRequest` AND NOT `ssrLoadModule`. `transformRequest` parses and
 * records a module's imports without executing its top level or any test body, so a
 * crawl of the whole suite is a read, not a run: no `dist/`, no database, no
 * `globalSetup`. `ssrLoadModule` executes, which would make a selection pass cost
 * what a test run costs and would import every fixture's side effects.
 *
 * WHY TWO PASSES. `transformRequest` records only the imports of the module it is
 * given. Transforming the test files alone therefore yields depth-1 closures —
 * "tests that import this source directly" — and silently misses everything one hop
 * further out. The crawl is a fixed point: transform every discovered in-repo
 * module that has not been transformed yet, until no new module appears. That second
 * phase is load-bearing, and the parity fixture proves it: the same pair of inputs
 * selects 23 files against 6 for the first one, a contrast a single pass cannot
 * produce.
 *
 * PURE BY CONTRACT. No child process, no network, no database, no writes inside the
 * repository. The only filesystem effect is vite's cache, which is placed in a
 * fresh OS temp directory and removed by {@link closeGraphServer}.
 *
 * NO `vite` IMPORT, DELIBERATELY. `vite` is not a dependency of this repository —
 * only `vitest` is — so naming that package in any import, including a type-only
 * one, is an unlisted dependency and the dead-code gate rejects it. It would also be
 * a phantom import that only resolves because vitest happens to hoist it. The
 * `createServer` re-exported by `vitest/node` is the same function object
 * (`typeof vite.createServer`), so the semantics are unchanged, and
 * {@link GraphServer} / {@link GraphModuleNode} name the parts of vite's own types
 * this module reads.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vitest/node";

/**
 * The dev-server type this module hands around.
 *
 * Taken from the `createServer` this file actually calls instead of importing
 * `vite`'s `ViteDevServer` by name (see the file header). Structurally identical to
 * that type, because `vitest/node` declares the re-export as
 * `typeof vite.createServer`.
 */
export type GraphServer = Awaited<ReturnType<typeof createServer>>;

/**
 * The fields of a vite module node this crawl reads, and no others.
 *
 * Declared structurally for the same reason as {@link GraphServer}: the objects are
 * vite's own nodes, and this type only states the three members the closure
 * traversal depends on, so it stays honest if a future vite adds or renames the
 * rest.
 */
export interface GraphModuleNode {
  /** Module id, or `null` for a node vite registered without one. */
  readonly id: string | null;
  /** Absolute file path, or `null` for a virtual module. */
  readonly file: string | null;
  /** Modules this one imports: the downward direction of the closure. */
  readonly importedModules: Set<GraphModuleNode>;
}

/** Module ids under an installed dependency are not part of a repo closure. */
const NODE_MODULES_SEGMENT = "/node_modules/";

/** Vite's marker for a virtual module; it has no file and no path to report. */
const VIRTUAL_MODULE_PREFIX = "\0";

/** Prefix of the throwaway vite cache directory, created outside the repository. */
const CACHE_DIR_PREFIX = "llmwiki-module-graph-";

/** How many transform failures a crawl error message quotes before truncating. */
const MAX_REPORTED_FAILURES = 5;

/** Internal bookkeeping shared by the two transform phases. */
interface CrawlState {
  /** URLs already handed to `transformRequest`; a URL is never retried. */
  readonly transformed: Set<string>;
  /** `url: message` for every module the transform rejected. */
  readonly failures: string[];
}

/**
 * Start a vite server that serves the repository under vitest's own resolve rules.
 *
 * The config file is `vitest.config.ts`, not a copy of it: the aliases that make
 * `llm-wiki-compiler` resolve to `packages/wiki/src/index.ts` are the whole reason a
 * crawled graph can agree with `vitest related`, and re-declaring them here would
 * reintroduce exactly the drift this module exists to avoid.
 *
 * The cache directory must live outside the repository. Vite writes a dependency
 * cache on startup, and a crawl that mutated the checkout would be a write inside a
 * step that callers treat as read-only.
 *
 * @param repoRoot - Absolute path to the repository root, used as vite's `root`.
 * @returns A running server in middleware mode, with file watching and HMR off.
 */
export async function createGraphServer(repoRoot: string): Promise<GraphServer> {
  const cacheDir = await mkdtemp(path.join(tmpdir(), CACHE_DIR_PREFIX));
  return createServer({
    root: repoRoot,
    configFile: path.join(repoRoot, "vitest.config.ts"),
    cacheDir,
    logLevel: "error",
    appType: "custom",
    server: {
      middlewareMode: true,
      watch: null,
      hmr: false,
      preTransformRequests: false,
    },
  });
}

/**
 * Stop a server made by {@link createGraphServer} and delete its temp cache.
 *
 * Both halves travel together because the cache path is only reachable through the
 * resolved config; a caller that closed the server and forgot the cache would leave
 * a directory behind on every crawl.
 *
 * @param server - A server returned by {@link createGraphServer}.
 */
export async function closeGraphServer(server: GraphServer): Promise<void> {
  const { cacheDir } = server.config;
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

/** Repository-relative POSIX form of an absolute path. */
function toRepoPath(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

/** Root-relative vite URL for a file given absolutely or relative to the root. */
function toModuleUrl(repoRoot: string, file: string): string {
  const absolute = path.resolve(repoRoot, file);
  return `/${toRepoPath(repoRoot, absolute)}`;
}

/** True for a module id the crawl should transform and count. */
function isInRepoModuleId(id: string): boolean {
  return !id.startsWith(VIRTUAL_MODULE_PREFIX) && !id.includes(NODE_MODULES_SEGMENT);
}

/** Every in-repo module id the graph currently knows about. */
function inRepoModuleIds(server: GraphServer): string[] {
  return [...server.moduleGraph.idToModuleMap.keys()].filter(isInRepoModuleId);
}

/**
 * Transform one module without executing it, recording a rejection rather than aborting.
 *
 * A rejection is not swallowed: {@link transformToFixedPoint} fails the crawl when
 * any module failed, because a module that did not transform contributes no imports
 * and would silently shorten every closure that crosses it — a selection hole that
 * reads as a passing selection.
 */
async function transformModule(server: GraphServer, url: string, state: CrawlState): Promise<void> {
  state.transformed.add(url);
  try {
    await server.transformRequest(url, { ssr: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.failures.push(`${url}: ${message}`);
  }
}

/**
 * Transform the seed modules, then every module they reveal, until nothing new appears.
 *
 * This is the fixed point described in the file header. Each round transforms every
 * in-repo module the graph has discovered and not yet seen; rounds stop when a round
 * adds no module. Each module is transformed at most once, so the work is linear in
 * the reachable graph.
 *
 * @param server - Running graph server.
 * @param seedUrls - URLs of the starting modules, normally the test files.
 * @throws Error naming the count and the first failures when any transform rejected.
 */
async function transformToFixedPoint(server: GraphServer, seedUrls: readonly string[]): Promise<void> {
  const state: CrawlState = { transformed: new Set<string>(), failures: [] };
  for (const url of seedUrls) await transformModule(server, url, state);
  let pending = inRepoModuleIds(server).filter((id) => !state.transformed.has(id));
  while (pending.length > 0) {
    for (const id of pending) await transformModule(server, id, state);
    pending = inRepoModuleIds(server).filter((id) => !state.transformed.has(id));
  }
  if (state.failures.length > 0) {
    const quoted = state.failures.slice(0, MAX_REPORTED_FAILURES).join("\n");
    throw new Error(`module graph crawl failed for ${state.failures.length} module(s):\n${quoted}`);
  }
}

/**
 * Transitive set of repo-relative files reachable downward from a test module.
 *
 * Downward means "what this file imports", which is the direction `vitest related`
 * inverts to answer "which tests import this source". Dependencies under
 * `node_modules` are dropped: they are never a source root a package selection
 * looks for, and keeping them would multiply every closure by the dependency tree.
 */
function transitiveImports(repoRoot: string, entryNodes: readonly GraphModuleNode[]): Set<string> {
  const files = new Set<string>();
  const visited = new Set<string>();
  const pending: GraphModuleNode[] = [...entryNodes];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const id = current.id;
    if (id === null || visited.has(id)) continue;
    visited.add(id);
    const file = current.file;
    if (file !== null && !file.includes(NODE_MODULES_SEGMENT)) files.add(toRepoPath(repoRoot, file));
    for (const imported of current.importedModules) pending.push(imported);
  }
  return files;
}

/**
 * Crawl the graph reachable from every test file and return each one's closure.
 *
 * Two phases, both required: transform the test files, then transform to a fixed
 * point so that every module they reach has recorded its own imports. Only then is a
 * test's closure transitive rather than one level deep.
 *
 * @param server - Running graph server from {@link createGraphServer}.
 * @param testFiles - Test files, absolute or relative to the server root.
 * @returns One entry per input, keyed by repo-relative POSIX test path, whose value
 * is the set of repo-relative POSIX module paths that test transitively imports
 * (including itself).
 */
export async function crawlTestClosures(
  server: GraphServer,
  testFiles: readonly string[],
): Promise<Map<string, Set<string>>> {
  const repoRoot = server.config.root;
  const seeds = testFiles.map((file) => ({
    repoPath: toRepoPath(repoRoot, path.resolve(repoRoot, file)),
    url: toModuleUrl(repoRoot, file),
  }));
  await transformToFixedPoint(server, seeds.map((seed) => seed.url));
  const closures = new Map<string, Set<string>>();
  for (const seed of seeds) {
    const absolute = path.resolve(repoRoot, seed.repoPath);
    const nodes = [...(server.moduleGraph.getModulesByFile(absolute) ?? [])];
    closures.set(seed.repoPath, transitiveImports(repoRoot, nodes));
  }
  return closures;
}

/**
 * Test files whose closure reaches any of the given source files.
 *
 * An empty source list selects nothing, which is the honest answer: no source was
 * named, so no test is related to it. Callers that would rather run everything must
 * decide that themselves rather than receive it from an empty input.
 *
 * @param closures - Result of {@link crawlTestClosures}.
 * @param resolvedSourceIds - Repo-relative POSIX source paths to look for.
 * @returns Sorted repo-relative POSIX test paths.
 */
export function relatedTests(
  closures: ReadonlyMap<string, ReadonlySet<string>>,
  resolvedSourceIds: readonly string[],
): string[] {
  const wanted = new Set(resolvedSourceIds);
  const related: string[] = [];
  for (const [testFile, closure] of closures) {
    for (const modulePath of closure) {
      if (!wanted.has(modulePath)) continue;
      related.push(testFile);
      break;
    }
  }
  return related.sort();
}
