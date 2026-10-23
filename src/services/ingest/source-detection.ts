/**
 * @file src/services/ingest/source-detection.ts
 * @description Decide what KIND of thing a source string points at, so the
 * ingest service can route it to the right adapter.
 *
 * Extracted from `src/commands/ingest.ts` unchanged. The logic was never
 * command-specific — it reads a path or URL and returns a `SourceType` — but it
 * lived in the CLI module, which meant a second client (HTTP, MCP) had to import
 * the command to reuse it. Detection is the first step of every ingest, so it
 * belongs to the service that owns the transaction, not to one of its transports.
 *
 * `.txt` is the only ambiguous extension, and it is resolved by CONTENT rather
 * than by name: a plain-text export may be a transcript or a document, and
 * routing it wrongly changes which adapter parses it.
 */

import path from "path";
import { readFile } from "fs/promises";
import { IMAGE_EXTENSIONS, TRANSCRIPT_EXTENSIONS } from "../../utils/constants.js";
import { isYoutubeUrl } from "../../ingest/transcript.js";
import type { SourceType } from "../../utils/types.js";

/** Check whether a source string looks like a URL. */
function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

/** Number of bytes to peek at when sniffing .txt content for transcript signals. */
const TXT_SNIFF_BYTES = 2048;

/**
 * Regex for a speaker-tag line: captures the speaker name before the colon.
 * Allows names up to ~40 chars with letters, spaces, dots, apostrophes, hyphens.
 * The `gm` flags let us find ALL occurrences in the sample.
 */
const SPEAKER_TAG_PATTERN = /^([A-Z][a-zA-Z .'-]{0,40}):\s/gm;

/**
 * Regex for a bare timestamp at the start of a line (allowing leading
 * whitespace): "H:MM", "HH:MM", or "HH:MM:SS". Anchored to line starts so
 * incidental times in prose (e.g. "the meeting at 3:00 was productive")
 * don't trip the transcript heuristic.
 */
const TIMESTAMP_PATTERN = /^\s*\d{1,2}:\d{2}(:\d{2})?/;

/** Minimum number of timestamp-like matches to treat a file as a transcript. */
const MIN_TIMESTAMP_MATCHES = 3;

/**
 * Minimum number of times a single speaker name must appear to signal dialogue
 * (rules out one-off section headers like "Summary:" that appear only once).
 */
const MIN_SPEAKER_REPEAT_COUNT = 2;

/**
 * Minimum number of distinct speaker names required alongside the repeat
 * condition (rules out single-speaker monologues).
 */
const MIN_DISTINCT_SPEAKERS = 2;

/**
 * Count how many times each speaker name appears in the collected tag matches.
 * Returns a Map from name → occurrence count.
 */
function countSpeakerOccurrences(sample: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Reset lastIndex since SPEAKER_TAG_PATTERN has the `g` flag.
  SPEAKER_TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPEAKER_TAG_PATTERN.exec(sample)) !== null) {
    const name = match[1].trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Decide whether speaker-tag occurrences in a sample look like dialogue.
 *
 * A file passes when both of the following are true:
 *  - At least {@link MIN_DISTINCT_SPEAKERS} distinct speaker names appear.
 *  - At least one name appears {@link MIN_SPEAKER_REPEAT_COUNT}+ times,
 *    indicating back-and-forth turns rather than a list of section headers
 *    (e.g. "Summary: …", "Details: …") where every label is unique.
 */
function hasSpeakerDialoguePattern(sample: string): boolean {
  const counts = countSpeakerOccurrences(sample);

  const distinctSpeakers = counts.size;
  const hasEnoughSpeakers = distinctSpeakers >= MIN_DISTINCT_SPEAKERS;

  const hasRepeatedSpeaker = [...counts.values()].some(
    (n) => n >= MIN_SPEAKER_REPEAT_COUNT,
  );

  return hasEnoughSpeakers && hasRepeatedSpeaker;
}

/**
 * Peek at the first {@link TXT_SNIFF_BYTES} of a plain-text file and decide
 * whether it looks like a conversation transcript.
 *
 * Heuristic: at least one of the following must be true in the sampled content:
 *
 *  1. **Speaker-tag dialogue pattern** — lines of the form "Name: …" where:
 *     - At least {@link MIN_DISTINCT_SPEAKERS} distinct names appear, AND
 *     - At least one name appears {@link MIN_SPEAKER_REPEAT_COUNT}+ times.
 *     This rejects lone section headers ("Summary: …") and lists of unique
 *     labels ("Summary:", "Details:", "Notes:") that have no repetition, while
 *     accepting real back-and-forth dialogue ("Alice: …\nBob: …\nAlice: …").
 *
 *  2. **Timestamp density** — three or more bare timestamp patterns (e.g.
 *     "01:23" / "1:23:45"), the signature of time-coded scripts or subtitles.
 *
 * When neither signal fires the caller routes the file as a generic text file.
 *
 * @param filePath - Absolute or relative path to the .txt file.
 * @returns `true` when transcript signals are detected, `false` otherwise.
 */
async function looksLikeTxtTranscript(filePath: string): Promise<boolean> {
  const raw = await readFile(filePath, "utf-8");
  const sample = raw.slice(0, TXT_SNIFF_BYTES);

  if (hasSpeakerDialoguePattern(sample)) return true;

  const timestampMatches = sample.match(new RegExp(TIMESTAMP_PATTERN.source, "gm"));
  return (timestampMatches?.length ?? 0) >= MIN_TIMESTAMP_MATCHES;
}

/**
 * Determine the source type for a given source string.
 *
 * For `.txt` files, content-sniffing is used instead of a pure extension check.
 * The file's first {@link TXT_SNIFF_BYTES} bytes are inspected for transcript
 * signals (speaker-tag lines or repeated timestamps). Only when both heuristics
 * fail is the file routed to the generic `file` adapter. `.vtt` and `.srt` are
 * always treated as transcripts regardless of content.
 *
 * @param source - A URL, local file path, or image path.
 * @returns The detected SourceType.
 */
export async function detectSourceType(source: string): Promise<SourceType> {
  if (!isUrl(source)) {
    const ext = path.extname(source).toLowerCase();
    if (ext === ".pdf") return "pdf";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    if (TRANSCRIPT_EXTENSIONS.has(ext)) return "transcript";
    if (ext === ".txt") {
      const isTranscript = await looksLikeTxtTranscript(source);
      return isTranscript ? "transcript" : "file";
    }
    return "file";
  }

  if (isYoutubeUrl(source)) return "transcript";
  return "web";
}
