/**
 * @file A module-resolution hook that makes the tree in `process.cwd()` authoritative.
 *
 * WHY A HOOK EXISTS AT ALL. The guard this fixture serves runs the suite's REAL
 * `test/global-setup.ts` in a child process against a temporary tree, so that a
 * regression in its deferred imports or in its `teardown()` gate turns a committed
 * test red. The obvious way to simulate an uninstalled tree is to move
 * `node_modules/@repo/kg` aside, which is forbidden: a crashed or interrupted test
 * would leave a broken install behind, and that is worse than the gap the guard
 * closes. A cwd-only simulation has the opposite hole — the setup module and every
 * fixture it imports still live in the real repository, so Node resolves their
 * `@repo/…` specifiers against the real tree no matter what the cwd says, and the
 * "uninstalled" child would happily import the package it is supposed to miss.
 *
 * So this hook closes both: the setup's module graph resolves as if the current
 * directory's `node_modules` were the only one that exists, and nothing on disk
 * moves. Every assertion stays behavioural, on the child's real output.
 *
 * WHAT IT DOES, IN TWO RULES:
 *
 * 1. A `@repo/…` or `@testcontainers/…` specifier whose package is ABSENT from
 *    `<cwd>/node_modules` fails with Node's own wording for an absent package —
 *    `Cannot find package '<specifier>' imported from <parentURL>` and
 *    `code = "ERR_MODULE_NOT_FOUND"` — so an attempted workspace import reproduces
 *    the exact error the preflight exists to replace.
 *
 *    The denial is CONDITIONAL on absence, because a healthy temporary tree supplies
 *    those links and must be able to import them: an unconditional denial would make
 *    every workspace import fail in the healthy child too, and the guard could never
 *    show that setup proceeds on a correct tree.
 *
 * 2. `test/` writes `.js` specifiers (its packages are type-checked with
 *    `moduleResolution: "bundler"`, where `./x.js` means `./x.ts`), and Node 24's
 *    type stripping does not remap them: loading `test/global-setup.ts` directly
 *    fails with `ERR_MODULE_NOT_FOUND: Cannot find module '…/test/fixtures/
 *    install-preflight.js'`. So a `.js` specifier that fails that way is retried once
 *    as `.ts` before the ORIGINAL error is rethrown. `scripts/` needs none of this —
 *    it is node-native and already writes `.ts` — which is why the retry is confined
 *    to the failing case instead of rewriting every specifier.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** Specifier prefixes this hook treats as installed only when the tree carries them. */
const PROBED_PREFIXES = ["@repo/", "@testcontainers/"];

/** Suffix `test/` writes for a module Node must load from its `.ts` neighbour. */
const SCRIPT_SUFFIX = ".js";

/** The neighbour's suffix. */
const TYPESCRIPT_SUFFIX = ".ts";

/**
 * The package a scoped specifier names, e.g. `@repo/kg` from `@repo/kg/testing/x`.
 *
 * @param {string} specifier - A module specifier.
 * @returns {string} Its package name; the first two segments joined.
 */
function packageNameOf(specifier) {
  return specifier.split("/").slice(0, 2).join("/");
}

/**
 * True when the specifier names a package the current tree does not carry.
 *
 * @param {string} specifier - A module specifier.
 * @returns {boolean} Whether resolution must be denied.
 */
function absentFromTree(specifier) {
  if (!PROBED_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return false;
  return !existsSync(path.join(process.cwd(), "node_modules", packageNameOf(specifier)));
}

/**
 * Build the error Node raises for a package that was never installed.
 *
 * Reproduced verbatim rather than approximated: the guard counts the literal
 * `Cannot find package` occurrences in the child's output, so the same wording is what
 * makes a leaked workspace import indistinguishable from the real failure.
 *
 * @param {string} specifier - The specifier that could not be resolved.
 * @param {string | undefined} parentURL - The importing module's URL.
 * @returns {Error} An error carrying `ERR_MODULE_NOT_FOUND`.
 */
function cannotFindPackage(specifier, parentURL) {
  const error = new Error(`Cannot find package '${specifier}' imported from ${parentURL}`);
  error.code = "ERR_MODULE_NOT_FOUND";
  return error;
}

/**
 * True for a resolution failure, which is the only failure worth retrying.
 *
 * @param {unknown} error - Whatever `nextResolve` rejected with.
 * @returns {boolean} Whether it is a module-not-found error.
 */
function isModuleNotFound(error) {
  return typeof error === "object" && error !== null && error.code === "ERR_MODULE_NOT_FOUND";
}

/**
 * True for a resolution failure of a `test/`-style `.js` specifier, the only case worth retrying.
 *
 * Kept as one predicate so the retry decision reads as a single question and the
 * resolver itself stays flat.
 *
 * @param {string} specifier - The specifier that failed to resolve.
 * @param {unknown} error - Whatever `nextResolve` rejected with.
 * @returns {boolean} Whether the `.ts` neighbour should be tried.
 */
function canRetryAsTypeScript(specifier, error) {
  return isModuleNotFound(error) && specifier.endsWith(SCRIPT_SUFFIX);
}

/**
 * Resolve one specifier: deny what the tree lacks, then hand the rest to Node, with one retry.
 *
 * @param {string} specifier - The specifier being resolved.
 * @param {{ parentURL?: string }} context - The loader context Node supplies.
 * @param {(specifier: string, context: unknown) => Promise<unknown>} nextResolve - Node's own resolver.
 * @returns {Promise<unknown>} Node's resolution.
 */
export async function resolve(specifier, context, nextResolve) {
  if (absentFromTree(specifier)) throw cannotFindPackage(specifier, context.parentURL);
  return await resolveWithRetry(specifier, context, nextResolve);
}

/**
 * Ask Node to resolve, retrying a failing `.js` specifier once as `.ts`.
 *
 * The retry runs ONLY after a real failure, and a retry that also fails rethrows the
 * ORIGINAL error: a reader then sees the specifier they wrote, not a rewritten one.
 *
 * @param {string} specifier - The specifier being resolved.
 * @param {{ parentURL?: string }} context - The loader context Node supplies.
 * @param {(specifier: string, context: unknown) => Promise<unknown>} nextResolve - Node's own resolver.
 * @returns {Promise<unknown>} Node's resolution.
 */
async function resolveWithRetry(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!canRetryAsTypeScript(specifier, error)) throw error;
    return await retryOrRethrow(specifier, context, nextResolve, error);
  }
}

/**
 * Resolve the `.ts` neighbour, rethrowing the original error when that fails too.
 *
 * @param {string} specifier - The `.js` specifier that failed.
 * @param {{ parentURL?: string }} context - The loader context Node supplies.
 * @param {(specifier: string, context: unknown) => Promise<unknown>} nextResolve - Node's own resolver.
 * @param {unknown} error - The original resolution failure.
 * @returns {Promise<unknown>} Node's resolution of the `.ts` neighbour.
 */
async function retryOrRethrow(specifier, context, nextResolve, error) {
  try {
    return await nextResolve(`${specifier.slice(0, -SCRIPT_SUFFIX.length)}${TYPESCRIPT_SUFFIX}`, context);
  } catch {
    throw error;
  }
}
