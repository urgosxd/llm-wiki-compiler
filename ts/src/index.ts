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
      "",
    ].join("\n"),
  );
});

server.on("error", (error: Error) => {
  console.error(`[AKS] Failed to listen on ${HOST}:${port}: ${error.message}`);
  process.exit(1);
});
