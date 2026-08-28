import type { Layer } from "effect";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";

import type { Authentication } from "./types";
import type { OpenApiIntegrationConfig } from "./config";
import type { KeepPathItem } from "./split";
import { OpenApiParseError } from "./errors";

export interface SpecFetchCredentials {
  readonly headers?: Record<string, string>;
  readonly queryParams?: Record<string, string>;
}

export interface SpecFetchInput {
  readonly urls: readonly string[];
  readonly credentials?: SpecFetchCredentials;
  /** Explicit OAuth scopes selected by the caller. Format adapters may use
   *  these to omit operations that the resulting connection cannot invoke. */
  readonly consentScopes?: readonly string[];
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}

export interface DerivedIdentity {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface ConvertedSpec {
  readonly specText: string;
  readonly specUrl?: string;
  readonly baseUrl?: string;
  readonly authenticationTemplate?: readonly Authentication[];
  readonly config?: Partial<OpenApiIntegrationConfig> & Readonly<Record<string, unknown>>;
  readonly keepPathItem?: KeepPathItem;
  readonly document?: unknown;
}

export interface SpecFormatAdapter {
  readonly id: string;
  readonly fetch: (input: SpecFetchInput) => Effect.Effect<ConvertedSpec, OpenApiParseError>;
  readonly deriveIdentity?: (doc: unknown) => DerivedIdentity | null;
}

export const resolveSpecFormatAdapter = (
  adapters: readonly SpecFormatAdapter[],
  id: string | undefined,
): Effect.Effect<SpecFormatAdapter | null, OpenApiParseError> => {
  if (!id) return Effect.succeed(null);
  const adapter = adapters.find((candidate) => candidate.id === id);
  if (adapter) return Effect.succeed(adapter);
  return Effect.fail(new OpenApiParseError({ message: `Unknown OpenAPI spec format: ${id}` }));
};
