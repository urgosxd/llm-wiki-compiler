/**
 * @file src/utils/bounded-read.ts
 * @description Bounded reads from an already-open handle.
 *
 * Lives here rather than next to any one caller because it is a general I/O guard,
 * not policy about what the bytes MEAN. A handle has already passed its caller's
 * confinement decision by the time it arrives; what is left to enforce is that the
 * read stops at a size the caller chose.
 */
import type { FileHandle } from "node:fs/promises";

/**
 * Read at most `maxBytes` from `handle`, rejecting concurrent growth past it.
 *
 * The buffer is allocated one byte larger than the limit so a file that grew
 * between the caller's size check and this read is DETECTED rather than silently
 * truncated: reading past the limit means the handle is not what the caller sized.
 *
 * @param handle - An open handle the caller has already confined.
 * @param maxBytes - The most bytes this read may return.
 * @param label - Human-readable subject used in the failure message.
 * @returns The bytes read, at most `maxBytes` long.
 * @throws When the handle yields more than `maxBytes`.
 */
export async function readBoundedFromHandle(
  handle: FileHandle,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error(`${label} exceeds its bounded size limit`);
  return buffer.subarray(0, total);
}
