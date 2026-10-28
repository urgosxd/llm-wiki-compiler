import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

import { createMethodNotAllowed } from "./http-contract.js";
import { createAksRouter } from "./routes/aks.js";
import type { AksRouterDependencies } from "./routes/aks.js";
import { createBackfeedRouter } from "./routes/backfeed.js";
import { createDocumentsRouter } from "./routes/documents.js";
import type { DocumentsRouterDependencies } from "./routes/documents.js";
import { createIngestRouter } from "./routes/ingest.js";
import type { IngestRouterDependencies } from "./routes/ingest.js";
import { createPagesRouter } from "./routes/pages.js";
import type { PagesRouterDependencies } from "./routes/pages.js";
import { createStackGraphRouter } from "./routes/stack_graph.js";
import type { StackGraphRouterDependencies } from "./routes/stack_graph.js";
import { createStacksRouter } from "./routes/stacks.js";
import type { StacksRouterDependencies } from "./routes/stacks.js";
import { createSynthesizeRouter } from "./routes/synthesize.js";
import type { SynthesizeRouterDependencies } from "./routes/synthesize.js";

/**
 * Starlette's `cors.ALL_METHODS`, verbatim, as the preflight emits it.
 *
 * This is the tuple FastAPI expands `allow_methods=["*"]` into. It includes
 * `QUERY`, which is not a verb Express knows about — that is exactly why a
 * hand-written list drifted from the oracle, and why this one is copied from
 * Starlette's source and pinned by a test instead of being typed from memory.
 */
const ALL_METHODS = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY";

/** FastAPI CORSMiddleware default `preflight_max_age` (Starlette: `max_age=600`). */
const PREFLIGHT_MAX_AGE = "600";

/** Starlette's `CORSMiddleware.preflight_headers["Vary"]`, verbatim. */
const PREFLIGHT_VARY =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network";

/** FastAPI answers a rejected preflight with this exact plain-text body. */
const DISALLOWED_PREFIX = "Disallowed CORS ";

/**
 * CORS middleware reproducing Starlette's `CORSMiddleware` under
 * `app/main.py`'s configuration:
 *
 *   app.add_middleware(
 *       CORSMiddleware,
 *       allow_origins=["*"],
 *       allow_methods=["*"],
 *       allow_headers=["*"],
 *   )
 *
 * Every branch below is a measurement against the live oracle, not a reading of
 * the docs. The two that a plausible-looking shim gets wrong:
 *
 * 1. **A preflight requires an `Origin` header.** Starlette's condition is
 *    `origin is not None and method == "OPTIONS" and "access-control-request-method"
 *    in headers`. Without `Origin` there is no preflight at all: the request
 *    falls through to the router and is answered on the method axis (measured:
 *    `OPTIONS /stacks` with only `Access-Control-Request-Method` answers 405).
 * 2. **`Access-Control-Allow-Origin` is only sent when the request carries an
 *    `Origin`.** Measured: `GET /health` with no `Origin` returns `vary: Origin`
 *    and no allow-origin header, because Starlette's `send()` adds the simple
 *    headers only inside `if origin is not None`.
 *
 * With `allow_origins=["*"]` and no credentials, the allowed value is the
 * literal `*` — the oracle does not echo the origin back.
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (
    origin !== undefined &&
    req.method === "OPTIONS" &&
    req.headers["access-control-request-method"] !== undefined
  ) {
    sendPreflight(req, res);
    return;
  }

  // Non-preflight: Starlette's `send()` runs on the way out, so the headers are
  // attached to whatever response the app produces, errors included. `res` is
  // mutable here for the lifetime of the request, hence `on-headers`-free
  // assignment before calling down the chain.
  if (origin !== undefined) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  appendVaryOrigin(res);

  next();
}

/**
 * Appends `Origin` to an existing `Vary`, as Starlette's `MutableHeaders` does.
 *
 * Express does not add `Vary` on its own, so in practice this writes `Origin`.
 * The append form is kept because a future middleware that sets `Vary` must not
 * lose its value.
 */
function appendVaryOrigin(res: Response): void {
  const existing = res.getHeader("Vary");
  const current = Array.isArray(existing)
    ? existing.join(", ")
    : existing === undefined
      ? ""
      : String(existing);

  if (current === "") {
    res.setHeader("Vary", "Origin");
    return;
  }
  if (current.split(/\s*,\s*/).includes("Origin")) {
    return;
  }
  res.setHeader("Vary", `${current}, Origin`);
}

/**
 * Answers a CORS preflight exactly like `CORSMiddleware.preflight_response`.
 *
 * The failure conditions are reproduced because they are observable on the wire:
 * the requested method must appear **verbatim** in {@link ALL_METHODS} —
 * `Access-Control-Request-Method: post` is rejected while `POST` is accepted
 * (measured) — and a requested private-network access is rejected because
 * `allow_private_network` defaults to `False`.
 *
 * A failed preflight is still a `text/plain` 400 carrying the same
 * allow-origin/allow-methods/max-age header set as a successful one, with a
 * `Disallowed CORS …` body.
 */
function sendPreflight(req: Request, res: Response): void {
  res.setHeader("Vary", PREFLIGHT_VARY);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", ALL_METHODS);
  res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);

  const requestedHeaders = req.headers["access-control-request-headers"];
  if (requestedHeaders !== undefined) {
    // Mirrored back verbatim: FastAPI runs with `allow_headers=["*"]`, so it
    // echoes whatever the client asked for rather than validating it.
    res.setHeader("Access-Control-Allow-Headers", requestedHeaders);
  }

  const failures: string[] = [];

  const requestedMethod = req.headers["access-control-request-method"];
  if (requestedMethod === undefined || !ALL_METHODS.split(", ").includes(requestedMethod)) {
    failures.push("method");
  }

  if (req.headers["access-control-request-private-network"] !== undefined) {
    failures.push("private-network");
  }

  if (failures.length > 0) {
    res.status(400).type("text/plain").send(`${DISALLOWED_PREFIX}${failures.join(", ")}`);
    return;
  }

  res.status(200).type("text/plain").send("OK");
}

/**
 * The middleware stack, in the order the oracle's observable behaviour implies.
 *
 * `createMethodNotAllowed` sits between CORS and body parsing: a genuine
 * preflight is already answered above, and `express.json` must not see the body
 * of a request that never reaches a handler (the oracle answers `PUT /stacks`
 * with malformed JSON as 405, not 400).
 *
 * `strict: false` because FastAPI's body parsing is not strict about the JSON
 * *top-level* value. Measured on the oracle:
 *
 *   POST /stacks  body `null`  -> 422 model_attributes_type, input null
 *   POST /stacks  body `5`     -> 422 model_attributes_type, input 5
 *   POST /stacks  body `[]`    -> 422 model_attributes_type, input []
 *
 * body-parser's default (`strict: true`) only accepts an array or an object at
 * the top level and rejects the rest as malformed JSON, which would answer 400
 * instead of letting the DTO report Pydantic's 422. With `strict: false` every
 * JSON value reaches the schema, and `StackCreate` / `StackUpdate` reject the
 * non-objects with exactly the error the oracle emits.
 *
 * Known divergence, not addressed here: genuinely malformed JSON (`{bad`) still
 * answers body-parser's 400, while the oracle answers 422 with
 * `type: "json_invalid"` and Python's own decoder message. Reproducing that
 * message per malformed input is a separate concern from these routes.
 */
function installMiddleware(app: Express): void {
  app.use(cors);
  app.use(createMethodNotAllowed(app));
  app.use(express.json({ strict: false }));
}

/** Liveness probe: no auth, and a body that mirrors the oracle byte for byte. */
function installHealthProbe(app: Express): void {
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "aks-reference-server",
      version: "0.2.0",
    });
  });
}

/**
 * Every router, mirroring `app.include_router(...)` in app/main.py.
 *
 * Each router owns its own auth (`dependencies=[Depends(require_api_key)]` in
 * Python), so nothing is authenticated globally and `/health` stays open.
 *
 * Mount order is fidelity with `app/main.py`, not precedence. `/aks/v1` is
 * registered before `/aks/v1/backfeed`, and `/aks/v1/pages` after the query
 * router, exactly as the Python `include_router` calls are ordered — which is
 * what the 405 `Allow` walk in `http-contract.ts` observes. Adjacent routers
 * never share a path, so no handler can shadow another.
 */
function installRouters(
  app: Express,
  deps: Parameters<typeof createApp>[0],
): void {
  app.use("/stacks", createStacksRouter(deps));
  // Root mount, no prefix: `stack_graph.ts` carries its full absolute path
  // (`/domain/kg/stacks/{stack_id}/graph`), so a prefix here would move the
  // endpoint. It sits under `/domain` precisely so it shares no prefix with the
  // oracle-owned `/stacks`, which is what keeps the 405 `Allow` walk preserving
  // the oracle's layer order for every path the oracle knows about.
  app.use(createStackGraphRouter(deps));
  app.use("/aks/v1", createAksRouter(deps));
  app.use("/aks/v1/pages", createPagesRouter(deps));
  app.use("/aks/v1/backfeed", createBackfeedRouter(deps));
  // Root mounts, no prefix: these modules carry full absolute paths on their
  // routes, so any prefix here would move their endpoints.
  //
  // `documents.py` declares its routes on two prefixes
  // (`/stacks/{stack_id}/documents` and `/documents/{doc_id}`), so prefixing
  // this mount would move the by-id routes to `/stacks/documents/...` and break
  // the 405 `Allow` ordering. `ingest.py` and `synthesize.py` likewise declare
  // absolute paths; `documents.ts` has no route continuing past `{doc_id}`, so
  // none of the three can collide.
  app.use(createDocumentsRouter(deps));
  app.use(createIngestRouter(deps));
  app.use(createSynthesizeRouter(deps));
}

/** The 404 fallback and the final error handler, in that order. */
function installFallbacks(app: Express): void {
  // JSON, never Express 5's default HTML page. FastAPI's shape for unmatched
  // routes is `{"detail": "Not Found"}`.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ detail: "Not Found" });
  });
  app.use(handleError);
}

/**
 * The final error handler.
 *
 * Unhandled server errors are NOT JSON on the oracle: FastAPI's
 * `ServerErrorMiddleware` answers a bare `PlainTextResponse("Internal Server
 * Error", status_code=500)` — measured: `content-type: text/plain; charset=utf-8`,
 * 21 bytes, no `detail` wrapper. Client errors keep their JSON shape and a safe,
 * caller-relevant message; 5xx stays opaque so internals never leak.
 */
function handleError(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const status = errorStatus(err);

  if (status >= 500) {
    res.status(status).type("text/plain").send("Internal Server Error");
    return;
  }

  const detail = err instanceof Error && err.message !== "" ? err.message : "Bad Request";
  res.status(status).json({ detail });
}

/**
 * Builds the Express application without binding a port.
 * Tests mount this directly; `index.ts` owns `listen()`.
 *
 * `deps` exists for tests: an integration suite binds the router to its own
 * connection pool and its own auth config instead of the process-wide
 * singletons. Production passes nothing and gets the defaults.
 *
 * The intersection is deliberate rather than a union: the stacks and documents
 * routers declare the same `wrap` / `apiKey` collaborators, so one value
 * satisfies both and each router keeps its own parameter type.
 */
export function createApp(
  deps?: StacksRouterDependencies &
    StackGraphRouterDependencies &
    DocumentsRouterDependencies &
    IngestRouterDependencies &
    AksRouterDependencies &
    PagesRouterDependencies &
    SynthesizeRouterDependencies,
): Express {
  const app = express();

  installMiddleware(app);
  installHealthProbe(app);
  installRouters(app, deps);
  installFallbacks(app);

  return app;
}
/**
 * Extracts an HTTP status from a thrown value, defaulting to 500.
 *
 * Kept out of the handler so the narrowing is done once, with a declared guard
 * rather than a cast.
 */
function errorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status: unknown = err.status;
    if (typeof status === "number") {
      return status;
    }
  }
  return 500;
}
