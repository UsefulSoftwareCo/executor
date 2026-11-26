import { homedir } from "node:os";
import { lock } from "proper-lockfile";
import {
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  AppClientError,
  HostRequestFailed,
  LoginFailed,
  SignInStateInvalid,
} from "../client-error.ts";

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
const AppManagement = Schema.Struct({
  organization: Schema.String,
  gitOrigins: Schema.Array(Schema.String),
});
const ToolsSession = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  resource: Schema.String,
  appManagement: Schema.optional(AppManagement),
});
export type ToolsSession = typeof ToolsSession.Type;
const authError = () => new AppClientError({ reason: "authentication" });
const authDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(homedir(), ".local", "state", "executor", "auth");
});
const digest = (input: string) =>
  Effect.tryPromise({
    try: async () =>
      Hex.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))),
      ),
    catch: authError,
  });
const retiredAppSignInService = "Executor Registry";
const toolsService = "Executor Tools";
const gitService = "Executor Registry Git";
const osEntry = (service: string, account: string) =>
  Effect.tryPromise({
    try: async () => {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(service, account);
    },
    catch: authError,
  }).pipe(Effect.option);
const credentialFile = (service: string, account: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* authDirectory;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${yield* digest(`${service}\n${account}`)}.json`);
  });
const readCredential = (service: string, account: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const os = yield* osEntry(service, account);
    if (Option.isSome(os)) {
      const stored = yield* Effect.tryPromise({
        try: (signal) => os.value.getPassword(signal),
        catch: authError,
      }).pipe(Effect.option);
      if (Option.isSome(stored) && typeof stored.value === "string") return stored.value;
    }
    const file = yield* credentialFile(service, account);
    return (yield* fs.exists(file)) ? yield* fs.readFileString(file) : undefined;
  }).pipe(Effect.catchTag("PlatformError", authError));
const writeCredential = (service: string, account: string, value: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* credentialFile(service, account);
    const os = yield* osEntry(service, account);
    const inOsStore = Option.isSome(os)
      ? yield* Effect.tryPromise({
          try: (signal) => os.value.setPassword(value, signal),
          catch: authError,
        }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : false;
    if (inOsStore) {
      yield* fs.remove(file, { force: true });
      return Option.none<string>();
    }
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, value, { mode: 0o600 });
    yield* fs.rename(temporary, file);
    return Option.some(file);
  }).pipe(Effect.catchTag("PlatformError", authError));
const deleteCredential = (service: string, account: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const os = yield* osEntry(service, account);
    if (Option.isSome(os))
      yield* Effect.tryPromise({
        try: (signal) => os.value.deletePassword(signal),
        catch: authError,
      }).pipe(Effect.ignore);
    yield* fs.remove(yield* credentialFile(service, account), { force: true });
    if ((yield* readCredential(service, account)) !== undefined) return yield* authError();
  }).pipe(Effect.catchTag("PlatformError", authError));
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
const isMcpResource = (resource: string) => {
  const url = URL.parse(resource);
  return (
    url !== null &&
    Schema.is(RegistryOrigin)(url.origin) &&
    url.pathname === "/mcp" &&
    url.search === "" &&
    url.hash === ""
  );
};
/**
 * Find the host's MCP resource and its authorization server, as RFC 9728 and RFC 8414 clients
 * do: the resource names its issuer, and the issuer's own origin serves the endpoints, which may
 * be on another host than the API (hosted Executor's are). The issuer must match exactly. The
 * resource is the `/mcp` endpoint the host names.
 */
const discover = (host: string) =>
  Effect.gen(function* () {
    const protectedResource = yield* fetchJson(
      HttpClientRequest.get(`${host}/.well-known/oauth-protected-resource/mcp`),
      Schema.Struct({
        resource: Schema.String,
        authorization_servers: Schema.NonEmptyArray(Endpoint),
      }),
    );
    if (!isMcpResource(protectedResource.resource)) return yield* authError();
    const issuer = protectedResource.authorization_servers[0];
    const issuerUrl = new URL(issuer);
    const metadata = yield* fetchJson(
      HttpClientRequest.get(
        `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/$/, "")}`,
      ),
      Schema.Struct({
        issuer: Schema.String,
        token_endpoint: Endpoint,
        registration_endpoint: Endpoint,
        // RFC 8628; hosts released before device sign-in do not advertise it.
        device_authorization_endpoint: Schema.optional(Endpoint),
      }),
    );
    if (metadata.issuer !== issuer) return yield* authError();
    return {
      resource: protectedResource.resource,
      token: metadata.token_endpoint,
      registration: metadata.registration_endpoint,
      device: metadata.device_authorization_endpoint,
    };
  });
export const mcpResource = (host: string) =>
  Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
    Effect.mapError(authError),
    Effect.andThen(discover(host)),
    Effect.map(({ resource }) => resource),
  );
const withSessionLock = <A, E, R>(host: string, work: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* authDirectory;
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const key = yield* digest(host);
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

export const sessionRefreshMarginMs = 60_000;

const refreshDue = (host: string, saved: ToolsSession) =>
  Effect.gen(function* () {
    if (saved.expiresAt > Date.now() + sessionRefreshMarginMs) return Option.none<ToolsSession>();
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
    return Option.some({
      ...saved,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresAt: Date.now() + fresh.expires_in * 1000,
    });
  });

const readToolsSession = (host: string) =>
  Effect.gen(function* () {
    const raw = yield* readCredential(toolsService, host);
    if (raw === undefined) return Option.none<ToolsSession>();
    return Option.some(
      yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ToolsSession))(raw).pipe(
        Effect.mapError(authError),
      ),
    );
  });

export const toolsSession = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const saved = yield* readToolsSession(host);
      if (Option.isNone(saved)) return yield* authError();
      const fresh = yield* refreshDue(host, saved.value);
      if (Option.isNone(fresh)) return Redacted.make(saved.value);
      yield* writeCredential(toolsService, host, JSON.stringify(fresh.value));
      return Redacted.make(fresh.value);
    }),
  );

const contextRequest = { method: "GET", path: "/api/context" };
const ContextAnswer = Schema.Struct({
  organization: Schema.String,
  gitOrigins: Schema.optional(Schema.Array(RegistryOrigin)),
});
const readAppManagement = (host: string, accessToken: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(`${host}${contextRequest.path}`).pipe(
        HttpClientRequest.bearerToken(accessToken),
      ),
    ).pipe(Effect.mapError(() => new HostRequestFailed({ reason: "network", ...contextRequest })));
    const { status } = response;
    if (status === 401) return yield* authError();
    if (status === 403) return yield* new AppClientError({ reason: "forbidden" });
    if (status !== 200)
      return yield* new HostRequestFailed({ reason: "status", ...contextRequest, status });
    const context = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ContextAnswer)),
      Effect.mapError(
        () => new HostRequestFailed({ reason: "response", ...contextRequest, status }),
      ),
    );
    return {
      organization: context.organization,
      gitOrigins: (context.gitOrigins ?? []).filter((origin) => origin !== host),
    } satisfies typeof AppManagement.Type;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new HostRequestFailed({ reason: "network", ...contextRequest })),
    }),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provide(FetchHttpClient.layer),
  );

const saveWithAppManagement = (host: string, session: ToolsSession) =>
  Effect.gen(function* () {
    const file = yield* writeCredential(toolsService, host, JSON.stringify(session));
    for (const origin of session.appManagement?.gitOrigins ?? [])
      yield* writeCredential(gitService, origin, host);
    return file;
  });

export const appManagementSession = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const saved = yield* readToolsSession(host);
      if (Option.isNone(saved)) return yield* authError();
      const refreshed = yield* refreshDue(host, saved.value);
      if (Option.isSome(refreshed))
        yield* writeCredential(toolsService, host, JSON.stringify(refreshed.value));
      const current = Option.getOrElse(refreshed, () => saved.value);
      const appManagement =
        current.appManagement ?? (yield* readAppManagement(host, current.accessToken));
      if (current.appManagement === undefined)
        yield* saveWithAppManagement(host, { ...current, appManagement });
      return Redacted.make({
        accessToken: current.accessToken,
        expiresAt: current.expiresAt,
        ...appManagement,
      });
    }),
  );

export const gitSession = (origin: string) =>
  Effect.gen(function* () {
    const named = yield* readCredential(gitService, origin);
    const signedInAtOrigin = (yield* readCredential(toolsService, origin)) !== undefined;
    const lastSignedIn = yield* rememberedHost.pipe(
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    const host =
      named ?? (signedInAtOrigin ? origin : Option.getOrElse(lastSignedIn, () => origin));
    const session = yield* appManagementSession(host);
    return host === origin || Redacted.value(session).gitOrigins.includes(origin)
      ? Option.some(session)
      : Option.none();
  });

const scope = "mcp offline_access";
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
type Endpoints = Effect.Success<ReturnType<typeof discover>>;
const fail = (reason: LoginFailed["reason"]) => () => new LoginFailed({ reason });
const TokenError = Schema.Struct({ error: Schema.String });
const retryAfter = (headers: Readonly<Record<string, string | undefined>>) => {
  const seconds = Number(headers["retry-after"] ?? headers["x-retry-after"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

const browserReachable = (platform: string) =>
  Effect.gen(function* () {
    const variable = (name: string) =>
      Config.String(name).pipe(Config.option, Config.map(Option.isSome));
    const remote = (yield* variable("SSH_CONNECTION")) || (yield* variable("SSH_TTY"));
    const display = (yield* variable("DISPLAY")) || (yield* variable("WAYLAND_DISPLAY"));
    return !remote && (platform !== "linux" || display);
  }).pipe(Effect.orElseSucceed(() => false));

const openBrowser = (platform: string, url: string) =>
  Effect.gen(function* () {
    if (!(yield* browserReachable(platform))) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [opener, ...args] =
      platform === "darwin"
        ? ["open", url]
        : platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url];
    const command = ChildProcess.make(opener, args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    yield* Effect.scoped(spawner.spawn(command).pipe(Effect.flatMap((child) => child.unref))).pipe(
      Effect.ignore,
    );
  });

/**
 * RFC 8628 device authorization: register a public client, print where to approve and the code,
 * open that page when a browser can, then poll the token endpoint at the host's interval, slowing
 * down when asked, until approval, denial or expiry.
 */
const deviceLogin = (endpoints: Endpoints, platform: string) =>
  Effect.gen(function* () {
    if (endpoints.device === undefined) return yield* fail("unsupported")();
    const client = yield* request(
      endpoints.registration,
      {
        client_name: "Executor CLI",
        token_endpoint_auth_method: "none",
        grant_types: [deviceGrant, "refresh_token"],
        response_types: [],
        scope,
      },
      Schema.Struct({ client_id: Schema.NonEmptyString }),
    ).pipe(Effect.mapError(fail("registration")));
    const started = yield* request(
      endpoints.device,
      new URLSearchParams({ client_id: client.client_id, scope, resource: endpoints.resource }),
      Schema.Struct({
        device_code: Schema.NonEmptyString,
        user_code: Schema.NonEmptyString,
        verification_uri: Endpoint,
        verification_uri_complete: Schema.optional(Endpoint),
        expires_in: Schema.Number,
        interval: Schema.optional(Schema.Number),
      }),
    ).pipe(Effect.mapError(fail("registration")));
    yield* Console.error(
      [
        "",
        ...(started.verification_uri_complete === undefined
          ? [
              `To sign in, open ${started.verification_uri}`,
              `and enter the code ${started.user_code}`,
            ]
          : [
              `To sign in, open ${started.verification_uri_complete}`,
              `and check that it shows the code ${started.user_code}`,
            ]),
        "",
        "Waiting for approval...",
      ].join("\n"),
    );
    yield* openBrowser(platform, started.verification_uri_complete ?? started.verification_uri);
    const poll = HttpClientRequest.post(endpoints.token).pipe(
      HttpClientRequest.bodyUrlParams(
        new URLSearchParams({
          grant_type: deviceGrant,
          device_code: started.device_code,
          client_id: client.client_id,
        }),
      ),
    );
    const deadline = (yield* Clock.currentTimeMillis) + started.expires_in * 1000;
    const wait = (
      interval: number,
      delay = interval,
    ): Effect.Effect<typeof Token.Type, LoginFailed> =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.seconds(delay));
        if ((yield* Clock.currentTimeMillis) >= deadline) return yield* fail("expired")();
        const response = yield* HttpClient.execute(poll).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError(fail("token")),
        );
        if (response.status === 200)
          return yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Token)),
            Effect.mapError(fail("token")),
          );
        if (response.status === 429)
          return yield* wait(interval + 5, Math.max(interval + 5, retryAfter(response.headers)));
        const { error } = yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(TokenError)),
          Effect.mapError(fail("token")),
        );
        if (error === "authorization_pending") return yield* wait(interval);
        if (error === "slow_down") return yield* wait(interval + 5);
        return yield* fail(
          error === "access_denied" ? "denied" : error === "expired_token" ? "expired" : "token",
        )();
      });
    return { clientId: client.client_id, token: yield* wait(started.interval ?? 5) };
  });

const RememberedHost = Schema.fromJsonString(Schema.Struct({ host: RegistryOrigin }));
const rememberedFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* authDirectory, "host.json");
});
export const rememberedHost = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* rememberedFile;
  if (!(yield* fs.exists(file))) return Option.none<string>();
  const text = yield* fs.readFileString(file);
  const { host } = yield* Schema.decodeUnknownEffect(RememberedHost)(text).pipe(
    Effect.mapError(() => new SignInStateInvalid({ file })),
  );
  return Option.some(host);
});
const remember = (host: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* authDirectory;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const file = yield* rememberedFile;
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, JSON.stringify({ host }), { mode: 0o600 });
    yield* fs.rename(temporary, file);
  });

const reportFileFallback = (saved: Option.Option<string>) =>
  Option.isSome(saved)
    ? Console.error(
        `No system credential store is available, so the session is saved in ${saved.value}, readable only by you.`,
      )
    : Effect.void;

export const toolsLogin = (host: string, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(fail("host")));
      const endpoints = yield* discover(host).pipe(Effect.mapError(fail("host")));
      const { clientId, token } = yield* deviceLogin(endpoints, platform);
      const appManagement = yield* readAppManagement(host, token.access_token).pipe(Effect.option);
      const session: ToolsSession = {
        clientId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        resource: endpoints.resource,
        ...(Option.isSome(appManagement) ? { appManagement: appManagement.value } : {}),
      };
      const saved = yield* withSessionLock(
        host,
        Effect.gen(function* () {
          const file = yield* saveWithAppManagement(host, session);
          yield* deleteCredential(retiredAppSignInService, host);
          yield* remember(host);
          return file;
        }),
      ).pipe(Effect.mapError(fail("storage")));
      yield* reportFileFallback(saved);
      return session;
    }),
  );

export const logout = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const retired = yield* readCredential(retiredAppSignInService, host);
      const tools = yield* readCredential(toolsService, host);
      const signIn =
        tools === undefined
          ? undefined
          : Schema.decodeUnknownOption(Schema.fromJsonString(ToolsSession))(tools).pipe(
              Option.getOrUndefined,
            );
      for (const origin of signIn?.appManagement?.gitOrigins ?? [])
        if ((yield* readCredential(gitService, origin)) === host)
          yield* deleteCredential(gitService, origin);
      yield* deleteCredential(retiredAppSignInService, host);
      yield* deleteCredential(toolsService, host);
      const remembered = yield* rememberedHost.pipe(
        Effect.catchTag("SignInStateInvalid", () => Effect.succeed(Option.some(host))),
      );
      if (Option.isSome(remembered) && remembered.value === host)
        yield* fs.remove(yield* rememberedFile, { force: true });
      return retired !== undefined || tools !== undefined;
    }),
  );
