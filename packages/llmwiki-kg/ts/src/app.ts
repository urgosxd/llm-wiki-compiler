/**
 * @file packages/llmwiki-kg/ts/src/app.ts
 * @description The composed KG application: MCP at `/mcp`, everything else untouched.
 *
 * ## Why this is an OUTER app and not a mount inside `createApp()`
 *
 * `createApp()` is composed by `packages/api/src/host/server.ts`, so adding a
 * mount to it would change a shared surface for a KG-only endpoint. Adding one
 * to the RETURNED app is not possible either: `createApp()` installs its 404
 * fallback and its error handler before returning (`server.ts:249` and `:251`),
 * so any route appended afterwards is unreachable — measured, `POST /mcp` on
 * the returned app answers `{"detail":"Not Found"}`.
 *
 * So the composition happens one level OUT, and it works because middleware
 * order is the whole contract:
 *
 * 1. `app.all(MCP_HTTP_PATH, auth, json, handler, error)` claims the EXACT path
 *    `/mcp` and never calls `next()` on success, so an MCP request cannot fall
 *    through. It is a route, not a prefix mount: `app.use('/mcp', …)` also
 *    claims `/mcp/mcp` and `/mcp/anything`, which the pre-branch build answered
 *    with 404 and which must stay unserved — measured on the built image.
 *    `all`, not `post`, because the transport serves GET (SSE), POST and DELETE.
 * 2. `app.use(apiApp)` hands every other path to the untouched `createApp()`
 *    app, which keeps `/stacks`, `/aks/v1`, ingest, synthesize, its CORS/405
 *    middleware, its 404 body and its error handler exactly as tested.
 *
 * `/mcp` requests never reach the inner app, so nothing is body-parsed twice,
 * and the inner app's catch-all never sees them. `server.ts` itself stays
 * byte-identical.
 *
 * The error handler closes the last hole in the chain: without it a malformed
 * JSON body on `/mcp` left Express's default HTML page and stack trace on a
 * public endpoint instead of the KG's `{"detail":…}` envelope.
 *
 * ## Why the guard is here and not on the inner routers
 *
 * Every KG route except `/health` requires `X-API-Key`. `/mcp` is guarded the
 * same way, per request and BEFORE the body is parsed. This is a DELIBERATE
 * divergence from the wiki's unauthenticated `/mcp` mount: an unauthenticated
 * `/mcp` here would expose `get_entities` and `traverse_stack`, which are graph
 * reads over the whole stack, to anyone who reaches the port. Copying the wiki
 * would spread a defect dressed as parity, so the guard is applied and tested.
 *
 * ## Why every input is injectable
 *
 * Tests boot this app on an ephemeral port with their own router wrapper, their
 * own MCP dependencies and their own guard, so the guard is genuinely exercised
 * rather than pass-through by accident of ambient environment.
 */

import express from "express";
import type { Express } from "express";

import { requireApiKey, type ApiKeyMiddleware } from "./auth.js";
import type { McpDependencies } from "./mcp/handlers.js";
import { MCP_HTTP_PATH, createMcpHttpHandler, mcpErrorHandler } from "./mcp/http.js";
import { createApp } from "./server.js";

/** Router dependencies accepted by {@link createApp}, passed straight through. */
export type KgRouterDependencies = Parameters<typeof createApp>[0];

/** What the composition accepts; every input is optional so tests can inject. */
export interface KgAppOptions {
  /** Forwarded to {@link createApp}; `undefined` keeps production defaults. */
  readonly routerDependencies?: KgRouterDependencies;
  /** Where the MCP tools send their HTTP calls; `undefined` keeps the MCP config defaults. */
  readonly mcpDependencies?: McpDependencies;
  /** The middleware guarding `/mcp`; defaults to the process-wide `requireApiKey`. */
  readonly apiKey?: ApiKeyMiddleware;
}

/**
 * Builds the outer application: MCP at `/mcp`, the whole KG API behind it.
 *
 * @param options - Injectable dependencies; production passes nothing.
 * @returns The Express app, MCP mount included.
 */
export function createKgApp(options: KgAppOptions = {}): Express {
  const app = express();

  app.all(
    MCP_HTTP_PATH,
    options.apiKey ?? requireApiKey,
    express.json({ strict: false }),
    createMcpHttpHandler(options.mcpDependencies),
    mcpErrorHandler,
  );
  app.use(createApp(options.routerDependencies));

  return app;
}
