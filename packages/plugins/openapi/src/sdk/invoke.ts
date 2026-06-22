import { Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
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
// Public API — invoke a single operation
// ---------------------------------------------------------------------------

export const invoke = Effect.fn("OpenApi.invoke")(function* (
  operation: OperationBinding,
  args: Record<string, unknown>,
  resolvedHeaders: Record<string, string>,
  sourceQueryParams: Record<string, string> = {},
) {
  const client = yield* HttpClient.HttpClient;

  yield* Effect.annotateCurrentSpan({
    "http.method": operation.method.toUpperCase(),
    "http.route": operation.pathTemplate,
    "plugin.openapi.method": operation.method.toUpperCase(),
    "plugin.openapi.path_template": operation.pathTemplate,
    "plugin.openapi.headers.resolved_count": Object.keys(resolvedHeaders).length,
  });

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
    const bodyValue = args.body ?? args.input;
    if (bodyValue !== undefined) {
      // Resolve which declared media type to use. When the spec declares
      // multiple, the caller can override via `args.contentType`; otherwise
      // we use the first-declared (spec author's preferred ordering).
      const contentsOpt = Option.getOrUndefined(rb.contents);
      const requestedCt = typeof args.contentType === "string" ? args.contentType : undefined;
      const selected: MediaBinding | undefined =
        contentsOpt && requestedCt
          ? contentsOpt.find((c) => c.contentType === requestedCt)
          : undefined;
      const chosenCt = selected?.contentType ?? rb.contentType;
      const chosenEncoding = selected
        ? Option.getOrUndefined(selected.encoding)
        : contentsOpt && contentsOpt[0]
          ? Option.getOrUndefined(contentsOpt[0].encoding)
          : undefined;
      request = applyRequestBody(request, chosenCt, bodyValue, chosenEncoding);
    }
  }

  request = applyHeaders(request, resolvedHeaders);

  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (err) =>
        new OpenApiInvocationError({
          message: "HTTP request failed",
          statusCode: Option.none(),
          cause: err,
        }),
    ),
  );

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
  const responseBody: unknown =
    status === 204
      ? null
      : ok && fileHint?.kind === "binaryResponse"
        ? fileFromBinaryBytes(
            new Uint8Array(yield* response.arrayBuffer.pipe(mapBodyError)),
            fileHint,
            contentType,
          )
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

  return invoke(operation, args, resolvedHeaders, sourceQueryParams).pipe(
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

const REQUIRE_APPROVAL = new Set(["post", "put", "patch", "delete"]);

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
