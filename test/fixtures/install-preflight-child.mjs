/**
 * @file Run the suite's real `test/global-setup.ts` in a child, against the tree the cwd names.
 *
 * The guard test spawns this driver because the two seams it protects cannot be seen
 * from inside the test process: hoisting a workspace-reaching import back to the top
 * level of the setup module kills the module while it LOADS, and an ungated
 * `teardown()` re-raises the very error the install preflight exists to replace. Both
 * are properties of a process that runs the real setup, so the driver runs it and
 * prints what happened.
 *
 * It deliberately mirrors vitest's order, including the part that is easy to miss:
 * vitest records a project's globalSetup handles BEFORE `setup()` throws and still
 * awaits the matching `teardown()`, so a failure in setup must not skip teardown here
 * either. That is what makes an ungated teardown visible, and it is why
 * {@link runSetup} and {@link runTeardown} are both called unconditionally.
 *
 * THE TREE UNDER TEST IS THE WORKING DIRECTORY, AND THE SETUP MODULE IS NAMED
 * STATICALLY. `test/global-setup.ts` resolves every repo-relative probe path against
 * `path.resolve(".")`, so a parent that spawns this driver with a temporary cwd is
 * spawning it against a temporary tree — no environment variable, and no behaviour
 * added to the setup module to make it testable. The module itself is reached through a
 * literal module-relative specifier rather than a path handed in on the command line:
 * a literal resolves against THIS file while the cwd still governs the probe, and the
 * repository's dimension-boundary rule reports a computed specifier precisely because
 * it cannot verify one.
 *
 * The denial hook runs in the loader's own thread, so it is registered before the
 * setup module is imported rather than after; an import evaluated ahead of it would be
 * exactly the leak it exists to catch.
 */

import { register } from "node:module";

/** Printed on stdout once `setup()` returned. */
const SETUP_OK = "SETUP-OK";

/** Printed on stdout once `teardown()` returned. */
const TEARDOWN_OK = "TEARDOWN-OK";

/** The hook this driver installs, resolved next to this file. */
const DENIAL_HOOK_URL = new URL("./deny-uninstalled-packages.mjs", import.meta.url).href;

/**
 * Report one failed step on stderr, keeping the message on a single line.
 *
 * @param {string} label - Which step failed, e.g. `"SETUP-FAILED"`.
 * @param {unknown} error - Whatever the step rejected with.
 * @returns {void}
 */
function report(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${label}: ${message}\n`);
}

/**
 * Import the setup module under the denial hook.
 *
 * A load failure is reported rather than thrown: an uninstalled tree used to die while
 * this module was evaluated, and an exception escaping here would become an unhandled
 * rejection that replaces the message the guard counts.
 *
 * @returns {Promise<object | undefined>} The setup module, or `undefined` when it could not load.
 */
async function loadSetupModule() {
  try {
    return await import("../global-setup.ts");
  } catch (error) {
    report("LOAD-FAILED", error);
    return undefined;
  }
}

/**
 * Run `setup()`, reporting whether it failed.
 *
 * @param {{ setup: () => Promise<void> }} setupModule - The loaded setup module.
 * @returns {Promise<boolean>} True when `setup()` threw.
 */
async function runSetup(setupModule) {
  try {
    await setupModule.setup();
    console.log(SETUP_OK);
    return false;
  } catch (error) {
    report("SETUP-FAILED", error);
    return true;
  }
}

/**
 * Run `teardown()`, reporting whether it failed. Always called, exactly as vitest does.
 *
 * @param {{ teardown: () => Promise<void> }} setupModule - The loaded setup module.
 * @returns {Promise<boolean>} True when `teardown()` threw.
 */
async function runTeardown(setupModule) {
  try {
    await setupModule.teardown();
    console.log(TEARDOWN_OK);
    return false;
  } catch (error) {
    report("TEARDOWN-FAILED", error);
    return true;
  }
}

/**
 * Load the setup module, then run setup and teardown in vitest's order.
 *
 * @returns {Promise<void>} Resolves after teardown, setting `process.exitCode` on any failure.
 */
async function main() {
  const setupModule = await loadSetupModule();
  if (setupModule === undefined) {
    process.exitCode = 1;
    return;
  }
  // Both run unconditionally: teardown is what shows a gate that no longer guards.
  const setupFailed = await runSetup(setupModule);
  const teardownFailed = await runTeardown(setupModule);
  if (setupFailed || teardownFailed) process.exitCode = 1;
}

register(DENIAL_HOOK_URL, import.meta.url);
await main();
