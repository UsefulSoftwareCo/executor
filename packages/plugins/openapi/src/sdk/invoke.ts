import { Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import type { ToolFileValue } from "@executor-js/sdk/core";

import { OpenApiInvocationError } from "./errors";
import { resolveServerUrl } from "./openapi-utils";
import {
  type EncodingObject,
  type OperationFileHint,
  type OperationBinding,
  InvocationResult,
  type MediaBinding,
  type OperationParameter,
  type ServerInfo,
} from "./types";

// ---------------------------------------------------------------------------
// Parameter reading
// ---------------------------------------------------------------------------

const CONTAINER_KEYS: Record<string, readonly string[]> = {
  path: ["path", "pathParams", "params"],
  query: ["query", "queryParams", "params"],
  header: ["headers", "header"],
  cookie: ["cookies", "cookie"],
};

const readParamValue = (args: Record<string, unknown>, param: OperationParameter): unknown => {
  const direct = args[param.name];
  if (direct !== undefined) return direct;

  for (const key of CONTAINER_KEYS[param.location] ?? []) {
    const container = args[key];
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }

  return undefined;
};

const primitiveToString = (value: unknown): string =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

// RFC 3986 §2.2 reserved chars. `allowReserved: true` leaves these
// unencoded; default OAS behavior encodes everything non-unreserved.
const RESERVED_UNENCODED_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;

const encodeReservedAware = (raw: string, allowReserved: boolean): string => {
  if (!allowReserved) return encodeURIComponent(raw);
  // Walk char-by-char so the reserved set passes through as-is.
  let out = "";
  for (const ch of raw) {
    out += RESERVED_UNENCODED_RE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
};

const queryParamValues = (value: unknown, param: OperationParameter): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [primitiveToString(value)];

  const style = Option.getOrUndefined(param.style) ?? "form";
  const explode = Option.getOrElse(param.explode, () => true);

  if (explode) return value.map(primitiveToString);

  const separator = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
  return [value.map(primitiveToString).join(separator)];
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const resolvePath = Effect.fn("OpenApi.resolvePath")(function* (
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: readonly OperationParameter[],
) {
  let resolved = pathTemplate;

  for (const param of parameters) {
    if (param.location !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        return yield* new OpenApiInvocationError({
          message: `Missing required path parameter: ${param.name}`,
          statusCode: Option.none(),
        });
      }
      continue;
    }
    const encoded = encodeReservedAware(
      String(value),
      Option.getOrElse(param.allowReserved, () => false),
    );
    resolved = resolved.replaceAll(`{${param.name}}`, encoded);
    resolved = resolved.replaceAll(`{+${param.name}}`, encoded);
  }

  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
  }

  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");

  if (unresolved.length > 0) {
    return yield* new OpenApiInvocationError({
      message: `Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`,
      statusCode: Option.none(),
    });
  }

  return resolved;
});

// GitHub (and some other upstreams) reject requests that lack a User-Agent
// header with a 403 ("Request forbidden by administrative rules"), which is
// indistinguishable from a credential rejection downstream. Send a default so
// those calls succeed. It is applied before operation header params and
// resolved auth headers, so a spec- or connection-provided User-Agent wins.
const DEFAULT_USER_AGENT = "executor";

const applyHeaders = (
  request: HttpClientRequest.HttpClientRequest,
  headers: Record<string, string>,
): HttpClientRequest.HttpClientRequest => {
  let req = request;
  for (const [name, value] of Object.entries(headers)) {
    req = HttpClientRequest.setHeader(req, name, value);
  }
  return req;
};

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const normalizeContentType = (ct: string | null | undefined): string =>
  ct?.split(";")[0]?.trim().toLowerCase() ?? "";

export const STREAM_MAX_BYTES = 1_000_000;
export const STREAM_MAX_MS = 10_000;
// Below Cloudflare's ~125s subrequest limit so cloud fails first with an
// actionable error, but above the slowest legitimate buffered upstreams
// observed in production (30d telemetry: successful calls cluster under
// 110s; a 60s cap would have broken ~40 real calls).
export const RESPONSE_HEADERS_TIMEOUT_MS = 110_000;

class StreamCapReached extends Error {
  readonly _tag = "StreamCapReached";
}

export interface StreamingResponseCaps {
  readonly maxBytes?: number;
  readonly maxMs?: number;
}

export interface InvokeOptions {
  readonly responseHeadersTimeoutMs?: number;
}

const formatTimeout = (timeoutMs: number): string =>
  timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000}s` : `${timeoutMs}ms`;

const responseHeadersTimeoutMessage = (timeoutMs: number): string =>
  `Upstream returned no response headers within ${formatTimeout(timeoutMs)}. The endpoint may be a live stream with no data to send (for example, runtime logs of an idle deployment); the request was aborted. Retry when the resource has activity, or use a non-streaming endpoint.`;

const STREAMING_RESPONSE_CONTENT_TYPES = new Set([
  "application/stream+json",
  "application/x-ndjson",
  "application/jsonl",
  "text/event-stream",
]);

const isStreamingResponseContentType = (ct: string | null | undefined): boolean =>
  STREAMING_RESPONSE_CONTENT_TYPES.has(normalizeContentType(ct));

const isJsonContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/json" || normalized.includes("+json") || normalized.includes("json")
  );
};

const isFormUrlEncoded = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/x-www-form-urlencoded";

const isMultipartFormData = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("multipart/form-data");

const isXmlContentType = (ct: string | null | undefined): boolean => {
  const normalized = normalizeContentType(ct);
  if (!normalized) return false;
  return (
    normalized === "application/xml" || normalized === "text/xml" || normalized.endsWith("+xml")
  );
};

const isTextContentType = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct).startsWith("text/");

const isOctetStream = (ct: string | null | undefined): boolean =>
  normalizeContentType(ct) === "application/octet-stream";

const decodeJsonLine = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const parseStreamingJsonLines = (text: string, truncated: boolean): unknown => {
  const lines = text.split(/\r?\n/);
  let lastNonEmptyIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line !== undefined && line.trim() !== "") {
      lastNonEmptyIndex = index;
      break;
    }
  }
  const rows: unknown[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const parsed = decodeJsonLine(line);
    if (Exit.isSuccess(parsed)) {
      rows.push(parsed.value);
      continue;
    }
    // A trailing fragment cut mid-line by the byte/time cap is expected; any
    // other unparseable line means the body is not NDJSON after all.
    if (truncated && index === lastNonEmptyIndex) continue;
    return text;
  }

  return rows;
};

const NDJSON_CONTENT_TYPES = new Set([
  "application/stream+json",
  "application/x-ndjson",
  "application/jsonl",
]);

const decodeStreamingResponseBody = (
  contentType: string | null,
  text: string,
  truncated: boolean,
): unknown =>
  NDJSON_CONTENT_TYPES.has(normalizeContentType(contentType))
    ? parseStreamingJsonLines(text, truncated)
    : text;

export const collectStreamingBody = (
  stream: Stream.Stream<Uint8Array, unknown, never>,
  contentType: string | null,
  caps: StreamingResponseCaps = {},
) =>
  Effect.gen(function* () {
    const maxBytes = caps.maxBytes ?? STREAM_MAX_BYTES;
    const maxMs = caps.maxMs ?? STREAM_MAX_MS;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    const startedAt = Date.now();

    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const completedExitOption = yield* Effect.callback<Option.Option<Exit.Exit<void, unknown>>>(
      (resume, signal) => {
        let settled = false;
        const collectEffect = stream.pipe(
          Stream.timeout(maxMs),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const remaining = maxBytes - bytes;
              if (remaining <= 0) {
                truncated = true;
                return yield* Effect.fail(new StreamCapReached());
              }

              if (chunk.byteLength > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                bytes += remaining;
                truncated = true;
                return yield* Effect.fail(new StreamCapReached());
              }

              chunks.push(chunk);
              bytes += chunk.byteLength;
              if (bytes >= maxBytes) {
                truncated = true;
                return yield* Effect.fail(new StreamCapReached());
              }
            }),
          ),
          Effect.catch((error: unknown) =>
            error instanceof StreamCapReached ? Effect.void : Effect.fail(error),
          ),
          Effect.exit,
          Effect.tap((exit) =>
            Effect.sync(() => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resume(Effect.succeed(Option.some(exit)));
            }),
          ),
        );
        const fiber = runFork(collectEffect);
        const interrupt = () => {
          runFork(Fiber.interrupt(fiber));
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          truncated = true;
          interrupt();
          resume(Effect.succeed(Option.none()));
        }, maxMs + 1_000);
        signal.addEventListener("abort", interrupt, { once: true });
        return Effect.sync(() => {
          clearTimeout(timer);
          signal.removeEventListener("abort", interrupt);
          if (!settled) interrupt();
        });
      },
    );
    if (Option.isSome(completedExitOption) && Exit.isFailure(completedExitOption.value)) {
      return yield* Effect.failCause(completedExitOption.value.cause);
    }
    if (Option.isNone(completedExitOption)) truncated = true;

    const durationMs = Date.now() - startedAt;
    if (durationMs >= maxMs) truncated = true;
    const collected = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      collected.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8").decode(collected);

    return {
      data: decodeStreamingResponseBody(contentType, text, truncated),
      headers: {
        "x-executor-stream": truncated ? "truncated" : "complete",
        "x-executor-stream-bytes": String(bytes),
        "x-executor-stream-duration-ms": String(durationMs),
      },
    };
  });

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

const normalizeBase64 = (value: string, encoding: "base64" | "base64url"): string => {
  const compact = value.replace(/\s/g, "");
  const alphabet =
    encoding === "base64url" ? compact.replace(/-/g, "+").replace(/_/g, "/") : compact;
  const remainder = alphabet.length % 4;
  return remainder === 0 ? alphabet : `${alphabet}${"=".repeat(4 - remainder)}`;
};

const byteLengthFromBase64 = (base64: string): number => {
  const compact = base64.replace(/\s/g, "");
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
};

const isGenericMimeType = (mimeType: string): boolean =>
  normalizeContentType(mimeType) === "application/octet-stream";

const startsWithBytes = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  prefix.every((byte, index) => bytes[index] === byte);

const isLikelyUtf8Text = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0) return false;
  let text: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: TextDecoder throws while probing arbitrary binary content
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let suspicious = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const allowedControl = code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
    if (code === 0x00) return false;
    if (code < 0x20 && !allowedControl) suspicious += 1;
  }
  return suspicious / Math.max(1, text.length) <= 0.02;
};

const sniffMimeType = (bytes: Uint8Array): string | null => {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return "image/gif";
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (
    startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "application/zip";
  }
  if (isLikelyUtf8Text(bytes)) return "text/plain";
  return null;
};

const bytesFromBase64Prefix = (base64: string): Uint8Array => {
  const prefix = base64.slice(0, Math.min(base64.length, 64));
  const binary = atob(prefix);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const sniffMimeTypeFromBase64 = (base64: string): string | null =>
  sniffMimeType(bytesFromBase64Prefix(base64));

type DecodedBase64Body = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false };

const base64ToUint8Array = (value: string): Uint8Array | null => {
  let binary = "";
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: atob throws for invalid base64; invalid shapes are treated as non-byte input
  try {
    binary = atob(normalizeBase64(value, "base64"));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const decodeBase64Body = (value: string): DecodedBase64Body => {
  const bytes = base64ToUint8Array(value);
  return bytes ? { ok: true, bytes } : { ok: false };
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return new Uint8Array(value as readonly number[]);
  }
  return null;
};

const readNestedBodyBase64 = (value: unknown): unknown =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.prototype.hasOwnProperty.call(value, "bodyBase64")
    ? (value as Record<string, unknown>).bodyBase64
    : undefined;

const readHintString = (option: OperationFileHint["dataField"], fallback: string): string =>
  Option.getOrElse(option, () => fallback);

const readHintMimeType = (hint: OperationFileHint, fallback: string): string =>
  Option.getOrElse(hint.mimeType, () => fallback);

const readHintEncoding = (hint: OperationFileHint): "base64" | "base64url" =>
  Option.getOrElse(hint.encoding, () => "base64");

const fileFromByteField = (body: unknown, hint: OperationFileHint): ToolFileValue | null => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const dataField = readHintString(hint.dataField, "data");
  const rawData = record[dataField];
  if (typeof rawData !== "string") return null;

  const data = normalizeBase64(rawData, readHintEncoding(hint));
  const sizeField = Option.getOrUndefined(hint.sizeField);
  const byteLength =
    sizeField && typeof record[sizeField] === "number"
      ? record[sizeField]
      : byteLengthFromBase64(data);
  const hintedMimeType = readHintMimeType(hint, "application/octet-stream");

  return {
    _tag: "ToolFile",
    mimeType: isGenericMimeType(hintedMimeType)
      ? (sniffMimeTypeFromBase64(data) ?? hintedMimeType)
      : hintedMimeType,
    encoding: "base64",
    data,
    byteLength,
  };
};

const fileFromBinaryBytes = (
  bytes: Uint8Array,
  hint: OperationFileHint,
  contentType: string | null | undefined,
): ToolFileValue => {
  const hintedMimeType = contentType ?? readHintMimeType(hint, "application/octet-stream");
  return {
    _tag: "ToolFile",
    mimeType: isGenericMimeType(hintedMimeType)
      ? (sniffMimeType(bytes) ?? hintedMimeType)
      : hintedMimeType,
    encoding: "base64",
    data: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
  };
};

type FormDataRecord = Parameters<typeof HttpClientRequest.bodyFormDataRecord>[1];
type FormDataCoercible = FormDataRecord[string];

// Pull a plain ArrayBuffer out of a Uint8Array — `new Blob([u8])` rejects
// views whose `.buffer` is `SharedArrayBuffer | ArrayBuffer` under strict
// lib.dom typings.
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
};

// ---------------------------------------------------------------------------
// OpenAPI 3.x encoding — per-property style/explode/allowReserved/contentType
// for multipart/form-data and application/x-www-form-urlencoded bodies.
// Spec ref: https://spec.openapis.org/oas/v3.1.0#encoding-object
// ---------------------------------------------------------------------------

type StyleExplode = {
  readonly style: string;
  readonly explode: boolean;
  readonly allowReserved: boolean;
};

const DEFAULT_FORM_STYLE: StyleExplode = {
  style: "form",
  explode: true,
  allowReserved: false,
};

const resolveStyleExplode = (e: EncodingObject | undefined): StyleExplode => {
  if (!e) return DEFAULT_FORM_STYLE;
  return {
    style: Option.getOrElse(e.style, () => DEFAULT_FORM_STYLE.style),
    explode: Option.getOrElse(e.explode, () => DEFAULT_FORM_STYLE.explode),
    allowReserved: Option.getOrElse(e.allowReserved, () => DEFAULT_FORM_STYLE.allowReserved),
  };
};

const encodeFormValue = (v: unknown, allowReserved: boolean): string => {
  const raw = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
  return encodeReservedAware(raw, allowReserved);
};

/**
 * Serialize a record to application/x-www-form-urlencoded with OAS3 style
 * rules honored per-field. Supports `form` (default), `deepObject`,
 * `pipeDelimited`, `spaceDelimited` styles with `explode` true / false.
 */
const serializeFormUrlEncoded = (
  value: Record<string, unknown>,
  encoding: Record<string, EncodingObject> | undefined,
): string => {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    const { style, explode, allowReserved } = resolveStyleExplode(encoding?.[key]);
    const encKey = encodeURIComponent(key);

    if (Array.isArray(raw)) {
      if (explode) {
        for (const v of raw) {
          parts.push(`${encKey}=${encodeFormValue(v, allowReserved)}`);
        }
      } else {
        const sep = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
        parts.push(
          `${encKey}=${encodeFormValue(
            raw.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(sep),
            allowReserved,
          )}`,
        );
      }
      continue;
    }

    if (typeof raw === "object") {
      const entries = Object.entries(raw as Record<string, unknown>).filter(
        ([, v]) => v !== undefined && v !== null,
      );
      if (style === "deepObject") {
        for (const [subkey, subval] of entries) {
          // Encode the whole `key[subkey]` fragment so `[` / `]` become
          // `%5B` / `%5D`. Matches swagger-client's behaviour and remains
          // accepted by common server-side parsers (qs, Rails, etc.).
          parts.push(
            `${encodeURIComponent(`${key}[${subkey}]`)}=${encodeFormValue(subval, allowReserved)}`,
          );
        }
      } else if (explode) {
        // form + explode=true on object: sub-keys become top-level fields.
        for (const [subkey, subval] of entries) {
          parts.push(`${encodeURIComponent(subkey)}=${encodeFormValue(subval, allowReserved)}`);
        }
      } else {
        // form + explode=false on object: flatten to csv key,val,key,val.
        const flat = entries.flatMap(([k, v]) => [
          k,
          typeof v === "object" ? JSON.stringify(v) : String(v),
        ]);
        parts.push(`${encKey}=${encodeFormValue(flat.join(","), allowReserved)}`);
      }
      continue;
    }

    parts.push(`${encKey}=${encodeFormValue(raw, allowReserved)}`);
  }
  return parts.join("&");
};

/**
 * Best-effort build of a multipart FormData entry record.
 *
 * If `encoding[key].contentType` is declared (OAS3 §4.8.15), wrap the value
 * in a `Blob` with that type so the runtime multipart framer emits the
 * per-part `Content-Type` header (e.g. `application/json` for a metadata
 * part whose server expects parsed JSON).
 *
 * Otherwise: primitives pass through, arrays handle their item types, byte
 * shapes wrap as Blob, nested objects JSON-stringify (never `[object Object]`).
 */
const coerceFormDataRecord = (
  value: Record<string, unknown>,
  encoding: Record<string, EncodingObject> | undefined,
): FormDataRecord => {
  const out: Record<string, FormDataCoercible> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;

    const partType = encoding?.[key]
      ? Option.getOrUndefined(encoding[key]!.contentType)
      : undefined;

    // Explicit per-part content type: wrap in a typed Blob so the framer
    // emits `Content-Type: <partType>` on this part. JSON types get the
    // value JSON-stringified first so the blob body is valid JSON.
    if (partType) {
      const isJson = partType.startsWith("application/json") || partType.includes("+json");
      const serialized =
        typeof raw === "string"
          ? raw
          : isJson
            ? JSON.stringify(raw)
            : typeof raw === "object"
              ? JSON.stringify(raw)
              : String(raw);
      out[key] = new Blob([serialized], { type: partType });
      continue;
    }

    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw instanceof Blob ||
      (typeof File !== "undefined" && raw instanceof File)
    ) {
      out[key] = raw as FormDataCoercible;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((v) =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v instanceof Blob ||
        (typeof File !== "undefined" && v instanceof File)
          ? (v as FormDataCoercible)
          : JSON.stringify(v),
      ) as FormDataCoercible;
      continue;
    }
    const bytes = toUint8Array(raw);
    if (bytes) {
      out[key] = new Blob([toArrayBuffer(bytes)]);
      continue;
    }
    out[key] = JSON.stringify(raw);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Request body dispatch
//
// Dispatch is driven by the spec-declared content type first, JS type of
// the provided body second. Servers that advertise a specific content type
// almost always reject anything else (e.g. a multipart endpoint will hang
// waiting for valid framing if it receives `application/json`), so the
// content type wins.
//
// Within each content type we accept both pre-serialized strings (user
// already produced the wire format) and structured JS values we can
// serialize ourselves. The last-resort fallback is `JSON.stringify(body)`
// — never `String(body)` (which produces the useless `[object Object]`).
// ---------------------------------------------------------------------------

const applyRequestBody = (
  request: HttpClientRequest.HttpClientRequest,
  contentType: string,
  bodyValue: unknown,
  encoding: Record<string, EncodingObject> | undefined,
): HttpClientRequest.HttpClientRequest => {
  if (isJsonContentType(contentType)) {
    // Pre-serialized JSON strings pass through with the declared media
    // type preserved (important for `application/vnd.foo+json` etc.).
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    return HttpClientRequest.bodyJsonUnsafe(request, bodyValue);
  }

  if (isFormUrlEncoded(contentType)) {
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    if (typeof bodyValue === "object" && bodyValue !== null && !Array.isArray(bodyValue)) {
      // Serialize ourselves so OAS3 encoding (style/explode/deepObject)
      // is honored. bodyUrlParams doesn't know about per-field style.
      const serialized = serializeFormUrlEncoded(bodyValue as Record<string, unknown>, encoding);
      return HttpClientRequest.bodyText(request, serialized, contentType);
    }
    // Non-object body — fall back to platform helper (handles URLSearchParams).
    return HttpClientRequest.bodyUrlParams(
      request,
      bodyValue as Parameters<typeof HttpClientRequest.bodyUrlParams>[1],
    );
  }

  if (isMultipartFormData(contentType)) {
    if (bodyValue instanceof FormData) {
      return HttpClientRequest.bodyFormData(request, bodyValue);
    }
    if (typeof bodyValue === "object" && bodyValue !== null) {
      return HttpClientRequest.bodyFormDataRecord(
        request,
        coerceFormDataRecord(bodyValue as Record<string, unknown>, encoding),
      );
    }
    // String / primitive under multipart is almost certainly wrong on the
    // caller's end — send it as text with their declared content type and
    // let the server produce a useful error.
    return HttpClientRequest.bodyText(request, String(bodyValue), contentType);
  }

  if (isOctetStream(contentType)) {
    const bytes = toUint8Array(bodyValue);
    if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    // Unknown shape — serialize as JSON so at least the payload is visible.
    return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
  }

  if (isXmlContentType(contentType) || isTextContentType(contentType)) {
    if (typeof bodyValue === "string") {
      return HttpClientRequest.bodyText(request, bodyValue, contentType);
    }
    const bytes = toUint8Array(bodyValue);
    if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
    // Object body under text/xml is unusual — stringify so the caller sees
    // their own payload instead of `[object Object]`.
    return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
  }

  // Unknown content type: respect what the caller supplied.
  if (typeof bodyValue === "string") {
    return HttpClientRequest.bodyText(request, bodyValue, contentType);
  }
  const bytes = toUint8Array(bodyValue);
  if (bytes) return HttpClientRequest.bodyUint8Array(request, bytes, contentType);
  return HttpClientRequest.bodyText(request, JSON.stringify(bodyValue), contentType);
};

// ---------------------------------------------------------------------------
// Public API — build the outbound request for an operation
//
// The full pre-flight phase of an invocation: read/validate caller args
// (path params, request body, base64 payloads) and construct the
// HttpClientRequest. Pure — nothing is sent. Exposed separately so the
// executor's approval flow can validate args BEFORE raising an approval
// elicitation, guaranteeing the validation semantics are exactly what
// `invoke` applies (one code path, not a parallel re-implementation).
// ---------------------------------------------------------------------------

export const buildRequest = Effect.fn("OpenApi.buildRequest")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  sourceQueryParams: Record<string, string> = {},
) {
  const resolvedPath = yield* resolvePath(operation.pathTemplate, args, operation.parameters);

  const path = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

  let request = HttpClientRequest.make(operation.method.toUpperCase() as "GET")(path);

  // Default first so operation header params and resolved auth headers below
  // can override it; the upstream still gets a User-Agent if nothing else sets one.
  request = HttpClientRequest.setHeader(request, "User-Agent", DEFAULT_USER_AGENT);

  for (const [name, value] of Object.entries(sourceQueryParams)) {
    request = HttpClientRequest.setUrlParam(request, name, value);
  }

  for (const param of operation.parameters) {
    if (param.location !== "query") continue;
    const value = readParamValue(args, param);
    for (const paramValue of queryParamValues(value, param)) {
      request = HttpClientRequest.appendUrlParam(request, param.name, paramValue);
    }
  }

  for (const param of operation.parameters) {
    if (param.location !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    request = HttpClientRequest.setHeader(request, param.name, String(value));
  }

  if (Option.isSome(operation.requestBody)) {
    const rb = operation.requestBody.value;
    const contentsOpt = Option.getOrUndefined(rb.contents);
    const requestedCt = typeof args.contentType === "string" ? args.contentType : undefined;
    const octetStreamContent = contentsOpt?.find((c) => isOctetStream(c.contentType));
    const bodyAcceptsOctetStream = Boolean(octetStreamContent) || isOctetStream(rb.contentType);
    const hasBodyBase64 = Object.prototype.hasOwnProperty.call(args, "bodyBase64");
    const bodyBase64Raw = args.bodyBase64;
    const bodyBase64 =
      typeof bodyBase64Raw === "string" ? decodeBase64Body(bodyBase64Raw) : undefined;

    if (hasBodyBase64 && typeof bodyBase64Raw !== "string") {
      return yield* new OpenApiInvocationError({
        message: "`bodyBase64` must be a base64 string",
        statusCode: Option.none(),
      });
    }
    if (bodyBase64?.ok === false) {
      return yield* new OpenApiInvocationError({
        message: "`bodyBase64` is not valid base64",
        statusCode: Option.none(),
      });
    }
    if (bodyBase64?.ok === true && !bodyAcceptsOctetStream) {
      return yield* new OpenApiInvocationError({
        message: "`bodyBase64` requires an application/octet-stream request body",
        statusCode: Option.none(),
      });
    }
    if (bodyBase64?.ok === true && requestedCt && !isOctetStream(requestedCt)) {
      return yield* new OpenApiInvocationError({
        message: "`bodyBase64` requires an application/octet-stream contentType",
        statusCode: Option.none(),
      });
    }

    const rawBodyValue = args.body ?? args.input;
    const nestedBodyBase64Raw = readNestedBodyBase64(rawBodyValue);
    const hasNestedBodyBase64 = nestedBodyBase64Raw !== undefined;
    const nestedBodyBase64 =
      typeof nestedBodyBase64Raw === "string" ? decodeBase64Body(nestedBodyBase64Raw) : undefined;

    if (hasNestedBodyBase64 && typeof nestedBodyBase64Raw !== "string") {
      return yield* new OpenApiInvocationError({
        message: "`body.bodyBase64` must be a base64 string",
        statusCode: Option.none(),
      });
    }
    if (nestedBodyBase64?.ok === false) {
      return yield* new OpenApiInvocationError({
        message: "`body.bodyBase64` is not valid base64",
        statusCode: Option.none(),
      });
    }
    if (nestedBodyBase64?.ok === true && !bodyAcceptsOctetStream) {
      return yield* new OpenApiInvocationError({
        message: "`body.bodyBase64` requires an application/octet-stream request body",
        statusCode: Option.none(),
      });
    }
    if (nestedBodyBase64?.ok === true && requestedCt && !isOctetStream(requestedCt)) {
      return yield* new OpenApiInvocationError({
        message: "`body.bodyBase64` requires an application/octet-stream contentType",
        statusCode: Option.none(),
      });
    }

    const binaryBody = bodyBase64?.ok === true ? bodyBase64 : nestedBodyBase64;
    const bodyValue = binaryBody?.ok === true ? binaryBody.bytes : rawBodyValue;
    if (rb.required && bodyValue === undefined) {
      return yield* new OpenApiInvocationError({
        message: bodyAcceptsOctetStream
          ? "Missing required request body: provide `bodyBase64`"
          : "Missing required request body",
        statusCode: Option.none(),
      });
    }
    if (bodyValue !== undefined) {
      // Resolve which declared media type to use. When the spec declares
      // multiple, the caller can override via `args.contentType`; otherwise
      // we use the first-declared (spec author's preferred ordering).
      const selected: MediaBinding | undefined =
        binaryBody?.ok === true && octetStreamContent
          ? octetStreamContent
          : contentsOpt && requestedCt
            ? contentsOpt.find((c) => c.contentType === requestedCt)
            : undefined;
      const chosenCt =
        binaryBody?.ok === true && !octetStreamContent && isOctetStream(rb.contentType)
          ? rb.contentType
          : (selected?.contentType ?? rb.contentType);
      // A `bodyBase64` arg already decoded to bytes above. A plain string
      // `body` is the long-standing way callers pass (text) octet-stream
      // upload content, and applyRequestBody sends it through as-is, so let it
      // past. Only a genuinely non-byte, non-string shape (an object, say)
      // can't be uploaded as octet-stream and needs `bodyBase64`.
      if (
        isOctetStream(chosenCt) &&
        typeof bodyValue !== "string" &&
        toUint8Array(bodyValue) === null
      ) {
        return yield* new OpenApiInvocationError({
          message: "application/octet-stream request body must be bytes; provide `bodyBase64`",
          statusCode: Option.none(),
        });
      }
      const chosenEncoding = selected
        ? Option.getOrUndefined(selected.encoding)
        : contentsOpt && contentsOpt[0]
          ? Option.getOrUndefined(contentsOpt[0].encoding)
          : undefined;
      request = applyRequestBody(request, chosenCt, bodyValue, chosenEncoding);
    }
  }

  request = applyHeaders(request, resolvedHeaders);

  return request;
});

// ---------------------------------------------------------------------------
// Public API — invoke a single operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  sourceQueryParams: Record<string, string> = {},
  options: InvokeOptions = {},
) {
  const client = yield* HttpClient.HttpClient;

  yield* Effect.annotateCurrentSpan({
    "http.method": operation.method.toUpperCase(),
    "http.route": operation.pathTemplate,
    "plugin.openapi.method": operation.method.toUpperCase(),
    "plugin.openapi.path_template": operation.pathTemplate,
    "plugin.openapi.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

  const request = yield* buildRequest(operation, args, resolvedHeaders, sourceQueryParams);

  const responseHeadersTimeoutMs = options.responseHeadersTimeoutMs ?? RESPONSE_HEADERS_TIMEOUT_MS;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const responseExitOption = yield* Effect.callback<
    Option.Option<Exit.Exit<HttpClientResponse.HttpClientResponse, OpenApiInvocationError>>
  >((resume, signal) => {
    let settled = false;
    const responseEffect = client.execute(request).pipe(
      Effect.mapError(
        (err) =>
          new OpenApiInvocationError({
            message: "HTTP request failed",
            statusCode: Option.none(),
            cause: err,
          }),
      ),
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resume(Effect.succeed(Option.some(exit)));
        }),
      ),
    );
    const fiber = runFork(responseEffect);
    const interrupt = () => {
      runFork(Fiber.interrupt(fiber));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      interrupt();
      resume(Effect.succeed(Option.none()));
    }, responseHeadersTimeoutMs);
    signal.addEventListener("abort", interrupt, { once: true });
    return Effect.sync(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", interrupt);
      if (!settled) interrupt();
    });
  });
  if (Option.isNone(responseExitOption)) {
    return yield* new OpenApiInvocationError({
      message: responseHeadersTimeoutMessage(responseHeadersTimeoutMs),
      statusCode: Option.none(),
      reason: "response_headers_timeout",
    });
  }
  const responseExit = responseExitOption.value;
  if (Exit.isFailure(responseExit)) return yield* Effect.failCause(responseExit.cause);
  const response = responseExit.value;

  const status = response.status;
  yield* Effect.annotateCurrentSpan({
    "http.status_code": status,
  });
  const responseHeaders: Record<string, string> = { ...response.headers };

  const contentType = response.headers["content-type"] ?? null;
  const mapBodyError = Effect.mapError(
    (err: unknown) =>
      new OpenApiInvocationError({
        message: "Failed to read response body",
        statusCode: Option.some(status),
        cause: err,
      }),
  );
  const responseBodyBinding = Option.getOrUndefined(operation.responseBody);
  const fileHint = responseBodyBinding
    ? Option.getOrUndefined(responseBodyBinding.fileHint)
    : undefined;
  const ok = status >= 200 && status < 300;
  const streamingBody =
    ok &&
    status !== 204 &&
    fileHint?.kind !== "binaryResponse" &&
    isStreamingResponseContentType(contentType)
      ? yield* collectStreamingBody(response.stream, contentType).pipe(mapBodyError)
      : null;
  if (streamingBody) {
    Object.assign(responseHeaders, streamingBody.headers);
  }
  const responseBody: unknown =
    status === 204
      ? null
      : ok && fileHint?.kind === "binaryResponse"
        ? fileFromBinaryBytes(
            new Uint8Array(yield* response.arrayBuffer.pipe(mapBodyError)),
            fileHint,
            contentType,
          )
        : streamingBody
          ? streamingBody.data
          : isJsonContentType(contentType)
            ? yield* response.json.pipe(
                Effect.catch(() => response.text),
                mapBodyError,
              )
            : yield* response.text.pipe(mapBodyError);

  const dataBody =
    ok && fileHint?.kind === "byteField"
      ? (fileFromByteField(responseBody, fileHint) ?? responseBody)
      : responseBody;
  return InvocationResult.make({
    status,
    headers: responseHeaders,
    data: ok ? dataBody : null,
    error: ok ? null : responseBody,
  });
});

// Connection `baseUrl` wins; otherwise the call's chosen server (`server.url`, or
// the first) resolved with its `{variables}` (call values, else spec defaults).
const resolveRequestHost = (
  servers: readonly ServerInfo[],
  serverArg: unknown,
  baseUrl: string,
): string => {
  if (baseUrl) return baseUrl;
  if (servers.length === 0) return "";

  const arg = (
    typeof serverArg === "object" && serverArg !== null && !Array.isArray(serverArg)
      ? serverArg
      : {}
  ) as { url?: unknown; variables?: unknown };
  const chosen = servers.find((server) => server.url === arg.url) ?? servers[0]!;

  const overrides: Record<string, string> = {};
  if (typeof arg.variables === "object" && arg.variables !== null) {
    for (const [name, value] of Object.entries(arg.variables as Record<string, unknown>)) {
      if (value != null && value !== "") overrides[name] = String(value);
    }
  }
  return resolveServerUrl(chosen.url, Option.getOrUndefined(chosen.variables), overrides);
};

// ---------------------------------------------------------------------------
// Invoke with a provided HttpClient layer + per-call host resolution
// ---------------------------------------------------------------------------

export const invokeWithLayer = (
  operation: OperationBinding,
  args: Record<string, unknown>,
  baseUrl: string,
  resolvedHeaders: Record<string, string>,
  sourceQueryParams: Record<string, string>,
  httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>,
  options: InvokeOptions = {},
) => {
  const effectiveBaseUrl = resolveRequestHost(operation.servers ?? [], args.server, baseUrl);
  const clientWithBaseUrl = effectiveBaseUrl
    ? Layer.effect(
        HttpClient.HttpClient,
        Effect.map(
          Effect.service(HttpClient.HttpClient),
          HttpClient.mapRequest(HttpClientRequest.prependUrl(effectiveBaseUrl)),
        ),
      ).pipe(Layer.provide(httpClientLayer))
    : httpClientLayer;

  return invoke(operation, args, resolvedHeaders, sourceQueryParams, options).pipe(
    Effect.provide(clientWithBaseUrl),
    // `invoke` annotates http.status_code on ITS span (`OpenApi.invoke`,
    // via Effect.fn) — annotateCurrentSpan inside it never reaches this
    // wrapper span. Stamp the status here too so queries against
    // `plugin.openapi.invoke` see the upstream outcome directly.
    Effect.tap((result) => Effect.annotateCurrentSpan({ "http.status_code": result.status })),
    Effect.withSpan("plugin.openapi.invoke", {
      attributes: {
        "plugin.openapi.method": operation.method.toUpperCase(),
        "plugin.openapi.path_template": operation.pathTemplate,
        "plugin.openapi.base_url": effectiveBaseUrl,
      },
    }),
  );
};

// ---------------------------------------------------------------------------
// Derive annotations from HTTP method
// ---------------------------------------------------------------------------

export const REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

export const annotationsForOperation = (
  method: string,
  pathTemplate: string,
): { requiresApproval?: boolean; approvalDescription?: string } => {
  const m = method.toLowerCase();
  if (!REQUIRE_APPROVAL.has(m)) return {};
  return {
    requiresApproval: true,
    approvalDescription: `${method.toUpperCase()} ${pathTemplate}`,
  };
};
