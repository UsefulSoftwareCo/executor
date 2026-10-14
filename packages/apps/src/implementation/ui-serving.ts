/** Shared private SPA rendering, independent of identity, database, and runtime choice. */
import { CurrentTelemetryConfig } from "@executor-js/telemetry";
import { Effect, Option, Stream } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  UiFailed,
  UiForbidden,
  type AppUiAsset,
  type AppUiRange,
  type AppUiStoredFile,
  type UiAccountNotice,
} from "../contracts/ui.ts";
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
  /** The account IDs the page runs with, by requirement. */
  readonly accountIds?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly origin: string;
  readonly accounts?: UiAccountNotice | undefined;
  readonly asset: (path: string) => Effect.Effect<AppUiAsset | undefined, E, R>;
}) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const pathname = yield* Effect.try(() => new URL(request.url, options.origin).pathname).pipe(
      Effect.mapError(() => new UiForbidden()),
    );
    // Files are named by decoded paths; a path that does not decode names no file.
    const path = Option.getOrUndefined(assetPath(pathname.slice(1)));
    const file =
      pathname === "/" || path === undefined || path === "index.html"
        ? undefined
        : yield* options.asset(path);
    if (file !== undefined && "body" in file)
      return HttpServerResponse.uint8Array(file.body, {
        contentType: file.contentType,
        headers: appPrivateHeaders,
      });
    // The page's origin serves the active deployment, so the same URL can change content on the
    // next activation: browsers revalidate against the content hash.
    if (file !== undefined) return yield* storedFile(file, "private, no-cache");
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
    // The page is always compiled into the build, never a stored file.
    if (document === undefined || !("body" in document))
      return HttpServerResponse.text("This app has no UI.", {
        status: 404,
        headers: appPrivateHeaders,
      });
    const context = JSON.stringify({
      deployment: options.deployment,
      accounts: options.accountIds,
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

/**
 * A deployment's public file, read from the host's store. The deployment lists it, so bytes that
 * are gone are a storage fault, never a missing page.
 */
export const storedAppFile = <E1, E2>(
  stored: { readonly contentType: string; readonly size: number; readonly etag: string },
  read: (
    range: AppUiRange | undefined,
  ) => Effect.Effect<Option.Option<{ readonly body: Stream.Stream<Uint8Array, E1> }>, E2>,
): AppUiStoredFile => {
  const unavailable = () => new UiFailed({ reason: "unavailable" });
  return {
    contentType: stored.contentType,
    size: stored.size,
    etag: stored.etag,
    read: (range) =>
      read(range).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(unavailable()),
            onSome: (found) => Effect.succeed(found.body.pipe(Stream.mapError(unavailable))),
          }),
        ),
      ),
  };
};

/** The file a URL path names: each segment percent-decoded, or none when one does not decode. */
export const assetPath = (path: string) =>
  Option.liftThrowable(() => path.split("/").map(decodeURIComponent).join("/"))();

const etagMatches = (header: string | undefined, etag: string) =>
  header
    ?.split(",")
    .some(
      (candidate) =>
        candidate.trim() === "*" ||
        candidate.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""),
    ) === true;

/**
 * The single byte range a request asks for, as RFC 9110 reads `Range`: `undefined` serves the
 * whole file, including for ranges this host does not support, such as several at once.
 */
const requestedRange = (
  header: string | undefined,
  ifRange: string | undefined,
  etag: string,
  size: number,
) => {
  if (header === undefined || (ifRange !== undefined && ifRange.trim() !== etag)) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (match === null) return undefined;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return undefined;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable" as const;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size) return "unsatisfiable" as const;
  if (end < start) return undefined;
  return { start, end };
};

/**
 * Stream a stored file. Its ETag names its exact bytes, so a conditional request needs no read.
 * Single byte ranges are served for media seeking and resumed downloads.
 */
const storedFile = (file: AppUiStoredFile, cacheControl: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const etag = `"${file.etag}"`;
    const headers = {
      ...appPrivateHeaders,
      "cache-control": cacheControl,
      vary: "Cookie",
      etag,
      "accept-ranges": "bytes",
    };
    if (etagMatches(request.headers["if-none-match"], etag))
      return HttpServerResponse.empty({ status: 304, headers });
    const range = requestedRange(
      request.headers.range,
      request.headers["if-range"],
      etag,
      file.size,
    );
    if (range === "unsatisfiable")
      return HttpServerResponse.empty({
        status: 416,
        headers: { ...headers, "content-range": `bytes */${file.size}` },
      });
    const length = range === undefined ? file.size : range.end - range.start + 1;
    const body = yield* file.read(
      range === undefined ? undefined : { offset: range.start, length },
    );
    return HttpServerResponse.stream(body, {
      status: range === undefined ? 200 : 206,
      contentType: file.contentType,
      contentLength: length,
      headers:
        range === undefined
          ? headers
          : { ...headers, "content-range": `bytes ${range.start}-${range.end}/${file.size}` },
    });
  });

/** Serve an asset only after the host has checked current access and file existence.
 * Asset URLs name their deployment, so their bytes never change: the browser keeps them for a year
 * and does not ask again. Shared proxies never store them. Revoking access stops every new request
 * and all app data, while bytes a browser already downloaded stay in its cache.
 * HTML remains an uncached host-rendered entry point; other HTML files are served as they are.
 */
export const appAsset = (asset: AppUiAsset | undefined, build: string, path: string) =>
  Effect.gen(function* () {
    if (asset === undefined || path === "index.html")
      return HttpServerResponse.empty({ status: 404, headers: appPrivateHeaders });
    const immutable = "private, max-age=31536000, immutable";
    if (!("body" in asset)) return yield* storedFile(asset, immutable);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const etag = `W/"${encodeURIComponent(build)}/${encodeURIComponent(path)}"`;
    const headers = {
      ...appPrivateHeaders,
      "cache-control": immutable,
      vary: "Cookie",
      etag,
    };
    return etagMatches(request.headers["if-none-match"], etag)
      ? HttpServerResponse.empty({ status: 304, headers })
      : HttpServerResponse.uint8Array(asset.body, { contentType: asset.contentType, headers });
  });
