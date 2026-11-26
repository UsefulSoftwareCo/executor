import { Effect } from "effect";
import { Digest } from "effect/crypto";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HostApi } from "@executor-js/sdk/core";
import type { HostedApiDocument } from "../contracts/api.ts";

export interface LazyHostedApiDocument {
  readonly document: Effect.Effect<HostedApiDocument>;
  readonly body: Effect.Effect<string>;
}

export const lazyHostedApiDocument = (generate: () => HostedApiDocument): LazyHostedApiDocument => {
  let document: HostedApiDocument | undefined;
  let body: string | undefined;
  const read = Effect.sync(() => (document ??= generate()));
  return { document: read, body: Effect.map(read, (value) => (body ??= JSON.stringify(value))) };
};

export const hostedApiDocumentRoute = (api: LazyHostedApiDocument) =>
  HttpRouter.add(
    "GET",
    "/openapi.json",
    Effect.map(api.body, (body) =>
      HttpServerResponse.text(body, { contentType: "application/json" }),
    ),
  );

export const hostedApiRevision = (body: string) =>
  Effect.flatMap(Digest.Digest, (digest) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(body)),
  ).pipe(Effect.map(Hex.encode));

export const hostedApi = (origins: ReadonlyArray<string>, revision: string): HostApi => {
  const discovery = new Set(origins.map((origin) => `${origin}/api`));
  return {
    revision,
    documents: origins.map((origin) => `${origin}/openapi.json`),
    reads: (requirements) =>
      Object.values(requirements.accounts).some(({ definition }) =>
        Object.values(definition.auth).some(
          (method) =>
            method.type === "oauth2" &&
            "discover" in method &&
            method.discover !== undefined &&
            discovery.has(method.discover),
        ),
      ),
  };
};
