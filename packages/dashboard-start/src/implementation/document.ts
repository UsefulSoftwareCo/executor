import { Effect, Option, Schema } from "effect";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { DocumentApi } from "../contracts/document.ts";
import { inProcessApi } from "./in-process.ts";

export interface DashboardServer<Context> {
  readonly fetch: (
    request: Request,
    options: { readonly context: Context },
  ) => Promise<Response> | Response;
}

class DashboardUnavailable extends Schema.TaggedError<DashboardUnavailable>()(
  "DashboardUnavailable",
  {},
) {}

const documentHeaders = {
  "cache-control": "private, no-store",
  vary: "Cookie",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
} as const;

const unavailable = HttpServerResponse.html(
  '<!doctype html><title>Unable to open Executor</title><main><h1>Unable to open Executor</h1><p>Please try again.</p><a href="">Try again</a></main>',
).pipe(HttpServerResponse.setStatus(503), HttpServerResponse.setHeaders(documentHeaders));

export const dashboardDocument = <Context, E, R, E2, R2>(options: {
  readonly server: Effect.Effect<DashboardServer<Context & DocumentApi>, E, R>;
  readonly context: (api: DocumentApi) => Effect.Effect<Context, E2, R2>;
  readonly headers?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const server = yield* options.server.pipe(Effect.mapError(() => new DashboardUnavailable()));
    const api = yield* inProcessApi;
    const context = yield* options
      .context(api.document)
      .pipe(Effect.mapError(() => new DashboardUnavailable()));
    const response = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          server.fetch(
            new Request(url.value, {
              method: request.method,
              headers: new Headers(request.headers),
            }),
            { context: { ...context, ...api.document } },
          ),
        ),
      catch: () => new DashboardUnavailable(),
    });
    return HttpServerResponse.fromWeb(response).pipe(
      HttpServerResponse.setHeaders({ ...options.headers, ...documentHeaders }),
      HttpServerResponse.mergeCookies(Cookies.fromSetCookie(api.seal())),
    );
  }).pipe(
    Effect.withSpan("dashboard.document"),
    Effect.catchTag("DashboardUnavailable", () => Effect.succeed(unavailable)),
  );

export const withSameSiteReload = <E, R>(
  document: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      request.headers["sec-fetch-site"] !== "cross-site" ||
      request.headers["sec-fetch-mode"] !== "navigate"
    )
      return yield* document;
    return HttpServerResponse.html(
      '<!doctype html><meta http-equiv="refresh" content="0"><title>Executor</title>',
    ).pipe(HttpServerResponse.setHeaders(documentHeaders));
  });
