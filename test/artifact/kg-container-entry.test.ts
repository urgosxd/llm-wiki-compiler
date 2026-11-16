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
 * 4. **No credential, no DSN, no endpoint is written.** The script carries variable
 *    NAMES only: the DSN and the keys arrive from the caller.
 * 5. **`CMD` still names the server bundle.** The entrypoint composes with the
 *    existing `CMD`, and the no-argument branch execs that same bundle, so the
 *    process that finally runs is the one that reaches `app.listen`.
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

describe("KG entrypoint carries no configuration of its own", () => {
  it("writes no DSN, credential or endpoint value of its own", async () => {
    const script = await readRepoFile(ENTRY_SOURCE);

    for (const name of ["DATABASE_URL", "GATEWAY_URL", "GATEWAY_API_KEY"]) {
      expect(
        assignmentLines(script, name),
        `\`${ENTRY_SOURCE}\` must not assign \`${name}\`: it arrives from the caller, and a value written here ` +
          `is either a credential in the image or a wiring the caller cannot override`,
      ).toEqual([]);
    }

    expect(script, `\`${ENTRY_SOURCE}\` must carry no hard-coded http(s) endpoint`).not.toMatch(/https?:\/\//);

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
