import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
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
