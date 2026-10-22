/**
 * @file packages/llmwiki-kg/ts/src/core/page_generator.ts
 * @description Entity page generation — public surface.
 *
 * The TypeScript port of `app/core/page_generator.py`.
 *
 * A page is a markdown document synthesized from the **compiled graph**, never
 * from the raw source documents: the model is shown the entity's neighbours,
 * which is what makes the page domain-aware. Generation is cached in
 * `entity_pages` under a `graph_version` hash of the entity's own state, so any
 * change to the entity, its edges, or its contributing documents invalidates the
 * cache on the next read.
 *
 * The module was split into `src/core/page/` to keep each file under the
 * project's size limits. It remains the single import site, so `routes/pages.ts`
 * and the tests import `core/page_generator.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Row shapes a page is built from | `page/context.ts` |
 * | CPython float `repr` + format error | `page/float-repr.ts` |
 * | CPython `f"{x:.2f}"` rounding | `page/fixed2.ts` |
 * | CPython `json.dumps(sort_keys=True)` | `page/json-dumps.ts` |
 * | The `graph_version` cache key | `page/graph-version.ts` |
 * | The generation prompt + token budget | `page/prompt.ts` |
 * | Graph reads + one LLM call | `page/context-read.ts` |
 * | Cache lookup, generation, upsert | `page/cache.ts` |
 * | Pydantic `timestamptz` formatting | `page/utc-now.ts` |
 *
 * ## Python byte-formatting is part of the hash, so it is reproduced exactly
 *
 * The oracle hashes `str(float(confidence))` and
 * `json.dumps(properties, sort_keys=True)`. Both are Python *representations*,
 * and neither matches JavaScript's default stringification:
 *
 * | value | Python | JavaScript |
 * |---|---|---|
 * | `1e16` | `1e+16` | `10000000000000000` |
 * | `1e-5` | `1e-05` | `0.00001` |
 * | `1.0` (from jsonb) | `1.0` | `1` |
 *
 * Two servers sharing one `entity_pages` table is the reason this matters: if
 * this port hashed differently, each server would invalidate the other's cache
 * and every read would cost another LLM call. `page/float-repr.ts` and
 * `page/json-dumps.ts` therefore reproduce CPython's `repr`/`json` output rather
 * than approximating it, and both are pinned against values read from the
 * oracle's own interpreter.
 *
 * `properties` is read as `properties::text` (the jsonb text form) precisely
 * because JavaScript cannot tell `1.0` from `1` after `JSON.parse`. The text
 * carries the difference, and `page/json-dumps.ts` re-emits it the way
 * `json.dumps` would.
 *
 * ## The prompts are contracts too
 *
 * {@link buildPagePrompt} is exported and pinned by tests against the prompt the
 * oracle actually sent (captured by replacing `complete` with a recorder). The
 * prompt is the only input to a non-deterministic step, so it is the one part of
 * "what the page says" this port can hold constant.
 */

export type {
  EntityPageContext,
  PageDocumentRow,
  PageEntityRow,
  PageRelationshipRow,
} from "./page/context.js";

export { PythonFormatError, pythonFloatRepr } from "./page/float-repr.js";
export { formatFixed2 } from "./page/fixed2.js";
export { compareCodePoints, pythonJsonDumps } from "./page/json-dumps.js";

export { computeGraphVersion } from "./page/graph-version.js";

export { PAGE_MAX_TOKENS, buildPagePrompt } from "./page/prompt.js";

export { gatherEntityContext, generateMarkdown } from "./page/context-read.js";

export { getOrGeneratePage } from "./page/cache.js";
export type { EntityPage } from "./page/cache.js";

export { pydanticUtcNow } from "./page/utc-now.js";
