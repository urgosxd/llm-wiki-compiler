/**
 * @file test/embedding-space-mismatch-message.test.ts
 * @description WHAT AN OPERATOR SEES when the stored header carries a value this
 * build must not print.
 *
 * The refusal prints model ids and dimension counts on purpose: they are
 * configuration, and an operator cannot act on a mismatch that does not name both
 * sides. It also withholds anything whose shape says it is not that kind of value,
 * because a store header can be hand-edited and an endpoint routinely carries a
 * credential as userinfo. Withholding alone is not enough: the message must also
 * say WHICH situation it is in, or "withheld" reads as "nothing was recorded" --
 * a false statement about a row that does hold something.
 *
 * Two values are guarded here, and they fail differently:
 *
 *  - the FINGERPRINT: a 64-hex digest may be shortened and shown (it is opaque and
 *    nothing reads it back), while any other shape is withheld entirely, because a
 *    non-digest fingerprint written by another build may embed a URL;
 *  - the MODEL ID: printed only when it has the shape of a model id, since
 *    `store.model` reaches the message verbatim and a hand-edited row could put an
 *    arbitrary string -- a URL, a connection string -- into an operator's logs.
 *
 * The fixtures use `.invalid` hosts (RFC 6761) and obviously fake credentials, and
 * every case asserts the ABSENCE of each part of the unprintable value, not merely
 * the presence of the marker: a marker that appeared beside a leaked host would pass
 * a presence-only check.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  embeddingSpaceMismatch,
  resolveEmbeddingModel,
} from "../packages/wiki/src/utils/embeddings-store.js";
import { createEnvSnapshot } from "./fixtures/env-snapshot.js";

const { setEnv, restore } = createEnvSnapshot([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_EMBEDDING_PROVIDER",
  "LLMWIKI_EMBEDDING_MODEL",
  "OPENAI_BASE_URL",
  "OPENAI_EMBEDDINGS_BASE_URL",
  "OLLAMA_HOST",
  "OLLAMA_EMBEDDINGS_HOST",
]);

afterEach(() => {
  restore();
});

/** The model the active configuration resolves to in every case below. */
const ACTIVE_MODEL = "active-space-probe";
/** Width the stored vectors really have. */
const DIMENSIONS = 768;
/** A host that can never resolve, so a leaked value cannot reach anything. */
const HOST = "embedding-host.invalid";
/** Userinfo credentials no case may ever print. */
const USER = "operator";
/** The credential inside the unprintable URL; asserted absent, never echoed. */
const TOKEN = "not-a-real-token";
/** A fingerprint that is NOT a digest: it is a URL carrying userinfo. */
const UNPRINTABLE_FINGERPRINT = `https://${USER}:${TOKEN}@${HOST}/v1`;
/** A well-formed fingerprint: opaque, and safe to shorten for display. */
const PRINTABLE_FINGERPRINT = "b".repeat(64);
/** The endpoint override that makes a fingerprint-less store disagree. */
const ENDPOINT_OVERRIDE = `https://${HOST}/openai/v1`;
/** A model id in the shape this build will print. */
const SHAPED_MODEL = "hf:nomic-ai/nomic-embed-text-v1.5";
/** The marker that stands in for a recorded model id this build will not print. */
const WITHHELD_MODEL = "(withheld: not a model id)";

/**
 * The refusal message for the header `overrides` describes on top of the active space.
 *
 * @param overrides - Header fields under test.
 * @param env - Extra environment; an endpoint override is what makes a store that
 *   records no fingerprint disagree with the active configuration at all.
 * @returns The operator-facing message.
 */
function messageFor(overrides: Record<string, unknown>, env: Record<string, string> = {}): string {
  setEnv({ LLMWIKI_PROVIDER: "openai", LLMWIKI_EMBEDDING_MODEL: ACTIVE_MODEL, ...env });
  const refusal = embeddingSpaceMismatch({
    model: resolveEmbeddingModel(),
    dimensions: DIMENSIONS,
    ...overrides,
  });
  if (refusal === null) throw new Error("expected a refusal for the header under test");
  return refusal.message;
}

/** Every part of the unprintable URL that must never appear in a message. */
const UNPRINTABLE_PARTS: readonly string[] = [
  HOST,
  TOKEN,
  USER,
  "https://",
  UNPRINTABLE_FINGERPRINT.slice(0, 12),
];

describe("an unprintable fingerprint is withheld, and the message says so", () => {
  it("prints neither the host nor the credential inside the recorded fingerprint", () => {
    const message = messageFor({ fingerprint: UNPRINTABLE_FINGERPRINT });

    for (const part of UNPRINTABLE_PARTS) {
      expect(message, `the message leaked ${part}`).not.toContain(part);
    }
    // Withheld, not silently dropped: the operator is told a fingerprint exists.
    expect(message).toContain("fingerprint");
    expect(message).not.toContain("records no fingerprint");
  });

  it("words 'recorded but unprintable' differently from 'genuinely absent'", () => {
    // A fingerprint-less store only disagrees once an endpoint override makes the
    // bare model name untrustworthy, which is the documented path for that header.
    const absent = messageFor({}, { OPENAI_EMBEDDINGS_BASE_URL: ENDPOINT_OVERRIDE });
    const unprintable = messageFor({ fingerprint: UNPRINTABLE_FINGERPRINT });

    // Two different facts, so two different sentences: "nothing was recorded" about
    // a row that DOES hold a value is a false statement in a diagnostic.
    expect(unprintable).not.toBe(absent);
    expect(absent).toContain("records no fingerprint of its own");
    expect(unprintable).not.toContain("records no fingerprint");
    // The absent case still refuses for the same reason and with the same remedy.
    expect(absent).toContain(ACTIVE_MODEL);
    expect(absent).toContain(`${DIMENSIONS} dimensions`);
    // ...and the override's own value is not printed either.
    expect(absent).not.toContain(HOST);
  });

  it("still shows a prefix when the fingerprint really is a digest", () => {
    // The printable path is unchanged: an opaque digest may be shortened for display.
    const message = messageFor({ fingerprint: PRINTABLE_FINGERPRINT });

    expect(message).toContain(PRINTABLE_FINGERPRINT.slice(0, 12));
    expect(message).not.toContain("records no fingerprint");
    expect(message).not.toContain("(not recorded)");
  });
});

describe("a recorded model id is printed only when it has a model id's shape", () => {
  it("withholds a model id that is a URL with userinfo, and prints no part of it", () => {
    const message = messageFor({
      model: `https://${USER}:${TOKEN}@${HOST}/v1`,
      fingerprint: PRINTABLE_FINGERPRINT,
    });

    for (const part of UNPRINTABLE_PARTS) {
      expect(message, `the message leaked ${part}`).not.toContain(part);
    }
    // The withheld side is still visible as a side, and the active side still names
    // what this build resolves, so the operator has something to act on.
    expect(message).toContain(WITHHELD_MODEL);
    expect(message).toContain(`"${ACTIVE_MODEL}"`);
    expect(message).toContain(`${DIMENSIONS} dimensions`);
  });

  it("still prints a model id of the shape every deployment records", () => {
    // The guard must not withhold the real thing: a HuggingFace-style id, a vendor
    // id and an Ollama tag are all model ids and all stay printable.
    for (const model of [SHAPED_MODEL, "text-embedding-3-small", "qwen2.5:7b"]) {
      const message = messageFor({ model, fingerprint: PRINTABLE_FINGERPRINT });

      expect(message).toContain(`"${model}"`);
      expect(message).not.toContain(WITHHELD_MODEL);
    }
  });
});
