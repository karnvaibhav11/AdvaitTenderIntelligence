import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveDocumentsRoot } from "./manifest";
import type { FileValidation, ManifestRow } from "./types";

export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const PDF_MAGIC = Buffer.from("%PDF-");

export function documentPath(row: ManifestRow, root = resolveDocumentsRoot()): string {
  const resolved = path.resolve(root, row.relative_path);
  // Manifest paths are data, not trusted: never read outside the corpus root.
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error(`path escapes corpus root: ${row.relative_path}`);
  return resolved;
}

/** Existence, size, %PDF header and sha256 against the manifest. */
export async function validateFile(row: ManifestRow, root?: string): Promise<FileValidation> {
  let file: string;
  try {
    file = documentPath(row, root);
  } catch (error) {
    return { ok: false, reason: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return { ok: false, reason: "missing_file", message: `file not found: ${row.relative_path}` };
  }
  if (size < 64) return { ok: false, reason: "too_small", message: `file is ${size} bytes`, size };
  if (size > MAX_PDF_BYTES) return { ok: false, reason: "too_large", message: `file is ${size} bytes`, size };
  let buffer: Buffer;
  try {
    buffer = await readFile(file);
  } catch (error) {
    return { ok: false, reason: "unreadable", message: error instanceof Error ? error.message : String(error), size };
  }
  if (!buffer.subarray(0, 1024).includes(PDF_MAGIC)) return { ok: false, reason: "not_pdf", message: "missing %PDF header", size };
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (row.file_size_bytes && row.file_size_bytes !== size) {
    return { ok: false, reason: "size_mismatch", message: `size ${size} != manifest ${row.file_size_bytes}`, size, sha256 };
  }
  if (row.sha256 && row.sha256 !== sha256) {
    return { ok: false, reason: "sha256_mismatch", message: `sha256 ${sha256} != manifest ${row.sha256}`, size, sha256 };
  }
  return { ok: true, bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), sha256, size };
}
