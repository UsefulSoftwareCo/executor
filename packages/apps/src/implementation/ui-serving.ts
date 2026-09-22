/** Shared private SPA rendering, independent of identity, database, and runtime choice. */
import { CurrentTelemetryConfig } from "@executor-js/telemetry";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { UiForbidden, type AppUiAsset } from "../contracts/ui.ts";
import { appPrivateHeaders } from "./ui-auth.ts";
import { appFailureBootstrap } from "./ui-errors.ts";

/** Render an authorized deployment. Host-owned markup may add local-only deployment watching. */
export const appDocument = <E, R>(options: {
  readonly deployment: string;
  readonly origin: string;
  readonly asset: (path: string) => Effect.Effect<AppUiAsset | undefined, E, R>;
  readonly head?: string;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = yield* Effect.try(() => new URL(request.url, options.origin).pathname).pipe(
      Effect.mapError(() => new UiForbidden()),
    );
    const file = pathname === "/" ? undefined : yield* options.asset(pathname.slice(1));
    if (file !== undefined && file.contentType !== "text/html")
      return HttpServerResponse.uint8Array(file.body, {
        contentType: file.contentType,
        headers: appPrivateHeaders,
      });
    if (pathname.includes(".") && pathname !== "/index.html")
      return HttpServerResponse.empty({ status: 404 });
    const document = yield* options.asset("index.html");
    if (document === undefined)
      return HttpServerResponse.text("This app has no UI.", {
        status: 404,
        headers: appPrivateHeaders,
      });
    const context = JSON.stringify({ deployment: options.deployment }).replaceAll("<", "\\u003c");
    const telemetry = yield* CurrentTelemetryConfig;
    const attribute = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const metadata =
      telemetry === undefined
        ? ""
        : `<meta name="executor-build" content="${attribute(telemetry.version)}"><meta name="executor-environment" content="${attribute(telemetry.environment)}">`;
    const boot = `${metadata}<base href="/_executor/assets/${attribute(options.deployment)}/"><script type="application/json" id="executor-context">${context}</script>${appFailureBootstrap}${options.head ?? ""}`;
    return HttpServerResponse.text(
      new TextDecoder().decode(document.body).replace("<!--executor-ui-->", boot),
      { contentType: "text/html", headers: appPrivateHeaders },
    );
  });

/** Revalidate immutable assets only after the host has checked current access and file existence.
 * Browsers may retain bytes, but neither browsers nor shared proxies may reuse them without authorization.
 * HTML remains an uncached host-rendered entry point.
 */
export const appAsset = (asset: AppUiAsset | undefined, build: string, path: string) =>
  Effect.gen(function* () {
    if (asset === undefined || asset.contentType === "text/html")
      return HttpServerResponse.empty({ status: 404, headers: appPrivateHeaders });
    const request = yield* HttpServerRequest.HttpServerRequest;
    const etag = `W/"${encodeURIComponent(build)}/${encodeURIComponent(path)}"`;
    const headers = {
      ...appPrivateHeaders,
      "cache-control": "private, no-cache, must-revalidate",
      vary: "Cookie",
      etag,
    };
    const matches = request.headers["if-none-match"]
      ?.split(",")
      .some(
        (candidate) =>
          candidate.trim() === "*" || candidate.trim().replace(/^W\//, "") === etag.slice(2),
      );
    return matches
      ? HttpServerResponse.empty({ status: 304, headers })
      : HttpServerResponse.uint8Array(asset.body, { contentType: asset.contentType, headers });
  });
