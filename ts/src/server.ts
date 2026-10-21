import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

import { createStacksRouter } from "./routes/stacks.js";
import type { StacksRouterDependencies } from "./routes/stacks.js";

/**
 * Methods FastAPI's CORSMiddleware expands from `allow_methods=["*"]`.
 * Order matches the live Python oracle's preflight response exactly.
 */
const ALL_METHODS = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT";

/** FastAPI CORSMiddleware default `preflight_max_age`. */
const PREFLIGHT_MAX_AGE = "600";

/**
 * CORS middleware mirroring `app/main.py`:
 *
 *   app.add_middleware(
 *       CORSMiddleware,
 *       allow_origins=["*"],
 *       allow_methods=["*"],
 *       allow_headers=["*"],
 *   )
 *
 * With a wildcard origin set, FastAPI echoes `Access-Control-Allow-Origin: *`,
 * adds `Vary: Origin`, and answers preflights with 200 / `text/plain` "OK".
 */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");

  const requestedMethod = req.headers["access-control-request-method"];

  if (req.method === "OPTIONS" && requestedMethod !== undefined) {
    res.setHeader(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
    );
    res.setHeader("Access-Control-Allow-Methods", ALL_METHODS);
    res.setHeader("Access-Control-Max-Age", PREFLIGHT_MAX_AGE);

    const requestedHeaders = req.headers["access-control-request-headers"];
    if (requestedHeaders !== undefined) {
      res.setHeader("Access-Control-Allow-Headers", requestedHeaders);
    }

    res.status(200).type("text/plain").send("OK");
    return;
  }

  next();
}

/**
 * Builds the Express application without binding a port.
 * Tests mount this directly; `index.ts` owns `listen()`.
 *
 * `deps` exists for tests: an integration suite binds the router to its own
 * connection pool and its own auth config instead of the process-wide
 * singletons. Production passes nothing and gets the defaults.
 */
export function createApp(deps?: StacksRouterDependencies): Express {
  const app = express();

  app.use(cors);

  // `strict: false` because FastAPI's body parsing is not strict about the JSON
  // *top-level* value. Measured on the oracle:
  //
  //   POST /stacks  body `null`  -> 422 model_attributes_type, input null
  //   POST /stacks  body `5`     -> 422 model_attributes_type, input 5
  //   POST /stacks  body `[]`    -> 422 model_attributes_type, input []
  //
  // body-parser's default (`strict: true`) only accepts an array or an object at
  // the top level and rejects the rest as malformed JSON, which would answer 400
  // instead of letting the DTO report Pydantic's 422. With `strict: false` every
  // JSON value reaches the schema, and `StackCreate` / `StackUpdate` reject the
  // non-objects with exactly the error the oracle emits.
  //
  // Known divergence, not addressed here: genuinely malformed JSON (`{bad`)
  // still answers body-parser's 400, while the oracle answers 422 with
  // `type: "json_invalid"` and Python's own decoder message. Reproducing that
  // message per malformed input is a separate concern from these routes.
  app.use(express.json({ strict: false }));

  // Liveness probe. No auth, and the body mirrors the Python oracle
  // byte-for-byte (field names, values, and order are contractual).
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "aks-reference-server",
      version: "0.2.0",
    });
  });

  // Routers, mirroring `app.include_router(...)` in app/main.py. Each one owns
  // its own auth (`dependencies=[Depends(require_api_key)]` in Python), so
  // nothing is authenticated globally and `/health` above stays open.
  app.use("/stacks", createStacksRouter(deps));

  // 404 fallback: JSON, never Express 5's default HTML page. FastAPI's shape
  // for unmatched routes is `{"detail": "Not Found"}`.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ detail: "Not Found" });
  });

  // Final error handler. The four-argument signature is what marks this as an
  // Express error handler, so `next` must stay declared even though unused.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : 500;

    // Client errors (e.g. malformed JSON from express.json()) carry a safe,
    // caller-relevant message; 5xx stays opaque so internals never leak.
    const detail =
      status >= 400 && status < 500 && err instanceof Error
        ? err.message
        : "Internal Server Error";

    res.status(status).json({ detail });
  });

  return app;
}
