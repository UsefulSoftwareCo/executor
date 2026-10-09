/** Serve TanStack Start documents from a host's Effect HTTP server. */
import { Effect, Option, Schema } from "effect";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { DocumentApi } from "../contracts/document.ts";
import { inProcessApi } from "./in-process.ts";

/** The module a dashboard build emits as `dist/server/server.js`, given host request context. */
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

/**
 * Every dashboard document can carry the MCP consent page, which grants credentials on one
 * click. No other site may frame any of them, and none may be cached for another person.
 */
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

/**
 * Render the requested page. `context` reads what the page needs before rendering, such as the
 * verified session, through the same in-process API the page uses. `headers` adds host policy
 * such as a referrer policy; it cannot remove the shared protections, which are applied last.
 */
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
    // A failed lookup is unavailable, never signed out; the page offers a retry.
    const context = yield* options
      .context(api.document)
      .pipe(Effect.mapError(() => new DashboardUnavailable()));
    // The render outlives this call: Start returns once headers are ready and keeps streaming.
    // A signal tied to this promise would abort it then, so the render stops only when the
    // response body is cancelled, as when the browser disconnects.
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
    // Reads made before rendering, such as a session renewal, reach the browser with the page.
    return HttpServerResponse.fromWeb(response).pipe(
      HttpServerResponse.setHeaders({ ...options.headers, ...documentHeaders }),
      HttpServerResponse.mergeCookies(Cookies.fromSetCookie(api.seal())),
    );
  }).pipe(
    Effect.withSpan("dashboard.document"),
    Effect.catchTag("DashboardUnavailable", () => Effect.succeed(unavailable)),
  );

/**
 * `SameSite=Strict` cookies are not sent on a navigation from another site, such as a return from
 * an app's own subdomain. Answer it with a reload from this page, which is same-origin, so the
 * browser sends them and the server renders with the real session.
 */
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
