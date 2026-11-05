/**
 * @file test/kg-mcp-e2e/counting-proxy.ts
 * @description An observer that sits between the MCP server and the real KG API.
 *
 * ## Why a proxy and not a stub
 *
 * "Zero downstream requests on a refusal" is only measurable if SOMETHING counts
 * the requests. A `fetchImpl` stub could count, but then the non-refused calls
 * would answer from the stub and the probe would prove a mock. So the counter goes
 * where it cannot change the answer: a transparent HTTP proxy that forwards every
 * request to the real API and records what it forwarded. `AKS_BASE_URL` points at
 * this process, the real API sits behind it, and the MCP server cannot tell the
 * difference — which is exactly why the zero it reports is believable.
 *
 * A request that is refused before the HTTP call never arrives here at all, so the
 * counter stays still; a request that is made arrives exactly once.
 */

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the proxy forwarded, as it forwarded it. */
export interface ProxiedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** The proxy: where to point the client, what it saw, and how to stop it. */
export interface CountingProxy {
  /** Base URL the MCP server must be configured with. */
  readonly baseUrl: string;
  /** Every request forwarded so far, in order. */
  readonly requests: () => readonly ProxiedRequest[];
  /** Forwarded requests matching a method and a path prefix. */
  readonly count: (method: string, pathPrefix?: string) => number;
  /** Stop listening. Best effort, safe to call twice. */
  stop: () => Promise<void>;
}

/** The whole request body, as text. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/** The request as the upstream must see it: method, headers, body — nothing added. */
interface Forwarded {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * Send one request to the real API and return its answer verbatim.
 *
 * Never reinterprets a status: a 500 from the API stays a 500 here, so a probe that
 * asserts an answer is asserting the API's, not this proxy's.
 */
async function forward(
  target: string,
  request: ProxiedRequest,
  contentType: string | undefined,
): Promise<Forwarded> {
  const headers: Record<string, string> = {};
  if (contentType !== undefined) headers["content-type"] = contentType;
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body !== "";
  const response = await fetch(`${target}${request.path}`, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body } : {}),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json",
    body: await response.text(),
  };
}

/**
 * Start the counting proxy in front of `target`.
 *
 * @param target - Base URL of the real KG API.
 * @returns The proxy; `stop()` closes the listener.
 */
export async function startCountingProxy(target: string): Promise<CountingProxy> {
  const seen: ProxiedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const request: ProxiedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        body: await readBody(req),
      };
      seen.push(request);
      try {
        const answer = await forward(target, request, req.headers["content-type"]);
        res.writeHead(answer.status, { "content-type": answer.contentType });
        res.end(answer.body);
      } catch (error) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`probe proxy could not reach ${target}: ${(error as Error).message}`);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests: () => [...seen],
    count: (method, pathPrefix = "") =>
      seen.filter((entry) => entry.method === method && entry.path.startsWith(pathPrefix)).length,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
