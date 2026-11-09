/**
 * @file src/mcp/stack-arg.ts
 * @description The `stackId` argument every Stack-scoped MCP tool shares.
 *
 * ## Why one definition
 *
 * Eleven tools accept this argument. A copy per tool would let the descriptions drift,
 * and the description is the only place a client learns what the argument is for.
 * Three inline copies of `z.string().optional()` had already drifted apart from this
 * one, which is how "omitting it inherits the bound Stack" survived in the surface
 * after it stopped being true.
 *
 * ## Why the argument is REQUIRED, with no default
 *
 * A tool that substituted the bound Stack when the argument was missing answered a
 * question the caller never asked: a client serving several Stacks — or none in
 * particular — received one tenant's data with nothing saying which. Ambiguity is now
 * refused by the schema instead of being resolved from the ambient environment, so a
 * caller must name the Stack it means on every call.
 *
 * ## Why the resources asymmetry belongs in the description
 *
 * MCP resources have no input schema: a client cannot pass an argument to one, so the
 * seven resource templates keep resolving the Stack from the server environment. A
 * caller reading only a tool description has to know that, or the absolute rule stated
 * here reads as a contradiction at the resource endpoints.
 */
import { z } from "zod";

/**
 * The required-argument rule, stated once.
 *
 * Used both in the schema description below and appended to each affected tool
 * description, so the rule and the asymmetry cannot end up phrased two ways.
 */
export const STACK_ARG_REQUIRED_NOTE =
  "The Stack must be passed explicitly: it is required, with no default and no " +
  "fallback. MCP resources are not tools and have no input schema; they resolve the " +
  "Stack from the server environment instead.";

/** Required Stack id a Stack-scoped tool reads from or writes to. */
export const STACK_ID_SCHEMA = z
  .string()
  .describe(
    `Stack to read or write. ${STACK_ARG_REQUIRED_NOTE} An id that does not exist is ` +
      "an error, not an empty result.",
  );
