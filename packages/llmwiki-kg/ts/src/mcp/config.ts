/**
 * @file packages/llmwiki-kg/ts/src/mcp/config.ts
 * @description Where the MCP client sends its requests, and how it authenticates.
 */

// ============================================================
// Configuration
// ============================================================

/** `os.getenv("AKS_BASE_URL", "http://localhost:8000")`, read once at load. */
export const AKS_BASE_URL = process.env["AKS_BASE_URL"] ?? "http://localhost:8000";

/** `os.getenv("AKS_API_KEY", "").strip()`. */
export const AKS_API_KEY = (process.env["AKS_API_KEY"] ?? "").trim();

/**
 * Build auth headers if an API key is configured.
 *
 * Mirrors `_auth_headers()`: the header is absent entirely when no key is set,
 * rather than present and empty. An empty `X-API-Key` is not the same request
 * as no `X-API-Key` for a server that treats "" as a configured-but-wrong key.
 */
export function authHeaders(apiKey: string = AKS_API_KEY): Record<string, string> {
  return apiKey ? { "X-API-Key": apiKey } : {};
}
