import { homedir } from "node:os";
import { lock } from "proper-lockfile";
/** CLI OAuth and OS credential-store adapter. Credentials never enter repositories or config files. */
import { createServer } from "node:http";
import { AsyncEntry } from "@napi-rs/keyring";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Console,
  Context,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Encoding,
  Layer,
  Redacted,
  Schema,
} from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { NetAddress } from "effect/unstable/net";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { AppClientError } from "../client-error.ts";

/** Credential-bearing traffic is permitted only over TLS or to loopback development hosts. */
export const RegistryOrigin = Schema.String.check(
  Schema.makeFilter((input) => {
    try {
      const url = new URL(input);
      return (
        url.origin === input &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
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
});
const authError = () => new AppClientError({ reason: "authentication" });
const entry = (host: string) =>
  Effect.try({ try: () => new AsyncEntry("Executor Registry", host), catch: authError });
const request = <A>(url: string, body: URLSearchParams | object, schema: Schema.Decoder<A>) =>
  Effect.tryPromise({
    try: async (signal) => {
      const form = body instanceof URLSearchParams;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        },
        body: form ? body : JSON.stringify(body),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error("OAuth request failed");
      return response.json();
    },
    catch: authError,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)), Effect.mapError(authError));
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
          Encoding.encodeHex(
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
      const fresh = yield* request(
        `${host}/api/auth/oauth2/token`,
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
          Encoding.encodeBase64Url(
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
      const services = yield* Layer.build(
        HttpRouter.serve(callback, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(createServer, {
              host: "127.0.0.1",
              port: 0,
              gracefulShutdownTimeout: 1000,
            }),
          ),
        ),
      );
      const server = Context.get(services, HttpServer.HttpServer);
      if (!NetAddress.isInetAddress(server.address)) return yield* authError();
      const redirect = `http://127.0.0.1:${server.address.port}/callback`;
      const client = yield* request(
        `${host}/api/auth/oauth2/register`,
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
      const authorization = new URL(`${host}/api/auth/oauth2/authorize`);
      authorization.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: "executor offline_access",
        resource: `${host}/api`,
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
        `${host}/api/auth/oauth2/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: redirect,
          code,
          code_verifier: verifier,
          resource: `${host}/api`,
        }),
        Token,
      );
      const context = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${host}/api/context`, {
            headers: { authorization: `Bearer ${token.access_token}` },
            signal,
            redirect: "error",
          });
          if (!response.ok) throw new Error("Context unavailable");
          return response.json();
        },
        catch: authError,
      }).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Struct({ organization: Schema.String, slug: Schema.String }),
          ),
        ),
        Effect.mapError(authError),
      );
      yield* withSessionLock(
        host,
        save(host, {
          clientId: client.client_id,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
          organization: context.organization,
          namespace: context.slug,
        }),
      );
      yield* Console.log(`Connected to ${host} as @${context.slug}.`);
    }),
  ).pipe(Effect.mapError(authError));
