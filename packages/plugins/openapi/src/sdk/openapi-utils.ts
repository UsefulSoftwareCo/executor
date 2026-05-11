// ---------------------------------------------------------------------------
// OpenAPI type aliases and $ref resolution
//
// Wraps the openapi-types V3/V3_1 union mess and provides clean ref resolution.
// ---------------------------------------------------------------------------

import { Option } from "effect";
import type { OpenAPIV3, OpenAPIV3_1 } from "openapi-types";
import type { ParsedDocument } from "./parse";
import type { ServerVariable } from "./types";

// ---------------------------------------------------------------------------
// Type aliases — collapse V3 / V3_1 unions into single names
// ---------------------------------------------------------------------------

export type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
export type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
export type PathItemObject = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
export type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
export type ResponseObject = OpenAPIV3.ResponseObject | OpenAPIV3_1.ResponseObject;
export type MediaTypeObject = OpenAPIV3.MediaTypeObject | OpenAPIV3_1.MediaTypeObject;

// ---------------------------------------------------------------------------
// DocResolver — wraps a parsed document for clean $ref resolution
// ---------------------------------------------------------------------------

export class DocResolver {
  constructor(readonly doc: ParsedDocument) {}

  /** Resolve a value that might be a $ref, returning the resolved object */
  resolve<T>(value: T | OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject): T | null {
    if (isRef(value)) {
      const resolved = this.resolvePointer(value.$ref);
      return resolved as T | null;
    }
    return value as T;
  }

  private resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#/")) return null;
    const segments = ref.slice(2).split("/");
    let current: unknown = this.doc;
    for (const segment of segments) {
      if (typeof current !== "object" || current === null) return null;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}

const isRef = (value: unknown): value is { $ref: string } =>
  typeof value === "object" && value !== null && "$ref" in value;

// ---------------------------------------------------------------------------
// Server URL resolution
// ---------------------------------------------------------------------------

/** Substitute `{var}` placeholders in a templated URL using a plain map. */
export const substituteUrlVariables = (url: string, values: Record<string, string>): string => {
  let out = url;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
};

export const OPENAPI_MAX_SERVER_VARIABLE_OPTIONS = 64;

type ServerLike = {
  url: string;
  variables: import("effect/Option").Option<Record<string, ServerVariable | string>>;
};

export const expandServerUrlOptions = (
  server: ServerLike,
  limit = OPENAPI_MAX_SERVER_VARIABLE_OPTIONS,
): readonly string[] => {
  if (!Option.isSome(server.variables)) return [server.url];
  let urls: readonly string[] = [server.url];
  for (const [name, variable] of Object.entries(server.variables.value)) {
    const enumValues =
      typeof variable === "string" ? [] : Option.getOrElse(variable.enum, () => []);
    const values =
      enumValues.length > 0
        ? enumValues
        : [typeof variable === "string" ? variable : variable.default];
    const next: string[] = [];
    for (const url of urls) {
      for (const value of values) {
        next.push(url.replaceAll(`{${name}}`, value));
        if (next.length >= limit) return next;
      }
    }
    urls = next;
  }
  return urls;
};

export const resolveBaseUrl = (servers: readonly ServerLike[]): string => {
  const server = servers[0];
  if (!server) return "";

  if (!Option.isSome(server.variables)) return server.url;

  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(server.variables.value)) {
    values[name] = typeof v === "string" ? v : v.default;
  }
  return substituteUrlVariables(server.url, values);
};

// ---------------------------------------------------------------------------
// Content negotiation
// ---------------------------------------------------------------------------

/**
 * Return all declared media entries in spec order. `Object.entries` on a
 * plain object preserves insertion order in modern engines, which matches
 * spec declaration order as the parser produced it.
 */
export const declaredContents = (
  content: Record<string, MediaTypeObject> | undefined,
): ReadonlyArray<{ mediaType: string; media: MediaTypeObject }> => {
  if (!content) return [];
  return Object.entries(content).map(([mediaType, media]) => ({ mediaType, media }));
};

/**
 * Pick the default media type for a requestBody or response. Matches
 * swagger-client behaviour: **first declared wins** (not JSON-first). Spec
 * authors order content entries to signal intent (upload-heavy endpoints
 * declare multipart first, JSON second); respecting that order avoids
 * silently downgrading a multipart endpoint to JSON.
 *
 * For response bodies we still want a JSON preference because the server
 * picks the response content type, not the client — the old `application/
 * json` preference is preserved via `preferredResponseContent` below.
 */
export const preferredContent = (
  content: Record<string, MediaTypeObject> | undefined,
): { mediaType: string; media: MediaTypeObject } | undefined => {
  const first = declaredContents(content)[0];
  return first ? first : undefined;
};

/** Response-side content picker — still JSON-first because the server
 *  picks the response media type, so we want to advertise a preference. */
export const preferredResponseContent = (
  content: Record<string, MediaTypeObject> | undefined,
): { mediaType: string; media: MediaTypeObject } | undefined => {
  if (!content) return undefined;
  const entries = Object.entries(content);
  const pick =
    entries.find(([mt]) => mt === "application/json") ??
    entries.find(([mt]) => mt.toLowerCase().includes("+json")) ??
    entries.find(([mt]) => mt.toLowerCase().includes("json")) ??
    entries[0];
  return pick ? { mediaType: pick[0], media: pick[1] } : undefined;
};
