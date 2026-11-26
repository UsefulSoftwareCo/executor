import { Effect, Option, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http";
import { dashboardRoutes, fileHeaders } from "../web.ts";
import { BlobKey, BlobStoreError, SourceError, type BlobStorage } from "@executor-js/sdk/core";
import { pageOf, rangeWindow, removeEach, windowed } from "@executor-js/sdk/blobs";
import { gitRepositories } from "@executor-js/app-source/host";
import {
  parseDestination,
  isLoopbackHostname,
  type UrlPolicy,
} from "@executor-js/utils/url-policy";

export interface HttpBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}
const diskRequest = (key: BlobKey, init?: RequestInit) =>
  new Request(`http://disk.internal/${key.split("/").map(encodeURIComponent).join("/")}`, init);

const DirectoryListing = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

export const bindingBlobStore = (disk: HttpBinding): BlobStorage => {
  const send = (
    operation: BlobStoreError["operation"],
    key: BlobKey,
    expected: ReadonlyArray<number>,
    init?: RequestInit,
  ) =>
    Effect.tryPromise({
      try: () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        return disk.fetch(diskRequest(key, init));
      },
      catch: (cause) => new BlobStoreError({ operation, cause }),
    }).pipe(
      Effect.filterOrFail(
        (response) => expected.includes(response.status),
        (response) => new BlobStoreError({ operation, status: response.status }),
      ),
    );
  return {
    get: (key) =>
      send("get", key, [200, 404]).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeedNone
            : Effect.tryPromise({
                try: () => response.arrayBuffer(),
                catch: (cause) => new BlobStoreError({ operation: "get", cause }),
              }).pipe(Effect.map((bytes) => Option.some(new Uint8Array(bytes)))),
        ),
      ),
    exists: (key) =>
      send("exists", key, [200, 404], { method: "HEAD" }).pipe(
        Effect.map((response) => response.status === 200),
      ),
    put: (key, body) =>
      send("put", key, [204], { method: "PUT", body: new Uint8Array(body) }).pipe(Effect.asVoid),
    remove: (key) => send("remove", key, [204, 404], { method: "DELETE" }).pipe(Effect.asVoid),
    removeAll: (keys) =>
      removeEach(keys, (key) =>
        send("remove", key, [204, 404], { method: "DELETE" }).pipe(Effect.asVoid),
      ),
    list: (folder, options) =>
      send("list", folder, [200, 404]).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed([])
            : Effect.tryPromise(() => response.json()).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(DirectoryListing)),
                Effect.mapError((cause) => new BlobStoreError({ operation: "list", cause })),
              ),
        ),
        Effect.map((entries) =>
          pageOf(
            entries.filter((entry) => entry.type === "file").map((entry) => entry.name),
            options,
          ),
        ),
      ),
    stream: (key, range) =>
      Effect.gen(function* () {
        const response = yield* send("get", key, [200, 404]);
        if (response.status === 404) return Option.none();
        const readable = response.body;
        const size = Number(response.headers.get("content-length"));
        if (readable === null || !Number.isSafeInteger(size))
          return yield* new BlobStoreError({ operation: "get" });
        const { start, end } = rangeWindow(size, range);
        const body = Stream.fromReadableStream({
          evaluate: () => readable,
          onError: (cause) => new BlobStoreError({ operation: "get", cause }),
        });
        return Option.some({
          size,
          body: start === 0 && end === size ? body : windowed(body, start, end),
        });
      }),
  };
};

const GitResult = Schema.Struct({ code: Schema.Int, output: Schema.Uint8ArrayFromBase64 });
const Index = Schema.Struct({ index: Schema.NonEmptyString });

export const bindingRepositories = (binding: HttpBinding, directory: string) => {
  const call = (path: string, body: unknown) =>
    Effect.tryPromise({
      try: async () => {
        const response = await binding.fetch(
          new Request(`http://native.internal${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        if (!response.ok) throw new Error("Native Git request failed");
        return response.json();
      },
      catch: () => new SourceError({ reason: "git" }),
    });
  return gitRepositories({
    directory,
    git: (args, input, environment) =>
      Schema.encodeEffect(Schema.Uint8ArrayFromBase64)(input ?? new Uint8Array()).pipe(
        Effect.flatMap((input) => call("/git", { args, input, environment: environment ?? {} })),
        Effect.flatMap(Schema.decodeUnknownEffect(GitResult)),
        Effect.mapError(() => new SourceError({ reason: "git" })),
      ),
    httpBackend: (environment, body) =>
      Effect.tryPromise({
        try: async () => {
          const response = await binding.fetch(
            new Request("http://native.internal/git/http-backend", {
              method: "POST",
              headers: { "executor-git-environment": JSON.stringify(environment) },
              body,
            }),
          );
          if (!response.ok || response.body === null) throw new Error("Native Git request failed");
          return response.body;
        },
        catch: () => new SourceError({ reason: "git" }),
      }),
    createDirectory: (path) => call("/git/directory", { path }).pipe(Effect.asVoid),
    temporaryIndex: Effect.acquireRelease(
      call("/git/index", {}).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Index)),
        Effect.mapError(() => new SourceError({ reason: "git" })),
      ),
      ({ index }) => call("/git/index/remove", { index }).pipe(Effect.orDie),
    ).pipe(Effect.map(({ index }) => index)),
  });
};

export const bindingHttpClient = (
  policy: UrlPolicy,
  publicNetwork: HttpBinding,
  privateNetwork: HttpBinding,
  self: { readonly origin: string; readonly binding: HttpBinding },
) =>
  Effect.gen(function* () {
    const selfOrigin = new URL(self.origin).origin;
    const checkedFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (URL.parse(url)?.origin === selfOrigin)
        return self.binding.fetch(new Request(input, { ...init, redirect: "manual" }));
      const destination = parseDestination(url, policy);
      if (destination === undefined) throw new Error("Requested destination refused");
      const network =
        (policy.allowLoopbackHttp && isLoopbackHostname(destination.hostname)) ||
        policy.allowedHttpOrigins.some((origin) => origin === destination.origin)
          ? privateNetwork
          : publicNetwork;
      return network.fetch(new Request(input, { ...init, redirect: "manual" }));
    };
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return client.pipe(
      HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, checkedFetch)),
    );
  });

export const collectorOrigin = "http://collector.internal";

export const bindingTelemetryClient = (collector: HttpBinding) =>
  Effect.gen(function* () {
    const routedFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      return URL.parse(request.url)?.origin === collectorOrigin
        ? collector.fetch(request)
        : fetch(request);
    };
    const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
    return client.pipe(
      HttpClient.transformResponse(Effect.provideService(FetchHttpClient.Fetch, routedFetch)),
    );
  });

export const bindingDashboard = (assets: HttpBinding, files: Readonly<Record<string, string>>) =>
  dashboardRoutes(new Set(Object.keys(files)), (relative) =>
    Effect.tryPromise(() =>
      assets.fetch(
        new Request(
          `http://assets.internal/${relative.split("/").map(encodeURIComponent).join("/")}`,
        ),
      ),
    ).pipe(
      Effect.map((response) =>
        HttpServerResponse.fromWeb(response).pipe(
          HttpServerResponse.setHeaders({
            "content-type": files[relative] ?? "application/octet-stream",
            ...fileHeaders(relative),
          }),
        ),
      ),
    ),
  );
