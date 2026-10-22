import { config, validateConfig } from "./config.js";
import { createApp } from "./server.js";

const DEFAULT_PORT = 8000;
const HOST = "0.0.0.0";

function resolvePort(): number {
  const raw = process.env["PORT"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(`[AKS] Invalid PORT="${raw}" — expected an integer in 1-65535.`);
    process.exit(1);
  }

  return parsed;
}

const port = resolvePort();

// Fail fast on provider misconfiguration, mirroring the Python server's
// lifespan startup hook (app/main.py). The oracle raises before it accepts
// any request, so a bad config never serves traffic; we match that by
// validating before the socket is even bound.
try {
  validateConfig(config);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[AKS] Configuration error: ${message}`);
  process.exit(1);
}

const app = createApp();

const server = app.listen(port, HOST, () => {
  console.log(
    [
      "",
      "  AKS Reference Server (TypeScript)",
      "  ---------------------------------",
      `  Listening:  http://${HOST}:${port}`,
      `  Health:     http://localhost:${port}/health`,
      `  Mode:       ${process.env["NODE_ENV"] ?? "development"}`,
      `  Inference:  extraction via ${config.EXTRACTION_PROVIDER} (${config.EXTRACTION_MODEL}),` +
        ` embeddings via ${config.EMBEDDING_PROVIDER} (${config.EMBEDDING_MODEL})`,
      `  Auth:       ${config.authEnabled ? "enabled (X-API-Key required)" : "disabled (open access)"}`,
      "",
    ].join("\n"),
  );
});

server.on("error", (error: Error) => {
  console.error(`[AKS] Failed to listen on ${HOST}:${port}: ${error.message}`);
  process.exit(1);
});
