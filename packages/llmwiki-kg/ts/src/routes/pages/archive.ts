/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/archive.ts
 * @description The archive's README, entry names, and entry list.
 *
 * Split out of `routes/pages.ts` as its own unit because every one of these is a
 * pure function whose output is compared byte for byte against the oracle's own
 * archive — the README text, the `+00:00` timestamp form and the filename
 * substitutions are all measured contracts.
 */

// Archive assembly (pure)
// ---------------------------------------------------------------------------

/** One file inside the generated archive. */
export interface ArchiveEntry {
  readonly name: string;
  readonly content: string;
}

/**
 * The README written into every archive.
 *
 * Transcribed from the oracle's own output byte for byte, including the em dash
 * and the ISO timestamp with a `+00:00` offset — the Python code interpolates
 * `datetime.now(timezone.utc).isoformat()`, which is **not** the `Z` form the
 * JSON endpoints use. Measured archive text:
 *
 * ```
 * # W2 Pages Probe — Entity Pages
 *
 * Generated from AKS Stack `w2pg-probe-main` on 2026-10-22T05:12:48.591393+00:00.
 *
 * Total entities: 13
 *
 * Each `.md` file is a wiki-style page for one entity, generated from the compiled knowledge graph.
 * ```
 */
export function buildReadme(
  stackName: string,
  stackDomain: string,
  entityCount: number,
  generatedAt: Date,
): string {
  return (
    `# ${stackName} — Entity Pages\n\n` +
    `Generated from AKS Stack \`${stackDomain}\` ` +
    `on ${pythonUtcIsoformat(generatedAt)}.\n\n` +
    `Total entities: ${String(entityCount)}\n\n` +
    `Each \`.md\` file is a wiki-style page for one entity, ` +
    `generated from the compiled knowledge graph.\n`
  );
}

/**
 * `datetime.now(timezone.utc).isoformat()`.
 *
 * Python's `datetime.isoformat()` emits a `+00:00` offset, omits the fractional
 * part when it is exactly zero, and otherwise emits six digits. `Date` supplies
 * milliseconds, so the last three are zeros — the same rule the page timestamps
 * follow.
 */
export function pythonUtcIsoformat(instant: Date): string {
  const iso = instant.toISOString();
  const millis = iso.slice(20, 23);
  const whole = iso.slice(0, 19);
  return millis === "000" ? `${whole}+00:00` : `${whole}.${millis}000+00:00`;
}

/**
 * The filename one entity's page is stored under.
 *
 * Python's chain of `str.replace` calls, in the same order: forward slash,
 * backslash and colon become `-`, and spaces become `_`. Measured:
 * `Billing Service` -> `Billing_Service.md`.
 *
 * Only those four substitutions happen. A name containing `?`, `*` or a control
 * character keeps it, so this is *filename sanitisation by the oracle's rule*,
 * not a general-purpose sanitiser — reproducing it exactly is what keeps the two
 * archives' file lists comparable.
 */
export function pageFilename(entityName: string): string {
  const safeName = entityName
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .replaceAll(":", "-")
    .replaceAll(" ", "_");
  return `${safeName}.md`;
}

/** Assembles the archive's entry list in the oracle's order. */
export function buildArchiveEntries(
  readme: string,
  pages: readonly { readonly entityName: string; readonly markdown: string }[],
): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [{ name: "README.md", content: readme }];
  for (const page of pages) {
    entries.push({ name: pageFilename(page.entityName), content: page.markdown });
  }
  return entries;
}

