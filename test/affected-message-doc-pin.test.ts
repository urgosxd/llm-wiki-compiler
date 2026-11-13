/**
 * @file test/affected-message-doc-pin.test.ts
 * @description Pins the exit-`78` message quoted in `AGENTS.md` and `README.md`
 * to the bytes `scripts/run-affected-tests.ts` actually prints.
 *
 * WHY THIS EXISTS. That message used to name bare `pnpm test`, which is not the
 * gate, and the documentation quoted it as fact. Fixing both sides settled the
 * present tense and guarded nothing: the next person to reword the constant, or
 * the next paragraph to be rewritten by hand, reintroduces the same rot with no
 * gate left to catch it. The documents are the only place a reader copy-pastes
 * from before their first `78`, so a stale quote there is worse than a stale
 * comment in the code.
 *
 * THE RULE THIS TEST OBEYS. It DERIVES the expected text: the expectation is the
 * imported {@link FULL_TIER_LINE} constant, never a literal copied here. A third
 * copy of the message in this file would be one more thing to rot, so the only
 * string written down below is a locator — where in the document the quoted fence
 * lives — and a locator that disappears fails loudly instead of passing over an
 * unread document.
 *
 * SCOPE — what this guard does NOT cover. It pins the fenced quote in the two
 * documents that carry one, byte for byte, including each line's trailing
 * newline and the two significant leading spaces of the command line. It does not
 * read the prose around the fence: the surrounding paragraph describes the same
 * behaviour in its own words, and this test is not a prose linter.
 *
 * Unit tier: two file reads and two exact string comparisons. No child process,
 * no git, no network, no timing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FULL_TIER_LINE } from "../scripts/run-affected-tests.js";

/** The fence marker this repository's documents quote command output in. */
const FENCE_OPEN = "```text";

/**
 * The fenced quote that follows a locator, dedented by the marker's indentation.
 *
 * The dedent removes EXACTLY the fence marker's own leading whitespace, because a
 * fence inside a list item inherits the item's indent as a file artefact no reader
 * ever sees. Removing it restores the bytes a terminal would show, which is what
 * the tool writes, so the comparison stays an honest byte-for-byte one.
 *
 * @param document - Repository-relative path of the document.
 * @param locator - Text whose first following fence is the quote being pinned.
 * @returns The fence body, with the marker's indent removed from every line.
 */
function quotedFence(document: string, locator: string): string {
  const text = readFileSync(new URL(`../${document}`, import.meta.url), "utf8");
  const from = text.indexOf(locator);
  expect(from, `${document} no longer contains its locator: ${locator}`).toBeGreaterThan(-1);
  const fence = /^([ \t]*)```text\n([\s\S]*?)^\1```$/m.exec(text.slice(from));
  expect(fence, `${document} no longer quotes the message in a ${FENCE_OPEN} fence after: ${locator}`).not.toBeNull();
  const indent = fence?.[1] ?? "";
  return (fence?.[2] ?? "")
    .split("\n")
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join("\n");
}

describe("documented exit-78 message", () => {
  it("quotes the message AGENTS.md shows inside its Test Execution Policy, byte for byte", () => {
    expect(quotedFence("AGENTS.md", "### Test Execution Policy")).toBe(FULL_TIER_LINE);
  });

  it("quotes the same message in README.md, byte for byte", () => {
    expect(quotedFence("README.md", "run what CI runs yourself instead")).toBe(FULL_TIER_LINE);
  });
});
