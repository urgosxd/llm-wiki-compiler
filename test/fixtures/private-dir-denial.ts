/**
 * @file test/fixtures/private-dir-denial.ts
 * @description The injectable `EACCES` on `realpath`, plus the switch that aims it.
 *
 * WHY IT IS SHARED, AND SEPARATE FROM THE REST OF THE S5 FIXTURES. Two suites inject
 * the same fault — `lock-private-dir-error-discrimination.test.ts` on the lock surface
 * and `private-dir-syscall-discrimination.test.ts` on the read resolver — and
 * `fallow` flagged the two mock blocks as one clone group. The fault is INJECTED rather
 * than produced with `chmod` on purpose: a `chmod` denies nothing to root, so the
 * verdict would depend on the uid the run happens under.
 *
 * WHY IT HAS NO IMPORTS OF ITS OWN. A mock factory is hoisted above the test file's
 * imports, so it may not close over a binding from a module that has not been evaluated
 * yet. This module imports nothing, which makes it safe to load from inside the factory
 * with a dynamic `import()` — and it must stay that way: importing the lock here would
 * make the factory load the very module whose resolution it is patching.
 */

/** Which resolved path the injected fault applies to; `null` injects nothing. */
export const denial = { suffix: null as string | null };

/**
 * Patch a module's `realpath` so it throws `EACCES` for the suffix {@link denial} names.
 *
 * @param actual - The module being mocked, usually `importOriginal()`'s result.
 * @returns That module with `realpath` replaced; every other export is untouched.
 */
export function denyingRealpath<T>(actual: T): T {
  const real = (actual as { realpath: (target: string) => Promise<string> }).realpath;
  const patched = {
    ...(actual as object),
    realpath: async (target: string): Promise<string> => {
      if (denial.suffix !== null && String(target).endsWith(denial.suffix)) {
        throw Object.assign(new Error(`EACCES: permission denied, realpath '${target}'`), {
          code: "EACCES",
          syscall: "realpath",
        });
      }
      return real(target);
    },
  };
  return patched as T;
}
