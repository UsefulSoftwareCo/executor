import type { OpenAPI, OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import { Duration, Effect, Option, Predicate, Schema } from "effect";
import { Headers, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { JSON_SCHEMA, load as parseYamlDocument } from "js-yaml";

import { OpenApiExtractionError, OpenApiParseError } from "./errors";

export type ParsedDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

// ExtractionError subclass raised from parse() for non-3.x specs
class OpenApiExtractionErrorFromParse extends OpenApiExtractionError {}

/** A previous response's cache validators, replayed as a conditional GET. */
export interface SpecFetchValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type SpecDocumentResult =
  | {
      readonly _tag: "Fetched";
      readonly text: string;
      readonly etag?: string;
      readonly lastModified?: string;
    }
  /** Only possible when `validators` were sent and the server returned 304. */
  | { readonly _tag: "NotModified" };

/**
 * Fetch an OpenAPI spec URL. Uses the Effect HttpClient so the caller chooses
 * the transport via layer (in Cloudflare Workers, `FetchHttpClient.layer`
 * binds to the Workers-native `fetch`). Bounded by a 60s timeout.
 *
 * When `validators` (a previous response's ETag / Last-Modified) are provided
 * the request is conditional, and a 304 comes back as `NotModified` instead of
 * a body: the caller reuses its stored copy.
 *
 * Spec-document fetches are deliberately UNAUTHENTICATED: the fetched text is
 * cached and shared per tenant (content-addressed blob + `spec_source` index),
 * so connection credentials must never be threaded into this request. A future
 * authed-spec feature has to bypass that cache, not extend this function.
 */
export const fetchSpecDocument = Effect.fn("OpenApi.fetchSpecDocument")(function* (
  url: string,
  validators?: SpecFetchValidators,
) {
  const client = yield* HttpClient.HttpClient;
  let request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("Accept", "application/json, application/yaml, text/yaml, */*"),
  );
  if (validators?.etag !== undefined) {
    request = HttpClientRequest.setHeader(request, "If-None-Match", validators.etag);
  }
  if (validators?.lastModified !== undefined) {
    request = HttpClientRequest.setHeader(request, "If-Modified-Since", validators.lastModified);
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
  if (
    response.status === 304 &&
    (validators?.etag !== undefined || validators?.lastModified !== undefined)
  ) {
    return { _tag: "NotModified" } as const satisfies SpecDocumentResult;
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new OpenApiParseError({
      message: `Failed to fetch OpenAPI document: HTTP ${response.status}`,
    });
  }
  const text = yield* response.text.pipe(
    Effect.mapError(
      (_cause) =>
        new OpenApiParseError({
          message: "Failed to read OpenAPI document body",
        }),
    ),
  );
  const etag = Option.getOrUndefined(Headers.get(response.headers, "etag"));
  const lastModified = Option.getOrUndefined(Headers.get(response.headers, "last-modified"));
  return {
    _tag: "Fetched",
    text,
    ...(etag !== undefined ? { etag } : {}),
    ...(lastModified !== undefined ? { lastModified } : {}),
  } as const satisfies SpecDocumentResult;
});

/** Fetch an OpenAPI spec URL and return its body text (unconditional GET). */
export const fetchSpecText = Effect.fn("OpenApi.fetchSpecText")(function* (url: string) {
  const result = yield* fetchSpecDocument(url);
  if (Predicate.isTagged(result, "Fetched")) return result.text;
  // Unreachable without validators; a server 304-ing an unconditional GET is broken.
  return yield* new OpenApiParseError({
    message: "Failed to fetch OpenAPI document: unexpected 304 response",
  });
});

/**
 * Resolve an input string to spec text — if it's a URL, fetch it via
 * HttpClient; otherwise return it as-is.
 */
export const resolveSpecText = (input: string) =>
  input.startsWith("http://") || input.startsWith("https://")
    ? fetchSpecText(input)
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
    try: () => parseYamlDocument(text, { json: true, schema: JSON_SCHEMA }) as unknown,
    catch: () => "YamlParseFailed" as const,
  });
  if (!text.startsWith("{") && !text.startsWith("[")) return parseYaml;
  return parseJsonText(text).pipe(Effect.catch(() => parseYaml));
};
