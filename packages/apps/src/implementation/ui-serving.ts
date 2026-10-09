/** Shared private SPA rendering, independent of identity, database, and runtime choice. */
import { CurrentTelemetryConfig } from "@executor-js/telemetry";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { UiForbidden, type AppUiAsset, type UiAccountNotice } from "../contracts/ui.ts";
import {
  accountBlockedPage,
  accountNoticeBootstrap,
  accountProblemBlocks,
} from "./ui-account-notice.ts";
import { appPrivateHeaders } from "./ui-auth.ts";
import { deploymentDocument } from "./ui-document.ts";
import { appFailureBootstrap } from "./ui-errors.ts";

/**
 * Render an authorized deployment with a host-owned deployment watcher. Account problems that stop
 * the app replace its document with a page that links to their fix; others add a dismissible card.
 */
export const appDocument = <E, R>(options: {
  readonly deployment: string;
  readonly profile?: string | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly origin: string;
  readonly accounts?: UiAccountNotice | undefined;
  readonly asset: (path: string) => Effect.Effect<AppUiAsset | undefined, E, R>;
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
    const notice = options.accounts;
    if (notice?.problems.some(accountProblemBlocks))
      return HttpServerResponse.text(accountBlockedPage(notice), {
        status: 409,
        contentType: "text/html",
        headers: appPrivateHeaders,
      });
    const document = yield* options.asset("index.html");
    if (document === undefined)
      return HttpServerResponse.text("This app has no UI.", {
        status: 404,
        headers: appPrivateHeaders,
      });
    const context = JSON.stringify({
      deployment: options.deployment,
      profile: options.profile,
      expectedProfileRevision: options.expectedProfileRevision,
    }).replaceAll("<", "\\u003c");
    const telemetry = yield* CurrentTelemetryConfig;
    const attribute = (text: string) =>
      text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const metadata =
      telemetry === undefined
        ? ""
        : `<meta name="executor-build" content="${attribute(telemetry.version)}"><meta name="executor-environment" content="${attribute(telemetry.environment)}">`;
    const boot = `${metadata}<script type="application/json" id="executor-context">${context}</script>${appFailureBootstrap}${notice === undefined || notice.problems.length === 0 ? "" : accountNoticeBootstrap(notice)}<script src="/_executor/watch.js" defer></script>`;
    return HttpServerResponse.text(
      deploymentDocument(new TextDecoder().decode(document.body), options.deployment).replace(
        "<!--executor-ui-->",
        boot,
      ),
      { contentType: "text/html", headers: appPrivateHeaders },
    );
  });

/** Serve an asset only after the host has checked current access and file existence.
 * Asset URLs name their deployment, so their bytes never change: the browser keeps them for a year
 * and does not ask again. Shared proxies never store them. Revoking access stops every new request
 * and all app data, while bytes a browser already downloaded stay in its cache.
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
      "cache-control": "private, max-age=31536000, immutable",
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
