/**
 * @file packages/llmwiki-kg/ts/src/core/jev/redact.ts
 * @description The one place a credential is stripped out of text this package is
 * about to report, store or return.
 *
 * ## Why a helper, and not care at each call site
 *
 * `TYPESAFE_API_KEY` is billable, and three of the four things this adapter puts in
 * an error are values it does not author: the vendor's own error body, the text of a
 * transport exception, and the configured base URL. Any of them can contain the
 * credential — a vendor that quotes the refused `Authorization` header back, a proxy
 * that echoes the request it could not forward, an operator who pasted the key into
 * `LLMWIKI_JEV_BASE_URL`. Each of those reaches {@link JevFailed.reason}, and `reason`
 * is not a log line: the pipeline PERSISTS it in `kg_classification_log.reason` and on
 * the row's classification reason, and the document endpoint returns the audit blob.
 * One forgetting call site is therefore a stored and published secret.
 *
 * So redaction is a function here and every message goes through it, including the
 * messages that already look safe. Defence in depth is cheaper than an audit.
 *
 * ## Two layers, because either alone is insufficient
 *
 * - **By value**: every configured secret is replaced wherever it appears, in its raw
 *   form and its URL-encoded form.
 * - **By shape**: any `Bearer <token>` or `authorization: <value>` sequence is
 *   replaced even when the caller has no secret to compare against. A header value
 *   that leaked out of a transport error is still a credential.
 *
 * The merged result is deliberately lossy: an over-redacted message is readable, an
 * under-redacted one is a disclosure.
 */

/** What every redacted span is replaced with. */
export const REDACTED = "[REDACTED]";

/** A `Bearer <token>` sequence, which is a credential whatever its value. */
const BEARER_TOKEN = /(bearer\s+)[^\s"',;}]+/gi;

/** An authorization or api-key header rendered as `name: value` or `"name": "value"`. */
const CREDENTIAL_HEADER =
  /((?:authorization|api[-_]?key|x-api[-_]?key)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi;

/** An environment name that holds a credential. Matched on the trailing segment. */
const CREDENTIAL_NAME = /(?:^|_)(?:API_KEY|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)$/i;

/** A header name whose value is a credential. */
const CREDENTIAL_HEADER_NAME = /^(?:authorization|api[-_]?key|x-api[-_]?key)$/i;

/** The `Bearer ` prefix, so the token itself can be extracted. */
const BEARER_PREFIX = /^bearer\s+/i;

/**
 * Replaces credential-shaped sequences and every supplied secret value.
 *
 * Blank secrets are ignored rather than matched: an empty needle would replace
 * between every character of the message.
 *
 * @param text - The message, descriptor or body to sanitize.
 * @param secrets - Configured values that must never survive.
 * @returns The sanitized text.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let sanitized = text.replace(BEARER_TOKEN, `$1${REDACTED}`);
  sanitized = sanitized.replace(CREDENTIAL_HEADER, `$1${REDACTED}`);
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed === "") continue;
    sanitized = sanitized.split(trimmed).join(REDACTED);
    const encoded = encodeURIComponent(trimmed);
    if (encoded !== trimmed) {
      sanitized = sanitized.split(encoded).join(REDACTED);
    }
  }
  return sanitized;
}

/**
 * Every credential-shaped value an environment holds.
 *
 * The vendor credential is the one that matters today, but the same leak applies to
 * any provider key an operator configures beside it, and enumerating them by name
 * would let a newly added variable through.
 *
 * @param env - The environment to read.
 * @returns The non-blank values whose variable name ends in a credential segment.
 */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed === "" || !CREDENTIAL_NAME.test(name)) continue;
    found.push(trimmed);
  }
  return found;
}

/**
 * Sanitizes a message against every credential the environment holds.
 *
 * Used by the configuration parser, which is the first code that runs for a bad
 * deployment and the last that a caller reads before anything is stored.
 *
 * @param text - The message to sanitize.
 * @param env - The environment those values came from.
 * @returns The sanitized text.
 */
export function redactEnvSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return redactSecrets(text, envSecrets(env));
}

/** One outbound request as it may be surfaced in a message or a diagnostic. */
export interface RequestDescriptor {
  /** HTTP method. */
  readonly method: string;
  /** Request URL, credential redacted. */
  readonly url: string;
  /** Request headers, credential headers redacted. */
  readonly headers: Readonly<Record<string, string>>;
}

/** True when this header carries a credential rather than ordinary metadata. */
function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADER_NAME.test(name);
}

/** The token inside a `Bearer <token>` value, or the value itself when bare. */
function credentialValue(value: string): string {
  const trimmed = value.trim();
  return BEARER_PREFIX.test(trimmed) ? trimmed.replace(BEARER_PREFIX, "") : trimmed;
}

/**
 * Sanitizes a whole request descriptor so it can be stringified anywhere.
 *
 * A descriptor is the most useful thing to report when a request fails, and the most
 * dangerous: it carries the `authorization` header verbatim. Credential headers are
 * replaced outright, their values are stripped from the URL as well, and the result
 * is a plain object, so `JSON.stringify` on it cannot disclose anything.
 *
 * @param descriptor - The request as it would be sent.
 * @returns The same descriptor with every credential replaced.
 */
export function redactRequestDescriptor(descriptor: RequestDescriptor): RequestDescriptor {
  const leaked: string[] = [];
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(descriptor.headers)) {
    if (!isCredentialHeader(name)) {
      headers[name] = redactSecrets(value, []);
      continue;
    }
    leaked.push(credentialValue(value));
    headers[name] = REDACTED;
  }
  return {
    method: descriptor.method,
    url: redactSecrets(descriptor.url, leaked),
    headers,
  };
}
