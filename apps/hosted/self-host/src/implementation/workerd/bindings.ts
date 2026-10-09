/** Host bindings exist only on the trusted product Worker, never on authored app isolates. */
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpServerResponse } from "effect/http";
import { dashboardRoutes, fileHeaders } from "../web.ts";
import { BlobKey, BlobStoreError, SourceError, type BlobStorage } from "@executor-js/sdk/core";
import { gitRepositories } from "@executor-js/app-source/host";
import {
  parseDestination,
  isLoopbackHostname,
  type UrlPolicy,
} from "@executor-js/utils/url-policy";

/** The HTTP service capability workerd supplies at its environment boundary. */
export interface HttpBinding {
  readonly fetch: (request: Request) => Promise<Response>;
}
const diskRequest = (key: BlobKey, init?: RequestInit) =>
  new Request(`http://disk.internal/${key.split("/").map(encodeURIComponent).join("/")}`, init);

/** workerd disk PUT atomically publishes an object; missing files remain ordinary results. */
export const bindingBlobStore = (disk: HttpBinding): BlobStorage => ({
  get: (key) =>
    Effect.tryPromise({
      try: async () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        const response = await disk.fetch(diskRequest(key));
        if (response.status === 404) return Option.none<Uint8Array>();
        if (response.status !== 200) throw new Error("Blob read failed");
        return Option.some(new Uint8Array(await response.arrayBuffer()));
      },
      catch: () => new BlobStoreError({ operation: "get" }),
    }),
  exists: (key) =>
    Effect.tryPromise({
      try: async () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        const response = await disk.fetch(diskRequest(key, { method: "HEAD" }));
        if (response.status === 404) return false;
        if (response.status !== 200) throw new Error("Blob lookup failed");
        return true;
      },
      catch: () => new BlobStoreError({ operation: "exists" }),
    }),
  put: (key, body) =>
    Effect.tryPromise({
      try: async () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        const response = await disk.fetch(
          diskRequest(key, { method: "PUT", body: new Uint8Array(body) }),
        );
        if (response.status !== 204) throw new Error("Blob write failed");
      },
      catch: () => new BlobStoreError({ operation: "put" }),
    }),
  remove: (key) =>
    Effect.tryPromise({
      try: async () => {
        Schema.decodeUnknownSync(BlobKey)(key);
        const response = await disk.fetch(diskRequest(key, { method: "DELETE" }));
        if (response.status !== 204 && response.status !== 404)
          throw new Error("Blob removal failed");
      },
      catch: () => new BlobStoreError({ operation: "remove" }),
    }),
});

const GitResult = Schema.Struct({ code: Schema.Int, output: Schema.Uint8ArrayFromBase64 });
const Index = Schema.Struct({ index: Schema.NonEmptyString });

/** Preserve the shared Git operations while a small native helper owns processes and indexes. */
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

/**
 * DNS restrictions are enforced by workerd's network service at connection time. Requests for
 * this instance's own dashboard origin go to the product through a service binding instead,
 * whatever that origin's name resolves to.
 */
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

/** Serve only the build's asset manifest; a disk directory listing can never become a public page. */
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
