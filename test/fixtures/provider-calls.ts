/**
 * @file Scope a provider stub's assertions to the calls they were actually about.
 *
 * WHY THIS EXISTS. A compile reaches the provider for four different reasons now:
 * concept extraction, page rendering (a completion, not a tool call), the reference
 * review of earlier pages (`judge_reference`) and category assignment
 * (`assign_categories`). A dozen older suites install ONE `toolCall` implementation
 * that assumes every tool call is extraction, and assert an exact number of them; when
 * a new stage adds a call, those numbers move by the number of articles in the run and
 * the stub itself can throw on a prompt shape it never expected.
 *
 * The fix in each suite must not WEAKEN anything: "extraction was called twice" stays an
 * exact assertion, it is just asked of the extraction calls. These two helpers are that
 * scoping, written once so twelve files cannot drift into twelve different ideas of which
 * call is which.
 *
 * NOTHING HERE CHANGES A PRODUCTION CODE PATH: it reads the recorded arguments of a spy.
 */

/** The tool name the category assignment stage sends. */
export const CATEGORY_ASSIGNMENT_TOOL_NAME = "assign_categories";

/** What a stub should answer when it is not answering an extraction request. */
export const EMPTY_CATEGORY_ANSWER = JSON.stringify({ categories: [] });

/**
 * Whether one recorded `toolCall` invocation is the category assignment request.
 *
 * The discriminator is the tool NAME, the same one `stubCompileProvider` routes on: a
 * stub that answers on prompt text cannot tell the two requests apart, which is exactly
 * how an extraction stub came to throw on a category prompt.
 *
 * @param args - The recorded arguments of one `toolCall` invocation.
 * @returns True for the category assignment call.
 */
export function isCategoryAssignmentCall(args: readonly unknown[]): boolean {
  const tools = args[2];
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return (tools[0] as { name?: unknown } | undefined)?.name === CATEGORY_ASSIGNMENT_TOOL_NAME;
}

/**
 * The recorded EXTRACTION tool calls, in order.
 *
 * @param spy - The `toolCall` spy a suite installed.
 * @returns Its calls, without the category assignment ones.
 */
export function extractionCalls(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter((args) => !isCategoryAssignmentCall(args));
}
