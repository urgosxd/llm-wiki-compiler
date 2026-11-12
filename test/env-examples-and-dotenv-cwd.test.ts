/**
 * @file test/env-examples-and-dotenv-cwd.test.ts
 * @description Guard the three example env files and dotenv's `${cwd}/.env` resolution.
 *
 * ## The two defects this pins
 *
 * 1. `TYPESAFE_API_KEY` was missing from `packages/llmwiki-kg/.env.example`,
 *    `docker/hub.env.example` and `.env.synthetic.example`, so an operator who
 *    copied an example never discovered the KG classification credential and the
 *    skip it caused was silent.
 * 2. `docs/configuration/environment-variables.mdx` told the operator the `.env`
 *    is read *"from your project root"*, while `packages/api/src/load-environment.ts`
 *    resolves `${process.cwd}/.env` through a bare `require("dotenv/config")` —
 *    the directory the process was started from, not the checkout root.
 *
 * Both were repaired by commit ea660806ae2c395da8c9075f9532df6d2e0e9027
 * ("docs(config): surface TYPESAFE_API_KEY in example env files and fix .env
 * location"). Nothing read those files or observed that resolution, so either
 * fix could be undone by a later edit with a green suite. This file is the guard.
 *
 * ## Why the second half spawns a process instead of reading source
 *
 * Asserting that the loader file contains `require("dotenv/config")` would guard
 * prose: it stays green when the behaviour changes and goes red on a harmless
 * reformat. So a child `node` process imports the loader with its cwd set to a
 * scratch directory and reports what `process.env` holds afterwards — cwd-relative
 * resolution is behaviour, and behaviour is what gets observed here.
 *
 * ## What the credential rules are for
 *
 * A discoverability fix is worth nothing if it invites a real key into a tracked
 * example file. The rules below reject the shapes a leaked secret leaves behind.
 * `OPENAI_EMBEDDINGS_API_KEY=sk-...` is a documented placeholder, and it is
 * exempted by one explicit allowlist entry keyed on the file and the exact line
 * text — never by loosening a pattern, which would stop the pattern from seeing
 * the real thing it exists to catch.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/** The classification credential every example env file must surface. */
const GUARDED_KEY = "TYPESAFE_API_KEY";

/** The only acceptable form of that key: present, and holding no value at all. */
const GUARDED_KEY_LINE = `${GUARDED_KEY}=`;

/** One example env file the operator is expected to copy from. */
interface ExampleEnvFile {
  /** Repository-relative path, so a failure names the file someone edits. */
  readonly path: string;
}

/**
 * Every tracked example env file an operator can copy into a `.env`.
 *
 * `docker/env.example` belongs here even though its directory reads as
 * container-only: its own first line says "Copy to `.env` at the repository
 * root", which makes it the example of the very `.env` this guard's second half
 * resolves. It stayed unguarded because the original sweep asked where the
 * variable was missing instead of which example files exist.
 */
const EXAMPLE_ENV_FILES: ExampleEnvFile[] = [
  { path: "packages/llmwiki-kg/.env.example" },
  { path: "docker/hub.env.example" },
  { path: "docker/env.example" },
  { path: ".env.synthetic.example" },
];

/** One shape a real credential leaves behind, named so a failure says which. */
interface CredentialRule {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Hex or opaque tokens are long enough at this body length to be a key, not a name. */
const OPAQUE_TOKEN_BODY = `(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/-]{40,})`;

/**
 * A padded body needs a lower floor than an unpadded one: base64 emits `=` only
 * on a final group, so the padding itself is the evidence, and a 27-character
 * body plus padding is already a key fragment rather than a coincidence.
 */
const PADDED_BASE64_BODY = `[A-Za-z0-9_+/-]{16,}=+`;

/**
 * The dotenv value syntax wrapped around a token body.
 *
 * `dotenv` accepts a bare value, a single- or double-quoted one, whitespace
 * around the quotes, and an inline `#` comment after it. A rule anchored on the
 * bare value alone called every one of those forms safe, so the shell has to
 * carry them all. The trailing comment shares this shell instead of getting an
 * alternation of its own: `#` cannot appear inside an unquoted value, so
 * admitting it at the tail cannot shorten the body match, and two rules built
 * from one shell are one shape to keep correct instead of two.
 *
 * The anchor is `=`, and only `=`. A value always follows one, while the `^`
 * alternative let a long KEY NAME stand in for the value: at the padded body
 * floor, `TYPESAFE_API_KEY=` and `OPENAI_EMBEDDINGS_API_KEY=` matched it, which
 * would reject the very lines this file exists to protect.
 */
function dotenvValue(body: string): RegExp {
  return new RegExp(`=\\s*["']?${body}["']?\\s*(?:#.*)?$`);
}

/**
 * The shapes a leaked secret takes in a dotenv line.
 *
 * Every long-token rule is anchored at the value, not the whole assignment: the
 * body class excludes `=`, so `LLMWIKI_EMBEDDING_MODEL=text-embedding-3-small`
 * (46 characters end to end in `docker/hub.env.example`) is not mistaken for a
 * token. A class that admitted `=` matched that model name and every other long
 * `KEY=value` pair in these files, which is a guard that only ever cries wolf.
 *
 * Padding is a rule of its own because keeping `=` out of the body also hid a
 * padded base64 secret: such a value ends in `=`, so the long-token rule alone
 * could not see it and it read as harmless prose. `=` is therefore admitted as
 * trailing padding only, where no model name and no URL can reach it.
 */
const CREDENTIAL_RULES: CredentialRule[] = [
  { name: "openai-style sk- prefix", pattern: /sk-/ },
  { name: "authorization header bearer token", pattern: /Bearer\s/ },
  { name: "jwt prefix", pattern: /eyJ[A-Za-z0-9_-]{8,}/ },
  { name: "long hex or opaque token", pattern: dotenvValue(OPAQUE_TOKEN_BODY) },
  { name: "padded base64 token", pattern: dotenvValue(PADDED_BASE64_BODY) },
];

/** A fake base64 key, decoding to `thisisareallylongkeywithequals=`: no key material. */
const FAKE_BASE64_KEY = "dGhpc2lzYXJlYWxseWxvbmdrZXl3aXRoZXF1YWxzPQ==";

/** A shorter fake base64 key, so the inline-comment form pins the padded floor too. */
const FAKE_SHORT_BASE64_KEY = "dGhpc2lzYXJlYWxseWxvbmdrZXk=";

/**
 * Lines shaped like a leaked key: each one must be rejected by some rule.
 *
 * The first three pin the two unpadded lengths a key of this size takes and the
 * padded form the body class alone could not see. The rest are the ways dotenv
 * lets an operator write that same padded value — double-quoted, single-quoted,
 * spaced around the `=`, and followed by an inline comment. `dotenv` parses all
 * four, so a guard that only matched the bare form would report a file safe while
 * `dotenv` loaded the key out of it.
 */
const CREDENTIAL_SAMPLE_LINES: string[] = [
  `SECRET=${FAKE_BASE64_KEY}`,
  `SECRET=${"deadbeef".repeat(8)}`,
  `SECRET=${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`,
  `SECRET="${FAKE_BASE64_KEY}"`,
  `SECRET='${FAKE_BASE64_KEY}'`,
  `SECRET = ${FAKE_BASE64_KEY}`,
  `SECRET=${FAKE_SHORT_BASE64_KEY} # comment`,
];

/**
 * Lines that are merely long: none carries key material, so no rule may reject them.
 *
 * All four appear in the guarded files. A rule that rejects one of them has
 * stopped being a credential guard and become noise an operator learns to skip.
 */
const NON_CREDENTIAL_SAMPLE_LINES: string[] = [
  "EMBEDDING_MODEL=text-embedding-3-small",
  "LLMWIKI_EMBEDDING_MODEL=text-embedding-3-small",
  "LLMWIKI_EMBEDDING_MODEL=hf:nomic-ai/nomic-embed-text-v1.5",
  "DATABASE_URL=postgresql://aks:aks@db:5432/aks",
];

/** A credential-shaped line that is a documented placeholder rather than a key. */
interface CredentialPlaceholder {
  /** Repository-relative file the line must be found in. */
  readonly file: string;
  /** The exact line text, compared whole so the exemption cannot widen. */
  readonly line: string;
  /** Names of the credential rules this placeholder is exempted from. */
  readonly rules: readonly string[];
  /** Why this placeholder carries no key material. */
  readonly reason: string;
}

/**
 * The one exempted placeholder in the corpus, and the reason it is safe.
 *
 * `sk-...` is the convention that file uses to say "put your key here": three
 * literal dots, no key material, and the file's own comment explains that the
 * dedicated Synthetic embeddings key belongs on that line.
 */
const CREDENTIAL_PLACEHOLDER_ALLOWLIST: CredentialPlaceholder[] = [
  {
    file: ".env.synthetic.example",
    line: "OPENAI_EMBEDDINGS_API_KEY=sk-...",
    rules: ["openai-style sk- prefix"],
    reason:
      "Documented placeholder for the dedicated Synthetic embeddings key: `sk-...` is three literal dots with no key material, and the file's surrounding comment explains that the real key belongs on this line.",
  },
];

/** The file's lines, unsplit of content, so a failure can quote the offending text. */
function readLines(file: string): string[] {
  return readFileSync(path.resolve(file), "utf8").split("\n");
}

/** Is this exact line exempted, keyed on both the file path and the line's full text? */
function isAllowlisted(file: string, line: string): boolean {
  return CREDENTIAL_PLACEHOLDER_ALLOWLIST.some(
    (entry) => entry.file === file && entry.line === line,
  );
}

/** The rules that reject this line, by name, so a failure says which shape matched. */
function rejectingRules(line: string): string[] {
  return CREDENTIAL_RULES.filter((rule) => rule.pattern.test(line)).map((rule) => rule.name);
}

describe("credential rules", () => {
  it.each(CREDENTIAL_SAMPLE_LINES)("rejects the sample line %s", (line) => {
    expect(rejectingRules(line)).not.toEqual([]);
  });

  it.each(NON_CREDENTIAL_SAMPLE_LINES)("does not reject the sample line %s", (line) => {
    expect(rejectingRules(line)).toEqual([]);
  });
});

describe("example env files", () => {
  it.each(EXAMPLE_ENV_FILES)(
    "$path declares TYPESAFE_API_KEY exactly once, with no value",
    ({ path: file }) => {
      // `startsWith`, not a substring search: `packages/llmwiki-kg/.env.example`
      // mentions the name in a comment on line 53, and counting occurrences
      // rather than key lines would call that a second declaration.
      const keyLines = readLines(file).filter((line) => line.startsWith(GUARDED_KEY_LINE));

      expect(keyLines).toHaveLength(1);
      expect(keyLines[0]).toBe(GUARDED_KEY_LINE);
    },
  );

  it.each(EXAMPLE_ENV_FILES)("$path carries no credential-shaped line", ({ path: file }) => {
    const rejected = readLines(file).flatMap((line, index) =>
      CREDENTIAL_RULES.filter((rule) => rule.pattern.test(line))
        .filter(() => !isAllowlisted(file, line))
        .map((rule) => `${file}:${index + 1} matches ${rule.name} -> ${line}`),
    );

    expect(rejected).toEqual([]);
  });

  it.each(CREDENTIAL_PLACEHOLDER_ALLOWLIST)(
    "the allowlist entry for $file still names a line the rules it lists reject",
    ({ file, line, rules }) => {
      // Liveness: an entry that outlived its line would silently exempt nothing
      // while still reading like an exemption. Each rule the entry names must be
      // in the rejecting set BY NAME: "some rule still rejects it" stayed green
      // after the `sk-` rule was renamed away, leaving the one placeholder that
      // needs the exemption unguarded. A covering line with a stale rule name is
      // the same rot one step later.
      expect(readLines(file)).toContain(line);
      const rejecting = rejectingRules(line);

      for (const rule of rules) expect(rejecting).toContain(rule);
    },
  );
});

/** The variable the child's `.env` sets, so the report can only carry dotenv's work. */
const PROBE_NAME = "LLMWIKI_DOTENV_CWD_PROBE";

/** A value no operator could mistake for a credential, or for a real setting. */
const PROBE_VALUE = "scratch-cwd-probe-dummy-not-a-credential";

/** Absolute file URL of the loader under guard, so the child imports this checkout's source. */
const LOADER_URL = new URL("../packages/api/src/load-environment.ts", import.meta.url).href;

/** Scratch roots this file created; every one of them is removed after its test. */
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Create a scratch directory outside the worktree and remember it for teardown. */
async function scratchDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  scratchRoots.push(directory);
  return directory;
}

/** The program the child runs: import the loader, then report what it left behind. */
function loaderProbeSource(): string {
  return [
    `await import(${JSON.stringify(LOADER_URL)});`,
    `console.log(JSON.stringify({ loaded: true, probe: process.env[${JSON.stringify(PROBE_NAME)}] ?? null }));`,
  ].join("\n");
}

/** What a child process did: its exit status and both streams, unparsed. */
interface ChildOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the probe prints once the loader has been evaluated. */
interface ProbeReport {
  readonly loaded: boolean;
  readonly probe: string | null;
}

/**
 * Import the loader in a plain `node` child whose cwd is `directory`.
 *
 * Plain `node`, no loader flag: this repository runs `.ts` on Node's own type
 * stripping, so the child exercises the same import the launcher performs.
 * `DOTENV_CONFIG_PATH` and the probe are deleted from the inherited environment
 * first — the suite's committed dotenv corpus sets the former for spawned CLIs,
 * and an inherited probe would satisfy the assertion without dotenv reading a file.
 */
async function runLoaderIn(directory: string): Promise<ChildOutcome> {
  const script = path.join(await scratchDir("dotenv-cwd-script-"), "probe.mjs");
  await writeFile(script, loaderProbeSource(), "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DOTENV_CONFIG_PATH;
  delete env[PROBE_NAME];
  const child = spawn(process.execPath, [script], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { status, stdout, stderr };
}

/**
 * Parse the probe's report, failing on the child's own terms first.
 *
 * A non-zero status means the import threw, so no report exists to read; quoting
 * the child's stderr is the only way that failure says anything useful.
 */
function readProbeReport(outcome: ChildOutcome): ProbeReport {
  expect(outcome.status, `probe child exited early: ${outcome.stderr}`).toBe(0);
  const lastLine = outcome.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(lastLine) as ProbeReport;
}

describe("dotenv loader cwd resolution", () => {
  it("reads the .env sitting in the process cwd", async () => {
    const directory = await scratchDir("dotenv-cwd-present-");
    await writeFile(path.join(directory, ".env"), `${PROBE_NAME}=${PROBE_VALUE}\n`, "utf8");

    const report = readProbeReport(await runLoaderIn(directory));

    expect(report.loaded).toBe(true);
    expect(report.probe).toBe(PROBE_VALUE);
  });

  it("does not search upward for a .env outside the process cwd", async () => {
    const parent = await scratchDir("dotenv-cwd-absent-");
    const directory = path.join(parent, "started-here");
    await mkdir(directory);
    // The `.env` sits ABOVE the child's cwd: if dotenv walked up the tree looking
    // for one — the reading the doc page invited — this is where it would land.
    await writeFile(path.join(parent, ".env"), `${PROBE_NAME}=${PROBE_VALUE}\n`, "utf8");

    const report = readProbeReport(await runLoaderIn(directory));

    expect(report.loaded).toBe(true);
    expect(report.probe).toBeNull();
  });
});
