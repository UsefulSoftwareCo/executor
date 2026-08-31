import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { JSON_SCHEMA, load as parseYamlDocument } from "js-yaml";

import { OpenApiExtractionError, OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

const MiB = 1024 * 1024;

/**
 * Whole-document parse guards. What kills a 128MB Cloudflare Workers isolate is
 * the parsed TREE, not the text: the 43MB / ~1.6M-line Microsoft Graph YAML
 * builds a ~300MB tree and dies mid-request with an empty 503 (measured
 * 2026-08), while a same-order text whose bulk is one flat scalar parses fine
 * (see "parses Graph-sized YAML" in parse.test.ts). So the guards measure tree
 * size by proxy, per input shape, and turn the isolate death into an
 * actionable error:
 *
 * - Any text above `MAX_SPEC_TEXT_CHARS` is rejected outright — the string
 *   plus any parse output cannot fit regardless of shape.
 * - Block YAML builds roughly one node per line (~190 bytes of tree per line
 *   measured on Graph), so YAML is capped by newline count.
 * - JSON (and flow-style YAML, same sniff) concentrates structure without
 *   newlines, so it is capped by text size; the 16MB Cloudflare JSON spec is
 *   known-good and must stay under the cap.
 *
 * Provider adapters that stream via `structuralSplit` (Microsoft Graph) never
 * enter this path and are not capped.
 */
export const MAX_SPEC_TEXT_CHARS = 48 * MiB;
export const MAX_JSON_SPEC_CHARS = 32 * MiB;
export const MAX_YAML_SPEC_LINES = 400_000;

const formatMiB = (chars: number): string => `${Math.ceil((chars / MiB) * 10) / 10}MB`;

const specGuidance =
  "Filter the spec to the operations you need before adding it, or use a curated " +
  "provider preset that selects a workload server-side.";

const specTooLargeMessage = (size: number, limit: number): string =>
  `OpenAPI document is too large to parse (${formatMiB(size)}, limit ${formatMiB(limit)}). ` +
  specGuidance;

const specTooDenseMessage = (lines: number): string =>
  `OpenAPI document is too large to parse whole (${lines.toLocaleString("en-US")} lines, ` +
  `limit ${MAX_YAML_SPEC_LINES.toLocaleString("en-US")}). ` +
  specGuidance;

const countLines = (text: string): number => {
  let count = 1;
  for (let pos = text.indexOf("\n"); pos !== -1; pos = text.indexOf("\n", pos + 1)) count += 1;
  return count;
};

export interface SpecFetchCredentials {
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

// ExtractionError subclass raised from parse() for non-3.x specs
class OpenApiExtractionErrorFromParse extends OpenApiExtractionError {}

/**
 * Fetch an OpenAPI spec URL and return its body text. Uses the Effect
 * HttpClient so the caller chooses the transport via layer — in Cloudflare
 * Workers, `FetchHttpClient.layer` binds to the Workers-native `fetch`.
 * Bounded by a 60s timeout.
 */
export const fetchSpecText = Effect.fn("OpenApi.fetchSpecText")(function* (
  url: string,
  credentials?: SpecFetchCredentials,
) {
  const client = yield* HttpClient.HttpClient;
  const requestUrl = new URL(url);
  for (const [name, value] of Object.entries(credentials?.queryParams ?? {})) {
    requestUrl.searchParams.set(name, value);
  }
  let request = HttpClientRequest.get(requestUrl.toString()).pipe(
    HttpClientRequest.setHeader("Accept", "application/json, application/yaml, text/yaml, */*"),
  );
  for (const [name, value] of Object.entries(credentials?.headers ?? {})) {
    request = HttpClientRequest.setHeader(request, name, value);
  }
  const response = yield* client.execute(request).pipe(
    Effect.timeout(Duration.seconds(60)),
    Effect.mapError(
      (_cause) =>
        new OpenApiParseError({
          message: "Failed to fetch OpenAPI document",
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch OpenAPI document: HTTP ${response.status}`,
    });
  }
  // Reject documents the whole-parse path can never handle before downloading
  // them. The declared byte length bounds the decoded text from above only for
  // the coarse any-shape cap, so this never rejects a spec `parseSpecObject`
  // would have accepted; the precise per-shape check still runs there.
  const declaredLength = Number(response.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SPEC_TEXT_CHARS) {
    return yield* new OpenApiParseError({
      message: specTooLargeMessage(declaredLength, MAX_SPEC_TEXT_CHARS),
    });
  }
  const specText = yield* response.text.pipe(
    Effect.mapError(
      (_cause) =>
        new OpenApiParseError({
          message: "Failed to read OpenAPI document body",
        }),
    ),
  );
  return specText;
});

/**
 * Resolve an input string to spec text — if it's a URL, fetch it via
 * HttpClient; otherwise return it as-is.
 */
export const resolveSpecText = (input: string, credentials?: SpecFetchCredentials) =>
  input.startsWith("http://") || input.startsWith("https://")
    ? fetchSpecText(input, credentials)
    : Effect.succeed(input);

/**
 * Parse an OpenAPI document from spec text and validate it's OpenAPI 3.x.
 *
 * NOTE: does NOT resolve `$ref`s. `DocResolver` + `normalizeOpenApiRefs`
 * downstream work on refs lazily, so inlining them here would just waste
 * memory — and for big specs (e.g. Cloudflare's API) that blows through
 * the 128MB Cloudflare Workers memory cap.
 */
export const parse = Effect.fn("OpenApi.parse")(function* (text: string) {
  const api = yield* parseSpecObject(text);

  if (!isOpenApi3(api)) {
    return yield* new OpenApiExtractionErrorFromParse({
      message:
        "Only OpenAPI 3.x documents are supported. Swagger 2.x documents should be converted first.",
    });
  }

  return api as ParsedDocument;
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const isOpenApi3 = (doc: OpenAPI.Document): doc is OpenAPIV3.Document | OpenAPIV3_1.Document =>
  "openapi" in doc && typeof doc.openapi === "string" && doc.openapi.startsWith("3.");

/** Parse JSON or YAML text into an object without applying OpenAPI version validation. */
export const parseSpecObject = (text: string): Effect.Effect<OpenAPI.Document, OpenApiParseError> =>
  Effect.gen(function* () {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return yield* new OpenApiParseError({
        message: "OpenAPI document is empty",
      });
    }

    if (trimmed.length > MAX_SPEC_TEXT_CHARS) {
      return yield* new OpenApiParseError({
        message: specTooLargeMessage(trimmed.length, MAX_SPEC_TEXT_CHARS),
      });
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      if (trimmed.length > MAX_JSON_SPEC_CHARS) {
        return yield* new OpenApiParseError({
          message: specTooLargeMessage(trimmed.length, MAX_JSON_SPEC_CHARS),
        });
      }
    } else {
      const lines = countLines(trimmed);
      if (lines > MAX_YAML_SPEC_LINES) {
        return yield* new OpenApiParseError({
          message: specTooDenseMessage(lines),
        });
      }
    }

    const parsed = yield* parseJsonLike(trimmed).pipe(
      Effect.mapError(
        () =>
          new OpenApiParseError({
            message: "Failed to parse OpenAPI document",
          }),
      ),
    );

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* new OpenApiParseError({
        message: "OpenAPI document must parse to an object",
      });
    }

    return parsed as OpenAPI.Document;
  });

const parseJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const parseJsonLike = (text: string): Effect.Effect<unknown, unknown> => {
  const parseYaml = Effect.try({
    try: () => parseYamlDocument(text, { json: true, schema: JSON_SCHEMA }) as unknown,
    catch: () => "YamlParseFailed" as const,
  });
  if (!text.startsWith("{") && !text.startsWith("[")) return parseYaml;
  return parseJsonText(text).pipe(Effect.catch(() => parseYaml));
};
