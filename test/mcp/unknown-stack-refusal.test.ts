/**
 * @file test/mcp/unknown-stack-refusal.test.ts
 * @description A Stack that does not exist is REFUSED, not answered as empty.
 *
 * ## The failure this pins
 *
 * Measured before the fix, against a live host, with an id that exists nowhere:
 *
 *   wiki_status    -> `{ "pages": { "total": 0 } }`   no error
 *   search_pages   -> `{ "pages": [], "refs": [] }`   no error
 *   read_page      -> "Page not found: architecture"  error, but about the PAGE
 *
 * The first two read as facts about a wiki and are really a fact about the id: the
 * caller is told "this Stack is empty" when the truth is "there is no such Stack". The
 * third is an error for the wrong reason -- it would answer differently if a page
 * happened to share the slug.
 *
 * This is the failure mode this codebase keeps re-finding: a well-formed wrong answer
 * delivered instead of a refusal, so a client cannot tell "nothing to see" from "you
 * asked about something that is not here".
 *
 * ## Why the refusal lives in `withRequestEnv`
 *
 * Validating at the seam every tool already calls means a tool added later cannot
 * forget it. `withTenantDatabase` did this for the job tools; the page readers did not.
 *
 * ## What must NOT change
 *
 * A project with no database is a supported deployment where pages are files and there
 * are no Stacks to look up, so the lookup is skipped there. What no longer exists is the
 * OTHER omission: an empty argument used to mean "the bound Stack". It is now refused
 * like any other id that is not a Stack id, before the work runs.
 */
import { describe, it, expect } from "vitest";
import { isRefusal, withRequestEnv } from "../../packages/wiki/src/mcp/tenant-db.js";

/** An id that is a well-formed UUID and exists in no Stack table. */
const ABSENT_STACK = "00000000-0000-4000-8000-000000000000";

describe("a named Stack that does not exist", () => {
  it("is refused rather than answered with an empty result", async () => {
    const outcome = await withRequestEnv(ABSENT_STACK, async () => "the tool ran");

    expect(isRefusal(outcome)).toBe(true);
    // The refusal names the id: "invalid request" alone would not tell a caller which
    // of several Stacks it got wrong.
    expect(JSON.stringify(outcome)).toContain(ABSENT_STACK);
  });

  it("does not run the work", async () => {
    let ran = false;
    await withRequestEnv(ABSENT_STACK, async () => {
      ran = true;
      return "ran";
    });

    // Load-bearing: returning a refusal AND running the tool would leave the caller
    // with a refusal while the side effects already happened.
    expect(ran).toBe(false);
  });

  it("refuses an empty Stack argument without running the work", async () => {
    let ran = false;

    const outcome = await withRequestEnv("", async () => {
      ran = true;
      return "the tool ran";
    });

    // An empty argument is not a Stack, and it is no longer a way to ask for the bound
    // one. The refusal names what was passed instead of querying for it.
    expect(isRefusal(outcome)).toBe(true);
    expect(ran).toBe(false);
  });
});
