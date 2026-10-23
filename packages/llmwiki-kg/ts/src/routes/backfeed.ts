/**
 * @file packages/llmwiki-kg/ts/src/routes/backfeed.ts
 * @description `/aks/v1/backfeed` router — public surface.
 *
 * The TypeScript port of `app/routers/backfeed.py`. Five endpoints reproduce the
 * human-review loop: flag an item, list the queue, read one item, approve it
 * (absorbing the proposal into the ontology) or reject it. Nothing here calls an
 * LLM — the reasoning already happened before the item reached the queue.
 *
 * The module was split into `src/routes/backfeed/` to keep each file under the
 * project's size limits. It remains the single import site, so `server.ts` and
 * the tests import `routes/backfeed.js` unchanged:
 *
 * | Concern | Module |
 * | --- | --- |
 * | Column list + queue row shape | `backfeed/model.ts` |
 * | Query validation + error senders | `backfeed/query.ts` |
 * | `resolve_stack` | `backfeed/stack.ts` |
 * | Row → response DTO | `backfeed/row.ts` |
 * | `POST /flag` | `backfeed/flag.ts` |
 * | `GET /queue` | `backfeed/queue.ts` |
 * | `GET /:item_id` | `backfeed/get.ts` |
 * | `POST /approve` | `backfeed/approve.ts` |
 * | `POST /reject` | `backfeed/reject.ts` |
 * | Router construction | `backfeed/router.ts` |
 *
 * Every non-obvious behaviour below is a measurement against the live oracle,
 * named where it lives.
 *
 * ## Row shape and key order are contractual
 *
 * {@link BACKFEED_COLUMNS} repeats the column list from the Python module
 * verbatim, in order. The JSON key order of every response comes from
 * `BackfeedItemResponse`'s declaration order, exactly like Python's
 * `BackfeedItemResponse(**row)`: the row is handed to the Zod schema, which both
 * validates and fixes the order. Postgres `jsonb` does **not** preserve object
 * key order (it stores keys sorted by length then bytes), so re-parsing the
 * proposal through `BackfeedProposal` is what keeps the nested entity objects in
 * the oracle's order.
 *
 * ## Route order matters
 *
 * `GET /queue` is registered before `GET /:item_id`, mirroring the Python
 * decorator order. Express matches in registration order, so reversing them
 * would make `/queue` parse as an item id and answer 422 instead of listing.
 *
 * ## `item_status` is validated in the handler, not by the DTO
 *
 * Python types it `Optional[str]` and compares in the body, so an invalid value
 * is a 400 `{"detail": "<string>"}`, not a 422. Measured on the oracle:
 * `?item_status=bogus` answers 400 while a bad `stack_id` on the same request
 * answers 422 — and the query-parameter 422s are produced *before* the handler
 * runs, so `?stack_id=nope&item_status=bogus` reports the UUID error first.
 */

export { createBackfeedRouter } from "./backfeed/router.js";
export type { BackfeedRouterDependencies } from "./backfeed/router.js";
