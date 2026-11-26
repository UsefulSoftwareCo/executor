import { Effect, Option, Schema } from "effect";
import { Cookies, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { DocumentApi } from "../contracts/document.ts";
import { CurrentProductBrand } from "@executor-js/utils/product-brand";
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

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The plain page shown when a document cannot render, which hosts' entry pages share. */
export const unavailablePage = (productName: string) => {
  const name = escapeHtml(productName);
  return `<!doctype html><title>Unable to open ${name}</title><main><h1>Unable to open ${name}</h1><p>Please try again.</p><a href="">Try again</a></main>`;
};

const unavailable = Effect.gen(function* () {
  const brand = yield* CurrentProductBrand;
  return HttpServerResponse.html(unavailablePage(brand.name)).pipe(
    HttpServerResponse.setStatus(503),
    HttpServerResponse.setHeaders(documentHeaders),
  );
});

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
    Effect.catchTag("DashboardUnavailable", () => unavailable),
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
    const brand = yield* CurrentProductBrand;
    return HttpServerResponse.html(
      `<!doctype html><meta http-equiv="refresh" content="0"><title>${escapeHtml(brand.name)}</title>`,
    ).pipe(HttpServerResponse.setHeaders(documentHeaders));
  });
