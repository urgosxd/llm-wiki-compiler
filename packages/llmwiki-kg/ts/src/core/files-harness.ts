/**
 * @file packages/llmwiki-kg/ts/src/core/files-harness.ts
 * @description Shared fixture builders for the split `core/files-*` test files.
 *
 * The multipart body builders and part-header helpers were the prelude of one
 * large `files.test.ts`. Not a test file, so the runner does not collect it.
 */
export const STACK_ID = "20efd96a-f6e1-4994-8812-65113f8db4db";
export const DOCUMENT_ID = "d1dfd574-43db-49bc-9ef4-a43f7ad89e2f";

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export const BOUNDARY = "w1doc-boundary";

export interface PartSpec {
  readonly name?: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly data: string | Uint8Array;
  /** Send a Content-Disposition header with no `name` parameter. */
  readonly omitName?: boolean;
  /** Omit the Content-Disposition header entirely. */
  readonly omitDisposition?: boolean;
}

export function multipart(parts: readonly PartSpec[], boundary = BOUNDARY): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\n`;
    if (part.omitDisposition !== true) {
      let disposition = "Content-Disposition: form-data";
      if (part.name !== undefined) {
        disposition += `; name="${part.name}"`;
      }
      if (part.filename !== undefined) {
        disposition += `; filename="${part.filename}"`;
      }
      head += `${disposition}\r\n`;
    }
    if (part.contentType !== undefined) {
      head += `Content-Type: ${part.contentType}\r\n`;
    }
    head += "\r\n";
    chunks.push(bytes(head));
    chunks.push(typeof part.data === "string" ? bytes(part.data) : part.data);
    chunks.push(bytes("\r\n"));
  }
  chunks.push(bytes(`--${boundary}--\r\n`));
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export function multipartContentType(boundary = BOUNDARY): string {
  return `multipart/form-data; boundary=${boundary}`;
}
