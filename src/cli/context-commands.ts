/**
 * @file Read-only context and next-action CLI registration. Keeps command
 * options and presentation together without expanding the main entrypoint.
 */
import type { Command } from "commander";
import { nextCommand } from "@atomicstrata/llmwiki-core/compiler-cli";
import { contextCommand, type ContextCommandOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { linksHereCommand, type LinksHereOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { categoryCommand, type CategoryCommandOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import { categoriesHereCommand, type CategoriesHereOptions } from "@atomicstrata/llmwiki-core/compiler-cli";
import {
  DEFAULT_RACE_MAX_DEPTH,
  RACE_MAX_DEPTH_CEILING,
  raceCommand,
  type RaceCommandOptions,
} from "@atomicstrata/llmwiki-core/compiler-cli";
import { setVerbose } from "@atomicstrata/llmwiki-core/compiler-cli";
import { runExitCodeCommand } from "@atomicstrata/llmwiki-core/compiler-cli";

/** Register advisory commands with the main CLI verbose-option policy. */
export function registerContextCommands(program: Command, verboseEnabled: (flag?: boolean) => boolean): void {
  program
    .command("next")
    .description("Show the recommended next action for this llmwiki project (read-only)")
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .action(async (options: { json?: boolean }) =>
      runExitCodeCommand(() => nextCommand({ json: options.json })),
    );
  
  program
    .command("links-here <slug>")
    .description(
      "List the wiki pages that link TO <slug>, so the graph can be walked backwards " +
        "(read-only; e.g. 'concepts/foo' or a bare 'foo')",
    )
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .action(async (slug: string, options: LinksHereOptions) =>
      runExitCodeCommand(async () => linksHereCommand(slug, options)),
    );

  program
    .command("category <slug>")
    .description(
      "List the pages a wiki category groups, with the reason each was assigned " +
        "(read-only; e.g. 'sistemas-distribuidos', 'categories/sistemas-distribuidos' " +
        "or its canonical name)",
    )
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .addHelpText(
      "after",
      "\nExit codes:\n" +
        "  0  answered (including an unknown category name or a category with no\n" +
        "     members: both are reported in the output, not as a failure)\n" +
        "\nMembers are listed in the stored order (page id, then reason), so two runs\n" +
        "on the same wiki print the same bytes. `llmwiki categories-here <page-id>`\n" +
        "answers the opposite direction.\n",
    )
    .action(async (slug: string, options: CategoryCommandOptions) =>
      runExitCodeCommand(async () => categoryCommand(slug, options)),
    );

  program
    .command("categories-here <page-id>")
    .description(
      "List the wiki categories a page belongs to (read-only; e.g. " +
        "'concepts/some-concept' or a bare 'some-concept')",
    )
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .addHelpText(
      "after",
      "\nExit codes:\n" +
        "  0  answered (including a page in no category, and a wiki with none yet)\n" +
        "\n`llmwiki category <slug>` answers the opposite direction. Both read the\n" +
        "category files under wiki/categories/ and nothing else.\n",
    )
    .action(async (pageId: string, options: CategoriesHereOptions) =>
      runExitCodeCommand(async () => categoriesHereCommand(pageId, options)),
    );

  program
    .command("race <from> <to>")
    .description(
      "Find the shortest link route between two wiki pages (wiki-race navigation; " +
        "read-only; e.g. 'concepts/foo concepts/bar' or two bare slugs)",
    )
    .option(
      "--max-depth <n>",
      "Maximum hops to walk before stopping " +
        `(default ${DEFAULT_RACE_MAX_DEPTH}, max ${RACE_MAX_DEPTH_CEILING})`,
    )
    .option("--json", "Emit a stable JSON envelope for agent consumption")
    .addHelpText(
      "after",
      "\nExit codes:\n" +
        "  0  route found (including the zero-hop route from a page to itself)\n" +
        "  1  target unreachable; the reason, including the depth bound when that is\n" +
        "     what stopped the search, is written to stderr\n" +
        "  2  invalid request (unknown page name or unusable --max-depth)\n" +
        "\nThe route is deterministic: when several shortest routes exist, the one\n" +
        "whose page ids sort first wins.\n",
    )
    .action(async (from: string, to: string, options: RaceCommandOptions) =>
      runExitCodeCommand(async () => raceCommand(from, to, options)),
    );

  program
    .command("context <prompt>")
    .description(
      "Build an agent-ready evidence pack for <prompt> from the compiled wiki " +
        "(read-only; provider credentials optional — semantic retrieval is used " +
        "when available and falls back to lexical otherwise)",
    )
    .option("--budget <tokens>", "Approximate output token budget (default 8000)")
    .option("--format <format>", "Output format: json | markdown (default markdown)")
    .option("--json", "Emit the stable v1 JSON envelope (overrides --format)")
    .option("--depth <n>", "Graph neighborhood depth, default 1, max 2; 0 disables expansion")
    .option("--top-pages <n>", "Max primary pages (default 5, max 20)")
    .option("--top-chunks <n>", "Max semantic chunks (default 8, max 50)")
    .option("--omit-root", "Emit project.root as null for privacy")
    .option("--no-neighbors", "Suppress graph expansion (keeps neighbors/gaps as empty arrays)")
    .option(
      "--include-sources",
      "Populate primary[].sourceWindows from claim-level citation spans (max 20 windows, 30 lines each)",
    )
    .option("--verbose", "Print detailed progress (or set LLMWIKI_VERBOSE=1)")
    .action(async (prompt: string, options: ContextCommandOptions & { verbose?: boolean }) => {
      setVerbose(verboseEnabled(options.verbose));
      return runExitCodeCommand(() => contextCommand(prompt, options));
    });
}
