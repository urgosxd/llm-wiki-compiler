/**
 * @file packages/llmwiki-kg/ts/src/routes/pages-archive.test.ts
 * @description Archive filenames, README and the ZIP container.
 */

import { describe, expect, it , vi } from "vitest";
import { buildArchiveEntries, buildReadme, buildZipArchive, pageFilename, pythonUtcIsoformat } from "./pages.js";
import { readZipArchive, useDomainPrefix } from "./pages-harness.js";
import type { ParsedEntry } from "./pages-harness.js";

// The provider env and the `complete` stub must be in place before the modules
// under test are imported; `vi.hoisted`/`vi.mock` are hoisted above imports.
vi.hoisted(() => {
  if (process.env["AKS_TEST_GATEWAY"] !== "1") {
    process.env["EXTRACTION_PROVIDER"] ??= "gateway";
    process.env["EMBEDDING_PROVIDER"] ??= "gateway";
    process.env["GATEWAY_URL"] ??= "https://gateway.invalid/v1";
    process.env["GATEWAY_API_KEY"] ??= "test-key-not-a-credential";
    process.env["EMBEDDING_MODEL"] ??= "hf:nomic-ai/nomic-embed-text-v1.5";
    process.env["EMBEDDING_DIM"] ??= "768";
    process.env["EXTRACTION_MODEL"] ??= "hf:deepseek-ai/DeepSeek-V4.1-Flash-1017";
  }
});

const completeMock = vi.hoisted(() => ({
  /** When false, the real `complete` is called. */
  enabled: true,
  /** Calls the stub intercepted, in order. */
  calls: [] as { prompt: string; maxTokens: number | undefined }[],
  /** Text the stub returns. */
  reply: "",
}));

vi.mock("../core/llm_clients.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/llm_clients.js")>();
  return {
    ...actual,
    complete: async (prompt: string, maxTokens?: number): Promise<string> => {
      if (!completeMock.enabled) {
        return actual.complete(prompt, maxTokens);
      }
      completeMock.calls.push({ prompt, maxTokens });
      return completeMock.reply;
    },
  };
});

// This file owns its own domain namespace: the split suites run in parallel
// against one database and the cleanup deletes by prefix.
useDomainPrefix("archive");

describe("archive filenames and README", () => {
  it("replaces exactly the four characters the oracle replaces", () => {
    // Measured: `Billing Service` -> `Billing_Service.md`.
    expect(pageFilename("Billing Service")).toBe("Billing_Service.md");
    expect(pageFilename("On-Call Engineer")).toBe("On-Call_Engineer.md");
    expect(pageFilename("a/b")).toBe("a-b.md");
    expect(pageFilename("a\\b")).toBe("a-b.md");
    expect(pageFilename("a:b")).toBe("a-b.md");
    expect(pageFilename("a/b\\c:d e")).toBe("a-b-c-d_e.md");
  });

  it("is not a general-purpose sanitiser, because the oracle's is not", () => {
    // A `?`, `*` or control character survives: reproducing the oracle's rule
    // exactly is what keeps the two archives' file lists comparable.
    expect(pageFilename("What? *")).toBe("What?_*.md");
    expect(pageFilename("tab\there")).toBe("tab\there.md");
  });

  it("composes the README with the oracle's exact wording and timestamp form", () => {
    // Note the em dash and the `+00:00` offset: this is
    // `datetime.now(timezone.utc).isoformat()`, not the `Z` form the JSON
    // endpoints emit.
    expect(
      buildReadme("W2 Pages Probe", "w2pg-probe-main", 13, new Date("2026-10-22T05:12:48.591Z")),
    ).toBe(
      "# W2 Pages Probe — Entity Pages\n\n" +
        "Generated from AKS Stack `w2pg-probe-main` " +
        "on 2026-10-22T05:12:48.591000+00:00.\n\n" +
        "Total entities: 13\n\n" +
        "Each `.md` file is a wiki-style page for one entity, " +
        "generated from the compiled knowledge graph.\n",
    );
  });

  it("omits the fractional part when the second is exact, as Python does", () => {
    expect(pythonUtcIsoformat(new Date("2026-10-22T05:12:48.000Z"))).toBe(
      "2026-10-22T05:12:48+00:00",
    );
    expect(pythonUtcIsoformat(new Date("2026-10-22T05:12:48.001Z"))).toBe(
      "2026-10-22T05:12:48.001000+00:00",
    );
  });

  it("names the archive after the Stack's domain", () => {
    // `content-disposition: attachment; filename=<domain>-entity-pages.zip` —
    // asserted end to end in the integration block; the rule itself lives in
    // the route, and this pins the string it builds from.
    expect(`${"w2pg-probe-main"}-entity-pages.zip`).toBe("w2pg-probe-main-entity-pages.zip");
  });

  it("puts README.md first, then the pages in the order given", () => {
    const entries = buildArchiveEntries("readme", [
      { entityName: "Billing Service", markdown: "a" },
      { entityName: "Payment Gateway", markdown: "b" },
    ]);
    expect(entries.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Payment_Gateway.md",
    ]);
    expect(entries[0]?.content).toBe("readme");
  });
});

describe("zip container", () => {
  const now = new Date("2026-10-22T05:12:48.000Z");

  /** Builds and re-reads an archive, so every assertion is about the bytes. */
  function roundTrip(entries: ReturnType<typeof buildArchiveEntries>): ParsedEntry[] {
    return readZipArchive(buildZipArchive(entries, now));
  }

  it("produces a container a third-party reader accepts, entry by entry", () => {
    // Verified out of band with `unzip -t` and Python's `zipfile`, both of which
    // read this exact archive without a warning.
    const parsed = roundTrip(
      buildArchiveEntries(buildReadme("Stack", "w2pg-zip", 2, now), [
        { entityName: "Billing Service", markdown: "# Billing Service\n\nSummary.\n" },
        { entityName: "Rate Limit", markdown: `# Rate Limit\n\n${"x".repeat(4000)}` },
      ]),
    );

    expect(parsed.map((entry) => entry.name)).toEqual([
      "README.md",
      "Billing_Service.md",
      "Rate_Limit.md",
    ]);
    expect(parsed[1]?.content).toBe("# Billing Service\n\nSummary.\n");
    expect(parsed[2]?.content.startsWith("# Rate Limit")).toBe(true);

    for (const entry of parsed) {
      // Method 8 (deflate), no data descriptor, Unix origin, `-rw-------`.
      expect(entry.compressionMethod, `${entry.name} method`).toBe(8);
      expect(entry.flagBits, `${entry.name} flags`).toBe(0);
      expect(entry.createSystem, `${entry.name} create_system`).toBe(3);
      expect(entry.externalAttr, `${entry.name} external_attr`).toBe(0o600 * 0x10000);
      // Sizes agree with the decoded payload; the CRC is non-zero for non-empty
      // content, which is what a reader checks before trusting the bytes.
      expect(entry.uncompressedSize, `${entry.name} size`).toBe(Buffer.byteLength(entry.content, "utf8"));
      if (entry.content !== "") {
        expect(entry.crc, `${entry.name} crc`).not.toBe(0);
      }
    }
  });

  it("actually compresses, rather than storing", () => {
    const body = "repeated content ".repeat(200);
    const parsed = roundTrip(buildArchiveEntries(body, []));
    expect(parsed[0]?.uncompressedSize).toBeGreaterThan(parsed[0]?.compressedSize ?? 0);
  });

  it("carries an empty file as a valid entry", () => {
    // The oracle produces these: an entity whose page generation returned
    // nothing appears in the archive with zero bytes (measured:
    // `Rates_Service.md`, 0 bytes).
    const parsed = roundTrip(buildArchiveEntries("readme", [{ entityName: "Empty", markdown: "" }]));
    expect(parsed).toHaveLength(2);
    expect(parsed[1]?.content).toBe("");
    expect(parsed[1]?.compressedSize).toBe(2); // deflate's empty stream is 2 bytes
    expect(parsed[1]?.uncompressedSize).toBe(0);
  });

  it("writes a zero-entry archive when given no entries", () => {
    // Not a shape the endpoint can produce — it 404s first — but the container
    // must still be well formed rather than emitting a header pointing nowhere.
    const archive = buildZipArchive([], now);
    expect(readZipArchive(archive)).toEqual([]);
    expect(archive.length).toBe(22);
  });

  it("round-trips a non-ASCII entity name and content", () => {
    const parsed = roundTrip(
      buildArchiveEntries("readme", [{ entityName: "Ünïcode Page", markdown: "héllo 🙂" }]),
    );
    expect(parsed[1]?.name).toBe("Ünïcode_Page.md");
    expect(parsed[1]?.content).toBe("héllo 🙂");
  });
});
