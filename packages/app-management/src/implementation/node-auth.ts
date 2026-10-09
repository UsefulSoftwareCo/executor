import { homedir } from "node:os";
import { lock } from "proper-lockfile";
/** CLI OAuth and OS credential-store adapter. Credentials never enter repositories or config files. */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Console,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { Base64Url, Hex } from "effect/encoding";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { NetAddress } from "effect/net";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { AppClientError } from "../client-error.ts";

/**
 * Credential-bearing traffic is permitted only over TLS or to loopback development hosts,
 * including `*.localhost` (RFC 6761), where a local Cloud serves its role hosts.
 */
export const RegistryOrigin = Schema.String.check(
  Schema.makeFilter((input) => {
    try {
      const url = new URL(input);
      return (
        url.origin === input &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
              url.hostname.endsWith(".localhost"))))
      );
    } catch {
      return false;
    }
  }),
);
const Token = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Number,
});
const Session = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  organization: Schema.String,
  namespace: Schema.String,
  /**
   * Other origins where the host that issued this session serves Git, from its context at
   * sign-in. Absent for sessions saved before the host named them, and for hosts that serve Git
   * only on their own origin.
   */
  gitOrigins: Schema.optional(Schema.Array(Schema.String)),
});
const authError = () => new AppClientError({ reason: "authentication" });
// Loaded lazily so a native binding that cannot load fails here instead of at process start.
const entry = (host: string) =>
  Effect.tryPromise({
    try: async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry("Executor Registry", host);
    },
    catch: authError,
  });
/**
 * Which signed-in host a Git origin's remotes use. It holds an origin, never a credential, and
 * {@link gitSession} accepts it only when that host's own session names the Git origin.
 */
const gitEntry = (origin: string) =>
  Effect.tryPromise({
    try: async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry("Executor Registry Git", origin);
    },
    catch: authError,
  });
/** Read a JSON response from the Executor host; redirects fail rather than carry credentials. */
const fetchJson = <A>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Decoder<A>) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(authError),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provide(FetchHttpClient.layer),
  );
const request = <A>(url: string, body: URLSearchParams | object, schema: Schema.Decoder<A>) =>
  body instanceof URLSearchParams
    ? fetchJson(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(body)), schema)
    : HttpClientRequest.bodyJson(HttpClientRequest.post(url), body).pipe(
        Effect.mapError(authError),
        Effect.flatMap((request) => fetchJson(request, schema)),
      );
const Endpoint = Schema.String.check(
  Schema.makeFilter((input) => Schema.is(RegistryOrigin)(URL.parse(input)?.origin ?? "")),
);
/**
 * Find the host's API resource and its authorization server, as RFC 9728 and RFC 8414 clients
 * do: the resource names its issuer, and the issuer's own origin serves the endpoints, which may
 * be on another host than the API (hosted Executor's are). The issuer must match exactly.
 */
const discover = (host: string) =>
  Effect.gen(function* () {
    const protectedResource = yield* fetchJson(
      HttpClientRequest.get(`${host}/.well-known/oauth-protected-resource/api`),
      Schema.Struct({
        resource: Schema.String,
        authorization_servers: Schema.NonEmptyArray(Endpoint),
      }),
    );
    if (protectedResource.resource !== `${host}/api`) return yield* authError();
    const issuer = protectedResource.authorization_servers[0];
    const issuerUrl = new URL(issuer);
    const metadata = yield* fetchJson(
      HttpClientRequest.get(
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, "")}`,
      ),
      Schema.Struct({
        issuer: Schema.String,
        authorization_endpoint: Endpoint,
        token_endpoint: Endpoint,
        registration_endpoint: Endpoint,
      }),
    );
    if (metadata.issuer !== issuer) return yield* authError();
    return {
      resource: protectedResource.resource,
      authorization: metadata.authorization_endpoint,
      token: metadata.token_endpoint,
      registration: metadata.registration_endpoint,
    };
  });
const save = (host: string, session: typeof Session.Type) =>
  Effect.gen(function* () {
    const store = yield* entry(host);
    yield* Effect.tryPromise({
      try: (signal) => store.setPassword(JSON.stringify(session), signal),
      catch: authError,
    });
  });

/** Serialize refresh and replacement across Git helper processes; the lock contains no credentials. */
const withSessionLock = <A, E, R>(host: string, work: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(homedir(), ".local", "state", "executor", "auth");
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const key = yield* Effect.tryPromise({
        try: async () =>
          Hex.encode(
            new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(host))),
          ),
        catch: authError,
      });
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            lock(directory, {
              lockfilePath: path.join(directory, `${key}.lock`),
              stale: 30000,
              retries: { retries: 12, minTimeout: 100, maxTimeout: 1000 },
            }),
          catch: authError,
        }),
        (release) => Effect.promise(() => release()),
      );
      return yield* work;
    }),
  ).pipe(Effect.catchTag("PlatformError", authError));

/** Read and refresh one explicitly selected organization grant. The OS store owns refresh-token custody. */
export const registrySession = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const store = yield* entry(host);
      const raw = yield* Effect.tryPromise({
        try: (signal) => store.getPassword(signal),
        catch: authError,
      });
      if (raw === null) return yield* authError();
      const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(raw).pipe(
        Effect.mapError(authError),
      );
      if (saved.expiresAt > Date.now() + 60000) return Redacted.make(saved);
      const endpoints = yield* discover(host);
      const fresh = yield* request(
        endpoints.token,
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: saved.clientId,
          refresh_token: saved.refreshToken,
        }),
        Token,
      );
      const session = {
        ...saved,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token,
        expiresAt: Date.now() + fresh.expires_in * 1000,
      };
      yield* save(host, session);
      return Redacted.make(session);
    }),
  );

/**
 * The session for Git remotes on `origin`. Hosted Executor serves Git on other origins than its
 * API (`executor.sh` beside `api.executor.sh`), so sign-in records which host's session each of
 * them uses, and that session must still name the origin. Otherwise a session signed in at
 * `origin` itself is used, as on hosts that serve Git beside their API.
 */
export const gitSession = (origin: string) =>
  Effect.gen(function* () {
    const store = yield* gitEntry(origin);
    const signedIn = yield* Effect.tryPromise({
      try: (signal) => store.getPassword(signal),
      catch: authError,
    });
    const host = signedIn ?? origin;
    const session = yield* registrySession(host);
    if (host !== origin && !(Redacted.value(session).gitOrigins ?? []).includes(origin))
      return yield* authError();
    return session;
  });

/** Browser authorization-code flow with PKCE, an exact loopback callback, and an unpredictable state. */
export const registryLogin = (host: string, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const completed = yield* Deferred.make<string, AppClientError>();
      const state = crypto.randomUUID();
      const verifier =
        crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      const challenge = yield* Effect.tryPromise({
        try: async () =>
          Base64Url.encode(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
            ),
          ),
        catch: authError,
      });
      const callback = HttpRouter.add(
        "GET",
        "/callback",
        Effect.gen(function* () {
          const incoming = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(incoming.url, "http://127.0.0.1");
          if (url.searchParams.get("state") !== state)
            return HttpServerResponse.text("Invalid sign-in state.", { status: 400 });
          const code = url.searchParams.get("code");
          if (code === null || url.searchParams.has("error")) {
            yield* Deferred.fail(completed, authError());
            return HttpServerResponse.text("Sign-in was cancelled.", { status: 400 });
          }
          yield* Deferred.succeed(completed, code);
          return HttpServerResponse.text("Executor is connected. You can close this window.", {
            headers: { "cache-control": "no-store" },
          });
        }),
      );
      const listener = createServer();
      const services = yield* Layer.build(
        HttpRouter.serve(callback, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(() => listener, {
              host: "127.0.0.1",
              port: 0,
              gracefulShutdownTimeout: 1000,
            }),
          ),
        ),
      );
      // Closing the server waits for every connection, and a browser may hold one it opened but
      // never sent a request on (a raced spare), which Node keeps until its headers timeout, 60
      // seconds or more. Nothing more is served once sign-in ends, so drop them all first.
      yield* Effect.addFinalizer(() => Effect.sync(() => listener.closeAllConnections()));
      const server = Context.get(services, HttpServer.HttpServer);
      if (!NetAddress.isInetAddress(server.address)) return yield* authError();
      const redirect = `http://127.0.0.1:${server.address.port}/callback`;
      const endpoints = yield* discover(host);
      const client = yield* request(
        endpoints.registration,
        {
          client_name: "Executor CLI",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "executor offline_access",
        },
        Schema.Struct({ client_id: Schema.NonEmptyString }),
      );
      const authorization = new URL(endpoints.authorization);
      authorization.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "executor offline_access",
        resource: endpoints.resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      }).toString();
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command =
        platform === "darwin"
          ? ChildProcess.make("open", [authorization.href])
          : platform === "win32"
            ? ChildProcess.make("rundll32", ["url.dll,FileProtocolHandler", authorization.href])
            : ChildProcess.make("xdg-open", [authorization.href]);
      const opened = yield* spawner.exitCode(command);
      if (Number(opened) !== 0) return yield* authError();
      yield* Console.error("Finish signing in and select an organization in your browser.");
      const code = yield* Deferred.await(completed).pipe(Effect.timeout("10 minutes"));
      const token = yield* request(
        endpoints.token,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: redirect,
          code,
          code_verifier: verifier,
          resource: endpoints.resource,
        }),
        Token,
      );
      const context = yield* fetchJson(
        HttpClientRequest.get(`${host}/api/context`).pipe(
          HttpClientRequest.bearerToken(token.access_token),
        ),
        Schema.Struct({
          organization: Schema.String,
          slug: Schema.String,
          // Hosts released before this field serve Git only on their own origin.
          gitOrigins: Schema.optional(Schema.Array(RegistryOrigin)),
        }),
      );
      const gitOrigins = (context.gitOrigins ?? []).filter((origin) => origin !== host);
      yield* withSessionLock(
        host,
        Effect.gen(function* () {
          yield* save(host, {
            clientId: client.client_id,
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: Date.now() + token.expires_in * 1000,
            organization: context.organization,
            namespace: context.slug,
            gitOrigins,
          });
          for (const origin of gitOrigins) {
            const store = yield* gitEntry(origin);
            yield* Effect.tryPromise({
              try: (signal) => store.setPassword(host, signal),
              catch: authError,
            });
          }
        }),
      );
      yield* Console.log(`Connected to ${host} as @${context.slug}.`);
    }),
  ).pipe(Effect.mapError(authError));
