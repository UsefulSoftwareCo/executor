import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import YAML from "yaml";

import { OpenApiExtractionError, OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface SpecFetchCredentials {
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

// ExtractionError subclass raised from parse() for non-3.x specs
class OpenApiExtractionErrorFromParse extends OpenApiExtractionError {}

/**
 * Fetch an OpenAPI spec URL and return its body text. Uses the Effect
 * HttpClient so the caller chooses the transport via layer — in Cloudflare
 * Workers, `FetchHttpClient.layer` binds to the Workers-native `fetch` and
 * avoids json-schema-ref-parser's Node-polyfill http resolver, which hangs
 * in production. Bounded by a 60s timeout.
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
  return yield* response.text.pipe(
    Effect.mapError(
      (_cause) =>
        new OpenApiParseError({
          message: "Failed to read OpenAPI document body",
        }),
    ),
  );
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
  const api = yield* parseTextToObject(text);

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

const parseTextToObject = (text: string): Effect.Effect<OpenAPI.Document, OpenApiParseError> =>
  Effect.gen(function* () {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return yield* new OpenApiParseError({
        message: "OpenAPI document is empty",
      });
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
    try: () => YAML.parse(text) as unknown,
    catch: () => "YamlParseFailed" as const,
  });
  if (!text.startsWith("{") && !text.startsWith("[")) return parseYaml;
  return parseJsonText(text).pipe(Effect.catch(() => parseYaml));
};
