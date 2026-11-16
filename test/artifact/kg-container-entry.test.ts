/**
 * @file test/artifact/kg-container-entry.test.ts
 * @description Guards the wiring the KG image must ship itself: `docker run <tag>`
 * with only a database DSN and provider keys has to boot the server, which means
 * the image — not the operator's remembered command line — carries the provider
 * selection and the embeddings split.
 *
 * ## Why this file exists, in one sentence
 *
 * The KG image used to start only from a hand-wired `docker run` line that named
 * `EXTRACTION_PROVIDER`, a chat base URL and a separate embeddings host; nothing in
 * the repository recorded it, so a bare `docker run <tag>` inherited
 * `EXTRACTION_PROVIDER=anthropic` and `EMBEDDING_PROVIDER=openai` from
 * `packages/llmwiki-kg/ts/src/config.ts:83,87` and died without provider
 * credentials. The fix is an entry script the image COPYs and chmods, and only a
 * test that reads those files as text can keep it from silently disappearing.
 *
 * ## What it proves
 *
 * 1. **The Dockerfile installs the script as its entrypoint.** Exactly one
 *    `ENTRYPOINT`, produced by a `COPY` of a file that really exists plus a
 *    `RUN chmod +x` of that installed path, in that order — a COPY without the
 *    chmod is a `permission denied` at container start, and a chmod of a path
 *    nothing copies is a green build that cannot run.
 * 2. **The script default is PRESERVING.** Every wiring variable is written as
 *    `${NAME:-fallback}` so a caller's explicit value survives. An unconditional
 *    `VAR="$OTHER"` would clobber the operator's choice and re-implement the
 *    inheritance rule `resolveGatewayEmbeddings` already owns
 *    (`packages/llmwiki-kg/ts/src/config.ts:212-213`).
 * 3. **The embeddings pair is derived from the wiki's published names**, nested and
 *    preserving, so the embeddings host does not have to follow the chat host.
 * 4. **No credential and no DSN is written, and the only endpoint named is the image's own
 *    loopback listener.** The script carries variable NAMES: the DSN and the keys arrive from
 *    the caller. The single exception is `AKS_BASE_URL`, which must point at the server the
 *    MCP tools run inside (see item 6).
 * 5. **`CMD` still names the server bundle.** The entrypoint composes with the
 *    existing `CMD`, and the no-argument branch execs that same bundle, so the
 *    process that finally runs is the one that reaches `app.listen`.
 * 6. **The published DSN name and the tools' own base URL are bridged, preserving.**
 *    The KG server reads `DATABASE_URL` (`packages/llmwiki-kg/ts/src/config.ts`), while the
 *    operator publishes `AKS_DATABASE_URL`, which only `packages/wiki/src/dimensions/activation.ts`
 *    reads — a name that is not in this image. With only `AKS_DATABASE_URL` set, live proof
 *    returned `/health` 200 and the exact bare 21-byte `Internal Server Error` on `/stacks`.
 *    Likewise `AKS_BASE_URL`, unset, makes the MCP tools proxy to `localhost:8000` instead of
 *    their own listener. Both are bridged here as `${NAME:-fallback}`, never assigned.
 *
 * ## Why no Docker, and no spawn
 *
 * A `docker build` costs minutes and needs a daemon, so it can never be a
 * per-commit check. Every assertion below reads a TRACKED FILE as text. The
 * runtime proof — that `docker run <tag>` with nothing but the DSN and the keys
 * serves `/health` — stays a delivery step, recorded in
 * `odd/tasks/kg-image-baked-wiring.md`.
 */

import { describe, expect, it } from "vitest";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, from this file's own location rather than the worker's cwd. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The KG image recipe that must install the entrypoint. */
const DOCKERFILE = "packages/llmwiki-kg/Dockerfile";

/** The shipped entry script, repository-relative, as the COPY names it. */
const ENTRY_SOURCE = "packages/llmwiki-kg/docker/entry.sh";

/** The server bundle the image runs, spelled the way `CMD` and the script spell it. */
const SERVER_ENTRY = "packages/llmwiki-kg/ts/dist/index.js";

/** The provider the image defaults both halves to, so a bare run has a provider. */
const DEFAULT_PROVIDER = "gateway";

/** The `export NAME=...` form, which is what reaches the exec'd server. */
const EXPORT_PREFIX = "export ";

/** The only endpoint this script may name: the image's own listener, read from `PORT`. */
const LOOPBACK_DEFAULT = "http://127.0.0.1:${PORT:-8000}";

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
 * The single `ENTRYPOINT` line of the KG recipe.
 *
 * There must be exactly one: Docker keeps only the last of several, so a second
 * declaration would silently decide the container's start behaviour.
 *
 * @param dockerfile - The whole build recipe.
 * @returns The `ENTRYPOINT` line, unmodified.
 */
function singleEntrypoint(dockerfile: string): string {
  const declarations = dockerfile.split("\n").filter((line) => /^ENTRYPOINT\b/.test(line));
  expect(
    declarations,
    `\`${DOCKERFILE}\` must declare exactly one ENTRYPOINT, or Docker keeps only the last one`,
  ).toHaveLength(1);
  return declarations[0] ?? "";
}

/**
 * The executable path one `ENTRYPOINT` line names.
 *
 * @param line - The `ENTRYPOINT` line, in its JSON-array form.
 * @returns The absolute path inside the image.
 */
function entrypointPath(line: string): string {
  const args = JSON.parse(line.replace(/^ENTRYPOINT\s+/, "")) as unknown;
  expect(Array.isArray(args), `the ENTRYPOINT must be written as a JSON array, not a shell string`).toBe(true);
  const target = (args as readonly string[])[0] ?? "";
  expect(target.startsWith("/"), `the ENTRYPOINT must name an absolute path inside the image`).toBe(true);
  return target;
}

/**
 * Every assignment line for one variable name, `export` included.
 *
 * Line-based on purpose: a header comment may QUOTE the shape this file forbids
 * while explaining it, and a quoted `# ...` line is not an assignment.
 *
 * @param script - The whole entry script.
 * @param name - The variable name.
 * @returns The trimmed assignment lines, in file order.
 */
function assignmentLines(script: string, name: string): string[] {
  const assignment = new RegExp(`^\\s*(?:${EXPORT_PREFIX.trim()}\\s+)?${name}=`);
  return script
    .split("\n")
    .filter((line) => assignment.test(line))
    .map((line) => line.trim());
}

/**
 * Assert one variable is defaulted in the PRESERVING shape.
 *
 * `export NAME="${NAME:-fallback}"` is the only accepted spelling: `export`, so the
 * exec'd server sees it; `${NAME:-…}`, so a caller's value wins; and the fallback
 * verbatim, so a default cannot drift from what this file claims.
 *
 * @param script - The whole entry script.
 * @param name - The variable name.
 * @param fallback - The exact fallback text, which may itself be a nested default.
 */
function expectPreservingDefault(script: string, name: string, fallback: string): void {
  const lines = assignmentLines(script, name);
  expect(lines, `\`${ENTRY_SOURCE}\` must assign \`${name}\` exactly once`).toHaveLength(1);
  expect(
    lines[0],
    `\`${name}\` must be defaulted, not assigned: \`export ${name}="\${${name}:-${fallback}}"\` keeps a ` +
      `caller's explicit value`,
  ).toBe(`export ${name}="\${${name}:-${fallback}}"`);
}

describe("KG entrypoint declaration", () => {
  it("declares exactly one ENTRYPOINT and it names the shipped entry script", async () => {
    const target = entrypointPath(singleEntrypoint(await readRepoFile(DOCKERFILE)));

    expect(
      path.basename(target),
      `the ENTRYPOINT must name the script \`${ENTRY_SOURCE}\` ships, not a bundle the image may not have`,
    ).toBe(path.basename(ENTRY_SOURCE));
  });

  it("installs the entrypoint from a COPY of a real file plus an executable chmod", async () => {
    const dockerfile = await readRepoFile(DOCKERFILE);
    const target = entrypointPath(singleEntrypoint(dockerfile));
    const lines = dockerfile.split("\n");

    const copies = lines.filter((line) => line.startsWith("COPY ") && line.trim().split(/\s+/).at(-1) === target);
    expect(copies, `\`${DOCKERFILE}\` must COPY the entry script to \`${target}\``).toHaveLength(1);
    const source = copies[0]?.trim().split(/\s+/)[1] ?? "";
    expect(source, `the entrypoint must be copied from \`${ENTRY_SOURCE}\``).toBe(ENTRY_SOURCE);
    expect(
      await stat(path.join(REPO_ROOT, source)).catch(() => null),
      `the copied-from path \`${source}\` must exist, or the build fails at this layer`,
    ).not.toBeNull();

    const chmod = lines.filter((line) => line.trim() === `RUN chmod +x ${target}`);
    expect(chmod, `\`${DOCKERFILE}\` must \`RUN chmod +x ${target}\`, or the container start is permission denied`)
      .toHaveLength(1);
  });
});

describe("KG entrypoint runtime behaviour", () => {
  it("execs the server bundle when no command is supplied and yields to one that is", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);
    const lines = script.split("\n").map((line) => line.trim());
    const lastStatement = lines.filter((line) => line !== "" && !line.startsWith("#")).at(-1);

    expect(
      lastStatement,
      `\`${ENTRY_SOURCE}\` must end in \`exec node ${SERVER_ENTRY}\` so PID 1 is the server and it receives SIGTERM`,
    ).toBe(`exec node ${SERVER_ENTRY}`);

    const branchAt = lines.indexOf('if [ "$#" -gt 0 ]; then');
    expect(branchAt, `\`${ENTRY_SOURCE}\` must carry an explicit-command-wins branch`).toBeGreaterThan(-1);
    expect(lines[branchAt + 1], "the explicit-command branch must exec the caller's command verbatim").toBe('exec "$@"');
  });
});

describe("KG entrypoint provider defaults", () => {
  it("defaults both providers to gateway without overriding a caller's choice", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    for (const name of ["EXTRACTION_PROVIDER", "EMBEDDING_PROVIDER"]) {
      expectPreservingDefault(script, name, DEFAULT_PROVIDER);
    }
  });

  it("derives the embeddings pair from the wiki's names instead of following the chat host", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    expectPreservingDefault(script, "GATEWAY_EMBEDDINGS_BASE_URL", "\${OPENAI_EMBEDDINGS_BASE_URL:-}");
    expectPreservingDefault(script, "GATEWAY_EMBEDDINGS_API_KEY", "\${OPENAI_EMBEDDINGS_API_KEY:-}");

    const clobbering = assignmentLines(script, "GATEWAY_EMBEDDINGS_BASE_URL").filter((line) =>
      /^export GATEWAY_EMBEDDINGS_BASE_URL=("?)\$OPENAI_EMBEDDINGS_BASE_URL\1$/.test(line),
    );
    expect(
      clobbering,
      "an unconditional `GATEWAY_EMBEDDINGS_BASE_URL=\"$OPENAI_EMBEDDINGS_BASE_URL\"` would overwrite the " +
        "operator's own value and move the embeddings host whenever the wiki's moves",
    ).toEqual([]);
  });
});

describe("KG entrypoint honours the published DSN name", () => {
  it("seeds DATABASE_URL from AKS_DATABASE_URL without overriding a caller's DATABASE_URL", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    expectPreservingDefault(script, "DATABASE_URL", "\${AKS_DATABASE_URL:-}");

    const unconditional = assignmentLines(script, "DATABASE_URL").filter((line) =>
      /^DATABASE_URL=("?)\$AKS_DATABASE_URL\1$/.test(line),
    );
    expect(
      unconditional,
      "an unconditional `DATABASE_URL=\"$AKS_DATABASE_URL\"` would overwrite a caller's own DATABASE_URL, which " +
        "always wins; `${DATABASE_URL:-…}` keeps it, and its blank arm covers a blank DATABASE_URL too",
    ).toEqual([]);

    expect(
      script,
      `\`${ENTRY_SOURCE}\` must carry no DSN literal: the connection string arrives from the caller, and a value ` +
        "written here would be a credential baked into the image",
    ).not.toMatch(/postgres(?:ql)?:\/\//i);
  });
});

describe("KG entrypoint lets the MCP tools reach their own listener", () => {
  it("defaults AKS_BASE_URL to the loopback listener built from PORT", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    expectPreservingDefault(script, "AKS_BASE_URL", LOOPBACK_DEFAULT);

    const statements = script.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    const hosts = statements.flatMap((line) =>
      [...line.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s"'/:]+)/gi)].map((match) => match[1] ?? ""),
    );
    expect(
      hosts,
      "the only endpoint this script may name is the image's own loopback listener: a non-loopback host here " +
        "would point the MCP tools' proxy away from the server they run inside",
    ).toEqual(["127.0.0.1"]);
    expect(
      script,
      `\`${ENTRY_SOURCE}\` must build the default from \`PORT\` (default 8000), so it follows the port the ` +
        "server actually listens on instead of a number that can drift",
    ).toContain("${PORT:-8000}");
  });
});

describe("KG entrypoint ordering", () => {
  it("defaults the wiring before the explicit-command branch and still execs the server last", async () => {
    const lines = (await readRepoFile(ENTRY_SOURCE)).split("\n").map((line) => line.trim());
    const statements = lines.filter((line) => line !== "" && !line.startsWith("#"));

    expect(
      statements.at(-1),
      `\`${ENTRY_SOURCE}\` must end in \`exec node ${SERVER_ENTRY}\`, so PID 1 is the server and it gets SIGTERM`,
    ).toBe(`exec node ${SERVER_ENTRY}`);

    const branchAt = lines.indexOf('if [ "$#" -gt 0 ]; then');
    expect(branchAt, `\`${ENTRY_SOURCE}\` must carry an explicit-command-wins branch`).toBeGreaterThan(-1);

    for (const name of ["DATABASE_URL", "AKS_BASE_URL", "EXTRACTION_PROVIDER", "EMBEDDING_PROVIDER"]) {
      const at = lines.findIndex((line) => line.startsWith(`${EXPORT_PREFIX}${name}=`));
      expect(at, `\`${ENTRY_SOURCE}\` must default \`${name}\` before the caller's command can run`).toBeGreaterThan(-1);
      expect(
        at,
        `the \`${name}\` default must precede the explicit-command branch, or a caller-supplied command runs ` +
          "without the image's wiring",
      ).toBeLessThan(branchAt);
    }
  });
});

/** The vendor-enforced prefix on an embedding model id; without it the vendor 400s. */
const REQUIRED_MODEL_PREFIX = "hf:";

/** The variable whose value the vendor rejects when it lacks that prefix. */
const EMBEDDING_MODEL_VAR = "LLMWIKI_EMBEDDING_MODEL";

/** The one-line named error the guard prints, verbatim: greppable in a log, stable to assert. */
const EMBEDDING_MODEL_ERROR =
  `[kg-entry] Invalid ${EMBEDDING_MODEL_VAR}: the embedding model id must start with ` +
  `"${REQUIRED_MODEL_PREFIX}" — refusing to start.`;

/** The non-empty form: `set -eu` makes a bare `$VAR` fatal when it is unset. */
const EMBEDDING_MODEL_SET_TEST = `[ -n "\${${EMBEDDING_MODEL_VAR}:-}" ]`;

describe("KG entrypoint refuses an embedding model id the vendor would reject", () => {
  it("fails fast with one named error when the model id lacks the required prefix", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);
    const errorLines = script.split("\n").filter((line) => line.includes(EMBEDDING_MODEL_ERROR));

    expect(script, `\`${ENTRY_SOURCE}\` must test the required \`${REQUIRED_MODEL_PREFIX}\` prefix`).toContain(
      `${REQUIRED_MODEL_PREFIX}*)`,
    );
    expect(errorLines, `\`${ENTRY_SOURCE}\` must print the named error \`${EMBEDDING_MODEL_ERROR}\``).toHaveLength(1);
    expect(errorLines[0], "the named error must go to stderr so a log scrape can tell the two apart").toContain(">&2");
    expect(script, "the guard must refuse to start, not warn and continue into a vendor 400").toMatch(/^\s+exit 1$/m);
  });

  it("stays silent when the variable is unset or empty, because CI boots the image without it", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);
    const guardLine = `if ${EMBEDDING_MODEL_SET_TEST}; then`;

    expect(
      script.split("\n").map((line) => line.trim()),
      `the guard must be conditional on a NON-EMPTY value (\`${guardLine}\`): ` +
        "`.github/scripts/docker-images-check.sh:255-274` boots the image with no " +
        `\`${EMBEDDING_MODEL_VAR}\` at all, so an unset variable must pass silently`,
    ).toContain(guardLine);
    expect(
      script,
      `\`${ENTRY_SOURCE}\` must not DEMAND \`${EMBEDDING_MODEL_VAR}\`: a required-variable form exits on the CI boot`,
    ).not.toContain(`${EMBEDDING_MODEL_VAR}:?`);
    expect(
      assignmentLines(script, EMBEDDING_MODEL_VAR),
      `the model id is operator configuration: \`${ENTRY_SOURCE}\` must not default or assign it`,
    ).toEqual([]);
  });
});

describe("KG entrypoint places the embedding-model guard before the server starts", () => {
  it("validates before the explicit-command branch and before the server exec", async () => {
    const lines = (await readRepoFile(ENTRY_SOURCE)).split("\n").map((line) => line.trim());
    const guardAt = lines.indexOf(`if ${EMBEDDING_MODEL_SET_TEST}; then`);
    const branchAt = lines.indexOf('if [ "$#" -gt 0 ]; then');

    expect(guardAt, `\`${ENTRY_SOURCE}\` must carry the embedding-model guard`).toBeGreaterThan(-1);
    expect(branchAt, `\`${ENTRY_SOURCE}\` must carry an explicit-command-wins branch`).toBeGreaterThan(-1);
    expect(
      guardAt,
      "the guard must precede the explicit-command branch: the image bakes `CMD [\"node\", …]`, so the " +
        "passthrough always fires and a guard placed after it is dead code on the documented boot path",
    ).toBeLessThan(branchAt);
    expect(guardAt, `the guard must run BEFORE \`exec node ${SERVER_ENTRY}\`, or the server boots anyway`).toBeLessThan(
      lines.indexOf(`exec node ${SERVER_ENTRY}`),
    );
  });

  it("names the required prefix and no model value, credential, DSN or non-loopback endpoint", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);
    const hosts = script
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
      .flatMap((line) =>
        [...line.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s"'/:]+)/gi)].map((match) => match[1] ?? ""),
      );

    expect(script, "the guard must never bake a model id: only the bare prefix is named").not.toMatch(/hf:[A-Za-z0-9]/);
    expect(script, `${ENTRY_SOURCE} must carry no DSN literal`).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(script, "no endpoint may arrive through a URL with userinfo").not.toMatch(/\/\/[^\s/'"@]+@/);
    expect(hosts, "the only endpoint this script may name is the image's own loopback listener").toEqual(["127.0.0.1"]);
  });
});

describe("KG entrypoint carries no configuration of its own", () => {
  it("writes no credential, no DSN value and no endpoint beyond the loopback default", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    for (const name of ["GATEWAY_URL", "GATEWAY_API_KEY", "OPENAI_EMBEDDINGS_BASE_URL", "OPENAI_EMBEDDINGS_API_KEY"]) {
      expect(
        assignmentLines(script, name),
        `\`${ENTRY_SOURCE}\` must not assign \`${name}\`: it arrives from the caller, and a value written here ` +
          "is either a credential in the image or a wiring the caller cannot override",
      ).toEqual([]);
    }

    expect(
      script,
      "no endpoint may arrive through a URL with userinfo (a credential smuggling shape)",
    ).not.toMatch(/\/\/[^\s/'"@]+@/);

    const credentialLike = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#") && /^[^#=]*=\s*"?[A-Za-z0-9+/_=-]{16,}"?\s*$/.test(line.trim()));
    expect(credentialLike, `\`${ENTRY_SOURCE}\` must carry no literal that looks like a key or token`).toEqual([]);
  });
});

describe("KG container command", () => {
  it("keeps the CMD that names the server bundle, so ENTRYPOINT plus CMD reach the listener", async () => {
    const declarations = (await readRepoFile(DOCKERFILE)).split("\n").filter((line) => /^CMD\b/.test(line));

    expect(declarations, `\`${DOCKERFILE}\` must declare exactly one CMD`).toHaveLength(1);
    const args = JSON.parse((declarations[0] ?? "").replace(/^CMD\s+/, "")) as unknown;
    expect(args, `the CMD must keep running \`${SERVER_ENTRY}\`, which is what calls \`app.listen\``).toEqual([
      "node",
      SERVER_ENTRY,
    ]);
  });
});
