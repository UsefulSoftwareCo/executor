import { Crypto, Effect } from "effect";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HostApi } from "@executor-js/sdk/core";
import type { HostedApiDocument } from "../contracts/api.ts";

/** The product document and its /openapi.json body, each computed on first use. */
export interface LazyHostedApiDocument {
  readonly document: Effect.Effect<HostedApiDocument>;
  readonly body: Effect.Effect<string>;
}

/**
 * Generate the product document when it is first read, not while routes are built. The value is
 * shared by every request this server handles, so it keeps completed results only: a caller never
 * waits on another request's fiber, and an interrupted or failed read is not remembered. That is
 * why this is not `Effect.cached`, which parks concurrent callers on the first caller's latch and
 * stores its exit, interruption included.
 *
 * A document that disagrees with the declared operations is a defect raised by the first read:
 * /openapi.json, or preparing the Executor app during catalog install or organization provisioning.
 */
export const lazyHostedApiDocument = (generate: () => HostedApiDocument): LazyHostedApiDocument => {
  let document: HostedApiDocument | undefined;
  let body: string | undefined;
  const read = Effect.sync(() => (document ??= generate()));
  return { document: read, body: Effect.map(read, (value) => (body ??= JSON.stringify(value))) };
};

/** Serve the document at /openapi.json. */
export const hostedApiDocumentRoute = (api: LazyHostedApiDocument) =>
  HttpRouter.add(
    "GET",
    "/openapi.json",
    Effect.map(api.body, (body) =>
      HttpServerResponse.text(body, { contentType: "application/json" }),
    ),
  );

/**
 * The revision of the API served at /openapi.json: the SHA-256 of the exact body, as `LazyHostedApiDocument`
 * serves it. Apps' outbound network computes the same digest of the document they fetch and
 * refuses one whose revision their cache does not belong to; see `HostApiCheck` in the SDK.
 */
export const hostedApiRevision = (body: string) =>
  Effect.flatMap(Crypto.Crypto, (crypto) =>
    crypto.digest("SHA-256", new TextEncoder().encode(body)),
  ).pipe(Effect.map(Hex.encode), Effect.orDie);

/**
 * This installation's API as the apps that sign in to it read it. Executor apps declare a provider
 * that discovers OAuth at `<origin>/api` for one of `origins`, the API's resource origins, and read
 * the document at `<origin>/openapi.json`.
 */
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
