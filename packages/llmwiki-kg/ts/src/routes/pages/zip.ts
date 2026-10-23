/**
 * @file packages/llmwiki-kg/ts/src/routes/pages/zip.ts
 * @description A deflated ZIP container written by hand.
 *
 * Split out of `routes/pages.ts` as its own unit because the byte layout of the
 * local header, central directory and end record has nothing to do with the HTTP
 * or graph concerns around it, and every offset in it is load-bearing.
 */

import { crc32, deflateRawSync } from "node:zlib";

import type { ArchiveEntry } from "./archive.js";

// ZIP container
// ---------------------------------------------------------------------------

/** Local file header signature, `PK\x03\x04`. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** Central directory header signature, `PK\x01\x02`. */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** End-of-central-directory signature, `PK\x05\x06`. */
const END_RECORD_SIGNATURE = 0x06054b50;

/** `ZIP_DEFLATED`. */
const COMPRESSION_DEFLATE = 8;
/** Zipfile format version 2.0, which every deflate entry requires. */
const ZIP_VERSION = 20;
/** `create_system = 3` — the archive declares Unix origin, as Python's does. */
const CREATE_SYSTEM_UNIX = 3;
/** `external_attr` for a `0o600` regular file, shifted into the high word. */
const EXTERNAL_ATTR_0600 = 0o600 * 0x10000;

/** Fixed on-disk sizes of the three record types, excluding variable fields. */
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

/**
 * Encodes a `Date` as the MS-DOS `(date, time)` pair a ZIP header carries.
 *
 * DOS timestamps have two-second resolution, a 1980 epoch and a 127-year range,
 * so both fields clamp rather than overflow. Local time is used because that is
 * what `zipfile.ZipInfo` defaults to (`time.localtime(os.stat(...)))`); the
 * archive's timestamps are therefore informative, not contractual.
 */
function dosDateTime(instant: Date): { readonly date: number; readonly time: number } {
  const year = Math.min(Math.max(instant.getFullYear(), 1980), 2107);

  // `<< 9` and `<< 5` pack five bits each; `>> 1` drops the odd second.
  const date = ((year - 1980) << 9) | ((instant.getMonth() + 1) << 5) | instant.getDate();
  const time =
    (instant.getHours() << 11) |
    (instant.getMinutes() << 5) |
    Math.floor(instant.getSeconds() / 2);

  return { date, time };
}

/** The one local header, central header and payload a single entry needs. */
interface EncodedEntry {
  readonly local: Buffer;
  readonly central: Buffer;
  readonly nameBytes: Buffer;
  readonly compressed: Buffer;
}

/** The MS-DOS date/time pair shared by every entry in one archive. */
interface DosStamp {
  readonly date: number;
  readonly time: number;
}

/**
 * Builds one entry's local header and central-directory record.
 *
 * There is no data descriptor: each entry's sizes and CRC are known before its
 * header is emitted, which is why `flag_bits` stays 0 and the central record can
 * carry `offset` directly.
 */
function encodeEntry(entry: ArchiveEntry, stamp: DosStamp, offset: number): EncodedEntry {
  const nameBytes = Buffer.from(entry.name, "utf8");
  const uncompressed = Buffer.from(entry.content, "utf8");
  const compressed = deflateRawSync(uncompressed);
  const checksum = crc32(uncompressed);

  const local = Buffer.alloc(LOCAL_HEADER_SIZE);
  local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  local.writeUInt16LE(ZIP_VERSION, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(COMPRESSION_DEFLATE, 8);
  local.writeUInt16LE(stamp.time, 10);
  local.writeUInt16LE(stamp.date, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(uncompressed.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(CENTRAL_HEADER_SIZE);
  central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  // Version made by: creator system in the high byte, version in the low byte.
  central.writeUInt16LE((CREATE_SYSTEM_UNIX << 8) | ZIP_VERSION, 4);
  central.writeUInt16LE(ZIP_VERSION, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(COMPRESSION_DEFLATE, 10);
  central.writeUInt16LE(stamp.time, 12);
  central.writeUInt16LE(stamp.date, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(uncompressed.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(EXTERNAL_ATTR_0600, 38);
  central.writeUInt32LE(offset, 42);

  return { local, central, nameBytes, compressed };
}

/** Builds the end-of-central-directory record that closes the archive. */
function endRecord(entryCount: number, centralSize: number, localSize: number): Buffer {
  const end = Buffer.alloc(END_RECORD_SIZE);
  end.writeUInt32LE(END_RECORD_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localSize, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

/**
 * Builds a ZIP archive from `entries`, deflated, the way
 * `zipfile.ZipFile(..., ZIP_DEFLATED)` would.
 *
 * Every byte offset is computed as the buffer is written, so the central
 * directory points at the real local headers and the end record points at the
 * real central directory. There is no data descriptor: each entry's sizes and
 * CRC are known before its header is emitted, which is why `flag_bits` stays 0.
 *
 * Entry names and contents are UTF-8. Python sets the UTF-8 flag (bit 11) only
 * for names it cannot represent in cp437; entity names are usually ASCII, and a
 * reader that honours the flag will decode both archives identically.
 */
export function buildZipArchive(entries: readonly ArchiveEntry[], now: Date): Buffer {
  const stamp = dosDateTime(now);

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const encoded = encodeEntry(entry, stamp, offset);
    localParts.push(encoded.local, encoded.nameBytes, encoded.compressed);
    centralParts.push(encoded.central, encoded.nameBytes);
    offset += encoded.local.length + encoded.nameBytes.length + encoded.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localSection = Buffer.concat(localParts);
  const end = endRecord(entries.length, centralDirectory.length, localSection.length);

  return Buffer.concat([localSection, centralDirectory, end]);
}