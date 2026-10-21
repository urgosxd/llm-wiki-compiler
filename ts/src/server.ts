import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

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
 */
export function createApp(): Express {
  const app = express();

  app.use(cors);
  app.use(express.json());

  // Liveness probe. No auth, and the body mirrors the Python oracle
  // byte-for-byte (field names, values, and order are contractual).
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "aks-reference-server",
      version: "0.2.0",
    });
  });

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
