/**
 * @file The CATEGORY ASSIGNMENT prompt and tool schema, beside the stage that uses them.
 *
 * WHY NOT IN `src/compiler/prompts.ts`. That module holds the prompts of the PAGE
 * pipeline -- extraction, page generation, seed pages and the reference review -- and a
 * category is a different object type: the answer it asks for is written to
 * `wiki/categories/`, never into a page body. Keeping the category prompt with the stage
 * that consumes it (`assign.ts`) also keeps `prompts.ts` under the repository's file-size
 * ceiling, which the page prompts would otherwise breach for a prompt page generation
 * never uses.
 *
 * WHAT IT ASKS FOR, AND WHY EACH FIELD EXISTS. The schema forces every attribute `S10`
 * requires (canonical name, description, inclusion criterion) plus the reason THIS page
 * belongs, so a proposal arrives complete or countable. The criterion must QUOTE the
 * words that decide membership: a criterion nothing can be checked against is decoration,
 * and `criteria.ts` is what executes the quoted form.
 *
 * LANGUAGE. The prompt lines go through `withLangLine`, the same helper every other
 * prompt builder uses, so an operator's output-language option reaches this call too.
 */

import { withLangLine } from "../compiler/prompts.js";

/**
 * Anthropic tool definition for CATEGORY ASSIGNMENT of one article (S10).
 *
 * The schema forces every field the category object requires, so a proposal that
 * arrives here is either complete or countable as incomplete -- never silently
 * completed by a default. Two of its fields exist for one reason each:
 *
 *  - `inclusion_criterion` states the rule in prose AND quotes the words that decide
 *    membership. A criterion that cannot be quoted cannot be checked, and an
 *    unchecked criterion is decoration (see `src/categories/criteria.ts`);
 *  - `reason` is why THIS article belongs, recorded as the member's evidence so
 *    membership is auditable from the category file alone, months later.
 */
export const CATEGORY_ASSIGNMENT_TOOL = {
  name: "assign_categories",
  description:
    "Propose the wiki categories one article belongs to, each with a checkable inclusion criterion",
  input_schema: {
    type: "object" as const,
    properties: {
      categories: {
        type: "array",
        description:
          "Categories for this article, best first. Empty when the article belongs in none.",
        items: {
          type: "object",
          properties: {
            canonical_name: {
              type: "string",
              description:
                "The category's name as a reader sees it. Reuse the exact name of an existing category when the article belongs to it.",
            },
            description: {
              type: "string",
              description: "One sentence saying what the category is about.",
            },
            inclusion_criterion: {
              type: "string",
              description:
                "One sentence stating which pages belong, quoting in double quotes the words a page must mention to qualify.",
            },
            reason: {
              type: "string",
              description:
                "Why THIS article belongs, referring to what the article actually says.",
            },
          },
          required: ["canonical_name", "description", "inclusion_criterion", "reason"],
        },
      },
    },
    required: ["categories"],
  },
};

/**
 * Build the system prompt for the category assignment of ONE article.
 *
 * The model proposes; the PIPELINE decides which of its proposals survives. It is
 * told the rule it cannot see enforced (quote the term that decides membership),
 * because a schema field nobody explains is a field an honest model fills with
 * decoration. It is also shown the existing categories: proposing a name that already
 * exists is how a taxonomy stays small, and the reuse itself is decided by canonical
 * key in code, never by the model's choice of spelling.
 *
 * @param input - The article being categorised and the categories that exist.
 * @returns System prompt string for the assignment call.
 */
export function buildCategoryAssignmentPrompt(input: {
  articleTitle: string;
  existingCategories: readonly string[];
}): string {
  const existing = input.existingCategories.length === 0
    ? "This wiki has no categories yet: propose a small number of new ones, or none."
    : `Categories that already exist (reuse these names when the article belongs): ${
      input.existingCategories.map((name) => `"${name}"`).join(", ")
    }.`;
  return [
    ...withLangLine(
      "You are placing ONE wiki article into categories, the way an encyclopedia does.",
      "A category GROUPS pages; it is not the topic itself and it may share a name with an article.",
      "Propose at most three categories for this article, and none when it belongs in no group.",
      "For each one, state the inclusion criterion as a rule and QUOTE in double quotes the exact words a page must mention to qualify.",
      "Quote words this article really contains: a criterion the article does not satisfy is not a category for it.",
      "Say why THIS article belongs, in terms of what the article says.",
      "Use the assign_categories tool to answer.",
    ),
    "",
    existing,
    `\n\nArticle to categorise: "${input.articleTitle}".`,
  ].join("\n");
}

