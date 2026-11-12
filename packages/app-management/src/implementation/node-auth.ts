import { homedir } from "node:os";
import { lock } from "proper-lockfile";
/**
 * CLI device sign-in and credential-store adapter. A host can hold two sign-ins: app management,
 * for the host's API resource, and tools, for its MCP resource. Sessions live in the OS credential
 * store, or on machines without one in a file only this user can read. Credentials never enter
 * repositories or config files. The host signed in to last is remembered beside them, without a
 * credential, so client commands default to it.
 */
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
import { AppClientError, LoginFailed, SignInStateInvalid } from "../client-error.ts";

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
/** The tools sign-in: a grant for the host's MCP resource, which may be on another origin. */
const ToolsSession = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  /** The MCP endpoint the grant is for, as the host's resource metadata names it. */
  resource: Schema.String,
});
export type ToolsSession = typeof ToolsSession.Type;
/** Which of a host's two sign-ins: app management (`api`) or tools (`mcp`). */
export type SignIn = "api" | "mcp";
const authError = () => new AppClientError({ reason: "authentication" });
/** Session locks, and sessions on machines without an OS credential store, live here. */
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
/** The app management sign-in's store entry; the name predates the tools sign-in. */
const sessionService = "Executor Registry";
const toolsService = "Executor Tools";
/**
 * Which signed-in host a Git origin's remotes use. It holds an origin, never a credential, and
 * {@link gitSession} accepts it only when that host's own session names the Git origin.
 */
const gitService = "Executor Registry Git";
// Loaded lazily so a native binding that cannot load means no OS store instead of a failed start.
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
/** Read from the OS credential store, then from the file used where that store is unavailable. */
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
/**
 * Save in the OS credential store when this machine has one, as on a desktop. A Linux server or
 * container usually has no Secret Service, so there the value goes to a file readable only by
 * this user. Returns that file, or nothing when the OS store took it.
 */
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
      // A session saved to a file before the OS store was available must not outlive it.
      yield* fs.remove(file, { force: true });
      return Option.none<string>();
    }
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, value, { mode: 0o600 });
    yield* fs.rename(temporary, file);
    return Option.some(file);
  }).pipe(Effect.catchTag("PlatformError", authError));
/**
 * Remove a credential from the OS credential store and the file fallback. A store that cannot
 * delete it is left alone only when it cannot read it either, as when there is no store; a value
 * that can still be read afterwards fails the removal.
 */
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
/** The MCP resource a host's metadata names: an endpoint at `/mcp` on a permitted origin. */
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
 * Find one of the host's resources and its authorization server, as RFC 9728 and RFC 8414 clients
 * do: the resource names its issuer, and the issuer's own origin serves the endpoints, which may
 * be on another host than the API (hosted Executor's are). The issuer must match exactly. The API
 * resource is the host's own `/api`; the MCP resource is the `/mcp` endpoint the host names.
 */
const discover = (host: string, signIn: SignIn) =>
  Effect.gen(function* () {
    const protectedResource = yield* fetchJson(
      HttpClientRequest.get(`${host}/.well-known/oauth-protected-resource/${signIn}`),
      Schema.Struct({
        resource: Schema.String,
        authorization_servers: Schema.NonEmptyArray(Endpoint),
      }),
    );
    if (
      signIn === "api"
        ? protectedResource.resource !== `${host}/api`
        : !isMcpResource(protectedResource.resource)
    )
      return yield* authError();
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
/** The MCP endpoint a host names for tools, read from its unauthenticated resource metadata. */
export const mcpResource = (host: string) =>
  Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(
    Effect.mapError(authError),
    Effect.andThen(discover(host, "mcp")),
    Effect.map(({ resource }) => resource),
  );
const save = (host: string, session: typeof Session.Type) =>
  writeCredential(sessionService, host, JSON.stringify(session));

/** Serialize refresh and replacement across Git helper processes; the lock contains no credentials. */
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

/**
 * A session is refreshed this long before its access token expires, so a token handed out has at
 * least this long left. The Git helper reports the same point as the token's expiry, so a copy
 * another credential helper keeps is dropped when this one would refresh it.
 */
export const sessionRefreshMarginMs = 60_000;

/**
 * The session as saved, or with fresh tokens from the host when its access token is due to
 * expire. The caller holds the host's session lock and saves the result.
 */
const refreshDue = <S extends { clientId: string; refreshToken: string; expiresAt: number }>(
  host: string,
  signIn: SignIn,
  saved: S,
) =>
  Effect.gen(function* () {
    if (saved.expiresAt > Date.now() + sessionRefreshMarginMs) return Option.none<S>();
    const endpoints = yield* discover(host, signIn);
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

/** Read and refresh one explicitly selected organization grant. The credential store owns refresh-token custody. */
export const registrySession = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const raw = yield* readCredential(sessionService, host);
      if (raw === undefined) return yield* authError();
      const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(raw).pipe(
        Effect.mapError(authError),
      );
      const fresh = yield* refreshDue(host, "api", saved);
      if (Option.isNone(fresh)) return Redacted.make(saved);
      yield* save(host, fresh.value);
      return Redacted.make(fresh.value);
    }),
  );

/** Read the tools sign-in, if the host has one, without refreshing it. */
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

/** The tools sign-in for `host`, refreshed as the app management sign-in is. */
export const toolsSession = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(authError));
      const saved = yield* readToolsSession(host);
      if (Option.isNone(saved)) return yield* authError();
      const fresh = yield* refreshDue(host, "mcp", saved.value);
      if (Option.isNone(fresh)) return Redacted.make(saved.value);
      yield* writeCredential(toolsService, host, JSON.stringify(fresh.value));
      return Redacted.make(fresh.value);
    }),
  );

/** Whether `host` holds an app management sign-in. Reads the store; refreshes nothing. */
export const hasRegistrySession = (host: string) =>
  readCredential(sessionService, host).pipe(Effect.map((raw) => raw !== undefined));

/**
 * The session for Git remotes on `origin`. Hosted Executor serves Git on other origins than its
 * API (`executor.sh` beside `api.executor.sh`), so sign-in records which host's session each of
 * them uses, and that session must still name the origin. Otherwise a session signed in at
 * `origin` itself is used, as on hosts that serve Git beside their API.
 */
export const gitSession = (origin: string) =>
  Effect.gen(function* () {
    const host = (yield* readCredential(gitService, origin)) ?? origin;
    const session = yield* registrySession(host);
    if (host !== origin && !(Redacted.value(session).gitOrigins ?? []).includes(origin))
      return yield* authError();
    return session;
  });

/** The scope each sign-in asks for; both keep a refresh token. */
const scopes: Record<SignIn, string> = {
  api: "executor offline_access",
  mcp: "mcp offline_access",
};
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";
type Endpoints = Effect.Success<ReturnType<typeof discover>>;
const failure = (signIn: SignIn) => (reason: LoginFailed["reason"]) => () =>
  new LoginFailed({ reason, signIn });
const TokenError = Schema.Struct({ error: Schema.String });
/** Seconds a rate-limited response asks to wait, in delta-seconds; Better Auth names its own header. */
const retryAfter = (headers: Readonly<Record<string, string | undefined>>) => {
  const seconds = Number(headers["retry-after"] ?? headers["x-retry-after"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
};

/**
 * Whether a browser opened here reaches the person signing in. Over SSH it would open on the
 * remote machine, and a Linux session without a display has none to open.
 */
const browserReachable = (platform: string) =>
  Effect.gen(function* () {
    const variable = (name: string) =>
      Config.String(name).pipe(Config.option, Config.map(Option.isSome));
    const remote = (yield* variable("SSH_CONNECTION")) || (yield* variable("SSH_TTY"));
    const display = (yield* variable("DISPLAY")) || (yield* variable("WAYLAND_DISPLAY"));
    return !remote && (platform !== "linux" || display);
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Open the approval page in this machine's browser; the printed code still works if none opens.
 * The opener is started and left alone. Outside a desktop it detects, xdg-open runs a browser it
 * has to start in the foreground until that browser quits, so waiting for it would hold polling
 * back while the person approves, and ending it would close the browser they approve in.
 */
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
    // An unreferenced process outlives this scope and does not keep the CLI running.
    yield* Effect.scoped(spawner.spawn(command).pipe(Effect.flatMap((child) => child.unref))).pipe(
      Effect.ignore,
    );
  });

/**
 * RFC 8628 device authorization: register a public client, print where to approve and the code,
 * open that page when a browser can, then poll the token endpoint at the host's interval, slowing
 * down when asked, until approval, denial or expiry.
 */
const deviceLogin = (endpoints: Endpoints, signIn: SignIn, platform: string) =>
  Effect.gen(function* () {
    const fail = failure(signIn);
    const scope = scopes[signIn];
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
    // One link: with the code in it when the host offers that, so nothing needs typing. The code
    // is still shown, to compare with the page before approving.
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
        // A per-address limit in front of the token endpoint answers without an OAuth error. Slow
        // down as `slow_down` asks, waiting at least as long as the limit names.
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

/**
 * The host client commands use when neither --host nor EXECUTOR_HOST names one: the host signed in
 * to last, recorded beside the sessions without a credential.
 */
const RememberedHost = Schema.fromJsonString(Schema.Struct({ host: RegistryOrigin }));
const rememberedFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* authDirectory, "host.json");
});
/** The host signed in to last, if one is remembered. */
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

/** Say where a session went when the OS credential store could not take it. */
const reportFileFallback = (saved: Option.Option<string>) =>
  Option.isSome(saved)
    ? Console.error(
        `No system credential store is available, so the session is saved in ${saved.value}, readable only by you.`,
      )
    : Effect.void;

/**
 * Sign in to a hosted Executor for app commands with a code approved on any signed-in browser.
 * The host becomes the one client commands use by default.
 */
export const registryLogin = (host: string, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fail = failure("api");
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(fail("host")));
      const endpoints = yield* discover(host, "api").pipe(Effect.mapError(fail("host")));
      const { clientId, token } = yield* deviceLogin(endpoints, "api", platform);
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
      ).pipe(Effect.mapError(fail("context")));
      const gitOrigins = (context.gitOrigins ?? []).filter((origin) => origin !== host);
      const saved = yield* withSessionLock(
        host,
        Effect.gen(function* () {
          const file = yield* save(host, {
            clientId,
            accessToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt: Date.now() + token.expires_in * 1000,
            organization: context.organization,
            namespace: context.slug,
            gitOrigins,
          });
          for (const origin of gitOrigins) yield* writeCredential(gitService, origin, host);
          yield* remember(host);
          return file;
        }),
      ).pipe(Effect.mapError(fail("storage")));
      yield* reportFileFallback(saved);
      yield* Console.log(`Connected to ${host} as @${context.slug}.`);
    }),
  );

/**
 * Sign in for tool commands and `executor mcp`: a device grant for the host's MCP resource. What
 * the grant reaches and how its approvals are answered are chosen on the approval page. The host
 * becomes the one client commands use by default. Returns the saved session.
 */
export const toolsLogin = (host: string, platform: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fail = failure("mcp");
      yield* Schema.decodeUnknownEffect(RegistryOrigin)(host).pipe(Effect.mapError(fail("host")));
      const endpoints = yield* discover(host, "mcp").pipe(Effect.mapError(fail("host")));
      const { clientId, token } = yield* deviceLogin(endpoints, "mcp", platform);
      const session: ToolsSession = {
        clientId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        resource: endpoints.resource,
      };
      const saved = yield* withSessionLock(
        host,
        Effect.gen(function* () {
          const file = yield* writeCredential(toolsService, host, JSON.stringify(session));
          yield* remember(host);
          return file;
        }),
      ).pipe(Effect.mapError(fail("storage")));
      yield* reportFileFallback(saved);
      return session;
    }),
  );

/**
 * Remove both of `host`'s sign-ins, and the Git origins its app management sign-in named, and
 * forget it when it is the remembered host. Returns whether it held any sign-in.
 */
export const logout = (host: string) =>
  withSessionLock(
    host,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* readCredential(sessionService, host);
      const api =
        raw === undefined
          ? undefined
          : Schema.decodeUnknownOption(Schema.fromJsonString(Session))(raw).pipe(
              Option.getOrUndefined,
            );
      for (const origin of api?.gitOrigins ?? [])
        if ((yield* readCredential(gitService, origin)) === host)
          yield* deleteCredential(gitService, origin);
      const tools = yield* readCredential(toolsService, host);
      yield* deleteCredential(sessionService, host);
      yield* deleteCredential(toolsService, host);
      // A damaged record cannot name another host, so signing out is how it is cleared.
      const remembered = yield* rememberedHost.pipe(
        Effect.catchTag("SignInStateInvalid", () => Effect.succeed(Option.some(host))),
      );
      if (Option.isSome(remembered) && remembered.value === host)
        yield* fs.remove(yield* rememberedFile, { force: true });
      return raw !== undefined || tools !== undefined;
    }),
  );
