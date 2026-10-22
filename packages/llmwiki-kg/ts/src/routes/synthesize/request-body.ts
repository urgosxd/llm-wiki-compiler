/**
 * @file packages/llmwiki-kg/ts/src/routes/synthesize/request-body.ts
 * @description Reading the request body the way Starlette hands it to Pydantic.
 *
 * Split out of `routes/synthesize.ts` as its own unit because the
 * "was there a body at all" question (`content-length: 0`) and the raw-text case
 * are Starlette behaviours, and only the backfill endpoint needs them.
 */

import type { Request } from "express";

// ---------------------------------------------------------------------------
// Request body, read the way Starlette reads it
// ---------------------------------------------------------------------------

/** What the body contributes before validation. */
export type RawBody =
  /** No body was sent: Pydantic reports `missing` for the whole body. */
  | { readonly kind: "absent" }
  /** A body arrived but no JSON parser claimed it: the raw text is the value. */
  | { readonly kind: "text"; readonly text: string }
  /** `express.json` parsed it: this is the JSON value to validate. */
  | { readonly kind: "json"; readonly value: unknown };

/**
 * Reads the request body as Starlette would hand it to a Pydantic model.
 *
 * Express's `body-parser` already consumed the JSON case (it parses an
 * `application/json` body only when the request has one), so `req.body !==
 * undefined` means "a JSON value was parsed". Everything else — a `text/plain`
 * body, no declared content type — is left unread on the stream and is read here,
 * because Python passes that text through as the body value.
 *
 * `content-length: 0` on a JSON request is body-parser's "empty json body" special
 * case: it yields `{}` — indistinguishable from a literal `{}` — so the header is
 * what separates the two. A zero-length **chunked** JSON body would still be read
 * as `{}` here where the oracle reports `missing`; clients do not send that and
 * the harness cannot construct it, so the divergence is documented rather than
 * guessed at.
 */
export async function readRequestBody(req: Request): Promise<RawBody> {
  const parsed: unknown = req.body;

  if (parsed !== undefined) {
    const contentLength = req.headers["content-length"];
    if (contentLength === "0") {
      return { kind: "absent" };
    }
    return { kind: "json", value: parsed };
  }

  if (req.readableEnded) {
    return { kind: "absent" };
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? { kind: "absent" } : { kind: "text", text };
}

