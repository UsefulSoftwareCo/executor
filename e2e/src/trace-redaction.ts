import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REDACTED = new TextEncoder().encode("[REDACTED]");

export class TraceRedactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceRedactionError";
  }
}

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

const indexOfBytes = (
  source: Uint8Array<ArrayBufferLike>,
  needle: Uint8Array<ArrayBufferLike>,
  from: number,
): number => {
  if (needle.length === 0) return from;
  outer: for (let offset = from; offset <= source.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (source[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
};

const replaceAll = (
  source: Uint8Array<ArrayBufferLike>,
  needle: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> => {
  if (needle.length === 0) return source;
  const chunks: Uint8Array<ArrayBufferLike>[] = [];
  let start = 0;
  while (start < source.length) {
    const found = indexOfBytes(source, needle, start);
    if (found < 0) {
      chunks.push(source.subarray(start));
      break;
    }
    chunks.push(source.subarray(start, found), REDACTED);
    start = found + needle.length;
  }
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const variants = (value: string): Uint8Array<ArrayBufferLike>[] => {
  const base64 = Buffer.from(value).toString("base64");
  const base64url = Buffer.from(value).toString("base64url");
  return [...new Set([value, base64, base64url, encodeURIComponent(value)])].map((variant) =>
    new TextEncoder().encode(variant),
  );
};

const startsWithBytes = (
  contents: Uint8Array<ArrayBufferLike>,
  prefix: readonly number[],
  offset = 0,
): boolean => prefix.every((byte, index) => contents[offset + index] === byte);

const isBinaryAsset = (path: string, contents: Uint8Array<ArrayBufferLike>): boolean => {
  if (/\.(?:gif|jpe?g|mp4|mov|png|webm|webp|woff2?|zip)$/i.test(path)) return true;
  if (startsWithBytes(contents, [0x89, 0x50, 0x4e, 0x47])) return true; // PNG
  if (startsWithBytes(contents, [0xff, 0xd8, 0xff])) return true; // JPEG
  if (startsWithBytes(contents, [0x47, 0x49, 0x46, 0x38])) return true; // GIF
  if (
    startsWithBytes(contents, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(contents, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return true; // WebP
  }
  if (startsWithBytes(contents, [0x1a, 0x45, 0xdf, 0xa3])) return true; // WebM/Matroska
  if (startsWithBytes(contents, [0x50, 0x4b, 0x03, 0x04])) return true; // ZIP
  return startsWithBytes(contents, [0x66, 0x74, 0x79, 0x70], 4); // MP4
};

const isText = (contents: Uint8Array<ArrayBufferLike>): boolean => {
  if (contents.some((byte) => byte === 0)) return false;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const roundTrip = new TextEncoder().encode(decoded);
    if (roundTrip.length !== contents.length) return false;
    return roundTrip.every((byte, index) => byte === contents[index]);
  } catch {
    return false;
  }
};

/** Rewrite text entries in a Playwright trace archive, removing registered values. */
export const redactTraceArchive = async (
  archive: string,
  secrets: readonly string[],
): Promise<void> => {
  const values = [...new Set(secrets.filter((value) => value.length > 0))];
  if (values.length === 0) return;

  const directory = mkdtempSync(join(tmpdir(), "executor-e2e-trace-"));
  try {
    if (!existsSync(archive)) throw new TraceRedactionError("trace archive was not created");
    await execFileAsync("unzip", ["-qq", archive, "-d", directory]);
    for (const path of filesUnder(directory)) {
      if (!statSync(path).isFile()) continue;
      let contents: Uint8Array<ArrayBufferLike> = readFileSync(path);
      if (isBinaryAsset(path, contents) || !isText(contents)) continue;
      for (const value of values) {
        for (const needle of variants(value)) contents = replaceAll(contents, needle);
      }
      writeFileSync(path, contents);
    }
    unlinkSync(archive);
    await execFileAsync("zip", ["-q", "-r", archive, "."], { cwd: directory });
  } catch (error) {
    // A partially rewritten archive can still contain the bearer value. Never
    // leave it behind when a tool or archive operation fails.
    rmSync(archive, { force: true });
    if (error instanceof TraceRedactionError) throw error;
    throw new TraceRedactionError(
      `failed to redact trace archive (${error instanceof Error ? error.name : "unknown error"})`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
