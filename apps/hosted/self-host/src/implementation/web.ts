import { dashboardDocument } from "@executor-js/dashboard-start/document";
import type { DocumentApi } from "@executor-js/dashboard-start/document-api";
import { hostedDocumentContext } from "@executor-js/hosted-server/document";
import { SignInSettings } from "@executor-js/hosted-self-host-web/document";
import { singleResourceOrigin, type ResourceOrigins } from "@executor-js/mcp-auth/grants";
import { Config, Effect, FileSystem, Path, Result, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

const signInSettingsDeadline = "2 seconds";

export const selfHostDocumentContext = (resourceOrigins: ResourceOrigins) => (api: DocumentApi) =>
  Effect.gen(function* () {
    const document = yield* hostedDocumentContext(resourceOrigins)(api);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const { pathname } = new URL(request.url, "http://localhost");
    if (pathname !== "/login" && pathname !== "/login/") return { ...document, signIn: null };
    const signIn = yield* Effect.tryPromise((signal) =>
      api.apiFetch("/api/auth/self-host/config", { signal }).then((response) => response.json()),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SignInSettings)),
      Effect.timeout(signInSettingsDeadline),
      Effect.tapError((error) => Effect.logWarning("Sign-in settings unavailable", error)),
      Effect.orElseSucceed(() => null),
      Effect.withSpan("dashboard.sign-in-settings"),
    );
    return { ...document, signIn };
  });

const document = dashboardDocument({
  server: Effect.promise(() => import("@executor-js/hosted-self-host-web/server")).pipe(
    Effect.map((module) => module.default),
  ),
  context: (api) =>
    Config.String("BETTER_AUTH_URL").pipe(
      Effect.flatMap((origin) => selfHostDocumentContext(singleResourceOrigin(origin))(api)),
    ),
});

export const fileHeaders = (relative: string) => ({
  "cache-control": /^assets\/[^/]+-[\w-]{8}\.[a-z\d]+$/i.test(relative)
    ? "public, max-age=31536000, immutable"
    : "no-cache",
  "x-content-type-options": "nosniff",
});

export const dashboardRoutes = <E, R>(
  files: ReadonlySet<string>,
  file: (relative: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const decoded = yield* Effect.try(() =>
      decodeURIComponent(new URL(request.url, "http://localhost").pathname),
    ).pipe(Effect.result);
    if (Result.isFailure(decoded)) return HttpServerResponse.empty({ status: 400 });
    const pathname = decoded.success;
    if (
      /^\/(api|\.well-known)(\/|$)/.test(pathname) ||
      pathname === "/mcp" ||
      pathname === "/health" ||
      pathname === "/openapi.json"
    )
      return HttpServerResponse.empty({ status: 404 });
    const relative = pathname.slice(1);
    if (files.has(relative)) return yield* file(relative);
    if (relative.startsWith("assets/") || relative.includes("."))
      return HttpServerResponse.empty({ status: 404 });
    return yield* document;
  });

export const dashboardFiles = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const client = path.join(directory, "client");
    yield* fs.access(path.join(directory, "server", "server.js"));
    const names = yield* fs.readDirectory(client, { recursive: true });
    const files = new Set(
      (yield* Effect.forEach(
        names,
        (name) =>
          fs
            .stat(path.join(client, name))
            .pipe(
              Effect.map((info) =>
                info.type === "File" && !name.split(path.sep).some((part) => part.startsWith("."))
                  ? [name.split(path.sep).join("/")]
                  : [],
              ),
            ),
        { concurrency: 16 },
      )).flat(),
    );
    return dashboardRoutes(files, (relative) =>
      HttpServerResponse.file(path.join(client, relative), { headers: fileHeaders(relative) }),
    );
  });
