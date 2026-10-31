/**
 * @file src/mcp/stack-arg.ts
 * @description The `stackId` argument every Stack-scoped MCP tool shares.
 *
 * ## Why one definition
 *
 * Six tools now accept this argument and a seventh family already did
 * (`job-tools.ts`, `stack-tools.ts`). A copy per tool would let the descriptions
 * drift, and the description is the only place a client learns that omitting it means
 * "the Stack this endpoint is bound to" rather than "all Stacks". That sentence
 * appearing in five slightly different wordings is how a caller ends up unsure
 * whether omitting the argument is safe.
 *
 * ## Why the description leads with the omission case
 *
 * The common deployment serves one Stack and never sends this. A client author
 * reading only the first line has to come away knowing that omitting it is supported
 * and keeps working, or every existing caller starts sending an id it does not have.
 */
import { z } from "zod";

/** Optional Stack id a caller names instead of inheriting the bound one. */
export const STACK_ID_SCHEMA = z
  .string()
  .optional()
  .describe(
    "Stack to read, when it is not the one this endpoint is bound to. " +
      "Omit for the bound Stack. An id that does not exist is an error, not an empty result.",
  );
