/**
 * @file test/fixtures/keyless-provider.ts
 * @description Run work with the shipped keyless provider selected, and put the previous
 * selection back afterwards.
 *
 * ## Why this is one shared function and not a helper per suite
 *
 * Two suites compile through the real SDK and neither has a key to compile with, so both
 * select the `offline` provider for the duration of the compile. Each used to carry its own
 * copy of the save/select/restore dance, which `fallow` reported as a clone against the
 * repository's own duplication gate -- two copies of one behaviour that the gate is right to
 * call a copy. Sharing it fixes what the gate found instead of reshaping a copy until the
 * detector stops looking.
 *
 * ## Why the previous value is restored and not cleared
 *
 * `LLMWIKI_PROVIDER` is process-wide, and these suites share a process with suites that never
 * call this. So the variable is put back exactly as it was found, including its ABSENCE:
 * `delete` restores "not set", which is not the same state as `""` and is what the code under
 * test distinguishes when it asks whether a provider was named at all.
 */

/**
 * Run `fn` with the shipped keyless provider selected, restoring the selection after.
 *
 * @param fn - Work to run while the keyless provider is selected.
 * @returns Whatever `fn` returned.
 */
export async function keylessly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LLMWIKI_PROVIDER;
  process.env.LLMWIKI_PROVIDER = "offline";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LLMWIKI_PROVIDER;
    else process.env.LLMWIKI_PROVIDER = saved;
  }
}
