/** Collect semantic test diagnostics without emitting build artifacts. */
import ts from "typescript";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";

/** Stable repository-relative paths for diagnostics and metadata. */
function relativeFile(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Configuration/global errors cannot be hidden inside a per-file baseline. */
function rejectDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }));
}

/** The extensions TypeScript adds to a program, so a walk can compare like with like. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

/** Does this path segment hold a wildcard, so it names files rather than a directory? */
function isWildcard(segment: string): boolean {
  return /[*?]/u.test(segment);
}

/** Match one path segment against one glob segment; `*` and `?` never cross a `/`. */
function segmentMatches(pattern: string, segment: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*")
    .replace(/\?/gu, "[^/]");
  return new RegExp(`^${source}$`, "u").test(segment);
}

/** Match a file's path below a walked directory against the rest of its include entry. */
function matchesPattern(pattern: readonly string[], segments: readonly string[]): boolean {
  const [head, ...tail] = pattern;
  if (head === undefined) return segments.length === 0;
  if (head === "**") {
    for (let skip = 0; skip <= segments.length; skip += 1) {
      if (matchesPattern(tail, segments.slice(skip))) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  return segmentMatches(head, segments[0]) && matchesPattern(tail, segments.slice(1));
}

/** One `include` entry split into the directory it walks and the pattern below it. */
interface IncludeScope {
  /** Repository-relative directory the entry declares; this is the entry's "source root". */
  directory: string;
  /** Pattern segments matched against every candidate file's path below `directory`. */
  pattern: string[];
}

/** Reject an `include` whose scope cannot be derived, rather than checking nothing. */
function parseInclude(include: unknown): string[] {
  if (!Array.isArray(include) || include.length === 0) {
    throw new Error("tsconfig.test.json must declare a non-empty include array, or the test type-check checks nothing");
  }
  return include.map((entry: unknown) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`Unparseable tsconfig.test.json include entry: ${JSON.stringify(entry)}`);
    }
    const normalized = entry.replace(/\\/gu, "/");
    if (path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw new Error(`tsconfig.test.json include entry escapes the repository: ${entry}`);
    }
    return normalized;
  });
}

/** Split one include entry into the directory it walks and the pattern below it. */
function includeScope(root: string, entry: string): IncludeScope {
  const segments = entry.split("/").filter((segment) => segment !== "" && segment !== ".");
  const wildcard = segments.findIndex(isWildcard);
  if (segments.length === 0 || wildcard === 0) {
    throw new Error(`tsconfig.test.json include entry declares no directory to walk: ${entry}`);
  }
  if (wildcard !== -1) {
    return { directory: segments.slice(0, wildcard).join("/"), pattern: segments.slice(wildcard) };
  }
  const literal = segments.join("/");
  const absolute = path.join(root, literal);
  if (existsSync(absolute) && statSync(absolute).isFile()) {
    const directory = path.posix.dirname(literal);
    if (directory === ".") throw new Error(`tsconfig.test.json include entry declares no directory to walk: ${entry}`);
    return { directory, pattern: [path.posix.basename(literal)] };
  }
  return { directory: literal, pattern: ["**", "*"] };
}

/** Every include entry's scope, in declaration order. */
function includeScopes(root: string, include: unknown): IncludeScope[] {
  return parseInclude(include).map((entry) => includeScope(root, entry));
}

/**
 * The source roots this configuration declares, deduplicated and sorted.
 *
 * Derived, never listed. A literal here was the defect: it named
 * `packages/wiki/src` and `test` while `include` had grown `packages/api/src`,
 * `packages/llmwiki-kg/ts/src` and the two `scripts` entries, so the nine
 * `packages/api/src` test files that re-entered the checked set were invisible to
 * the cross-check. `test/wiring-src-literals.test.ts` pins this derivation
 * against the reviewed root set instead, because the derivation alone cannot
 * notice a root REMOVED from `include` — a removed root is also removed from the
 * expectation.
 */
export function declaredSourceRoots(root: string, include: unknown): string[] {
  return [...new Set(includeScopes(root, include).map((scope) => scope.directory))].sort();
}

/** Files on disk one scope selects, read independently of TypeScript's own globs. */
function scopeFiles(root: string, scope: IncludeScope): string[] {
  const directory = path.join(root, scope.directory);
  // A declared root that is not on disk contributes nothing, so there is nothing
  // to compare it against; a root that IS on disk must select at least one file,
  // which `uncheckedFiles` enforces rather than skipping silently.
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    const isSource = entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension));
    if (!isSource) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (matchesPattern(scope.pattern, relativeFile(directory, file).split("/"))) files.push(file);
  }
  return files;
}

/**
 * Files the configuration declares on disk that the type-check program does not check.
 *
 * TypeScript resolves `include` through its own globs, which omit dot-prefixed
 * names, and it does not complain when an entry selects nothing at all. So the
 * expectation is derived from the entries a second time, by walking the disk, and
 * every file that walk finds must be in the program. An entry that is present on
 * disk but selects no file is an error rather than a silent narrowing.
 */
function uncheckedFiles(root: string, include: unknown, programFiles: readonly string[]): string[] {
  const scopes = includeScopes(root, include);
  const checked = new Set(programFiles.map((name) => path.resolve(root, name)));
  const missing = new Set<string>();
  // Grouped by ROOT rather than by entry, because two entries can declare one
  // root (`scripts/test-typecheck*.ts` and `scripts/typecheck-tests.ts` both walk
  // `scripts`) and the failure worth reporting is "this root selected nothing",
  // not "one of the patterns under it selected nothing".
  for (const directory of declaredSourceRoots(root, include)) {
    const files = scopes
      .filter((scope) => scope.directory === directory)
      .flatMap((scope) => scopeFiles(root, scope));
    if (files.length === 0 && existsSync(path.join(root, directory))) {
      throw new Error(`tsconfig.test.json include selects no file under ${directory}, so that root is unchecked`);
    }
    for (const file of files) {
      if (!checked.has(path.resolve(file))) missing.add(relativeFile(root, file));
    }
  }
  return [...missing].sort();
}

/** Load test settings and reject configurations that omit checked source files. */
function readTestConfig(root: string): ts.ParsedCommandLine {
  const file = path.join(root, "tsconfig.test.json");
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error) rejectDiagnostics([loaded.error]);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, file);
  rejectDiagnostics(config.errors);
  if (config.options.noEmit !== true) throw new Error("Test type-check requires noEmit: true");
  const missing = uncheckedFiles(root, config.raw.include, config.fileNames);
  if (missing.length) throw new Error(`Unchecked files: ${missing.join(", ")}`);
  return config;
}

/** Pin effective options and recursive selection without embedding checkout paths. */
function configurationDigest(root: string, config: ts.ParsedCommandLine): string {
  const value = { options: config.options, include: config.raw.include, exclude: config.raw.exclude };
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "string" && path.isAbsolute(entry)) return relativeFile(root, entry);
    return entry;
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/** Check a repository using its separate test configuration. */
export function collectTestDiagnostics(root: string): { counts: Record<string, number>; checkedFiles: string[]; configuration: string } {
  const config = readTestConfig(root);
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((entry) => entry.category === ts.DiagnosticCategory.Error);
  rejectDiagnostics(diagnostics.filter((entry) => !entry.file));
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const file = relativeFile(root, diagnostic.file!.fileName);
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return {
    counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
    checkedFiles: config.fileNames.map((file) => relativeFile(root, file)).sort(),
    configuration: configurationDigest(root, config),
  };
}
