import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  BrowserWindow,
  nativeTheme,
  type Rectangle,
  safeStorage,
  session,
  type Session,
  shell,
} from "electron";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  FiberSet,
  FileSystem,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
  Semaphore,
} from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { writeAtomically } from "../../../server/src/implementation/atomic-file.ts";
import {
  executorServerIdentityPath,
  loopbackHostname,
} from "../../../../../packages/apps/src/contracts/desktop.ts";
import { externalUrl } from "../contracts/desktop.ts";
import { AppUnavailable, DesktopUnavailable } from "../contracts/installed-apps.ts";
import {
  accountKey,
  AppLocation,
  AuthorizationServer,
  DashboardSession,
  DesktopAccount,
  desktopClientName,
  HostedIdentity,
  desktopScope,
  type HostedServer,
  linkCookieName,
  linkRequestHeaders,
  hostedServerId,
  ProtectedResource,
  RecordChanged,
  RegisteredClient,
  ServerRefused,
  ServersFile,
  serversFileName,
  ServerOrigins,
  SessionLink,
  SignInAgain,
  TokenResponse,
} from "../contracts/servers.ts";
import type { InstalledApps } from "./installed-apps.ts";

const requestTimeout = "30 seconds";
const consentTimeout = "10 minutes";
const accessMargin = 60_000;
const linkCookieMillis = 60_000;

const refused = (message: string) => new ServerRefused({ message });
const unreachable = (origin: string) =>
  refused(`Executor could not reach ${origin}. Check the address and your connection.`);

export const hostOf = (origin: string) => new URL(origin).host;
const partitionName = (record: HostedServer) => `executor-account-${record.partition}`;

export const plainHttpWarning =
  "This server isn't encrypted. Your sign-in would travel in plain text on this network.";
export const plainStorageWarning =
  "This computer has no credential store Executor can use, so the sign-in it keeps is protected only by your account's file permissions.";

export const serverOrigin = (value: string) => {
  const url = URL.parse(value.trim());
  if (
    url === null ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    return undefined;
  return { origin: url.origin, plain: url.protocol === "http:" && !loopbackHostname(url.hostname) };
};

const sameSecret = (left: string, right: string) =>
  timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );

const callbackPage = (signedIn: boolean) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>Executor</title><style>body{font-family:system-ui,sans-serif;margin:48px;color-scheme:light dark}</style><h1>${signedIn ? "Executor is signed in" : "Executor did not sign in"}</h1><p>${signedIn ? "You can close this page and return to Executor." : "Return to Executor and try again."}</p></html>`;

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

interface Outgoing {
  readonly url: string;
  readonly bearer?: string;
  readonly form?: Readonly<Record<string, string>>;
  readonly json?: unknown;
}
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const send = (outgoing: Outgoing) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const base =
        outgoing.form !== undefined
          ? HttpClientRequest.post(outgoing.url).pipe(
              HttpClientRequest.bodyUrlParams(outgoing.form),
            )
          : outgoing.json !== undefined
            ? HttpClientRequest.post(outgoing.url).pipe(
                HttpClientRequest.bodyJsonUnsafe(outgoing.json),
              )
            : HttpClientRequest.get(outgoing.url);
      const request =
        outgoing.bearer === undefined
          ? base
          : base.pipe(HttpClientRequest.bearerToken(outgoing.bearer));
      const response = yield* client.execute(request);
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      return { status: response.status, body } satisfies Reply;
    }),
  ).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError(() => unreachable(new URL(outgoing.url).origin)),
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () => Effect.fail(unreachable(new URL(outgoing.url).origin)),
    }),
  );

const ok = (reply: Reply) => reply.status >= 200 && reply.status < 300;

const decode = <A>(schema: Schema.Decoder<A, never>, reply: Reply, problem: string) =>
  ok(reply)
    ? Schema.decodeUnknownEffect(schema)(reply.body).pipe(Effect.mapError(() => refused(problem)))
    : Effect.fail(refused(problem));

const readJson = <A>(schema: Schema.Decoder<A, never>, outgoing: Outgoing, problem: string) =>
  Effect.flatMap(send(outgoing), (reply) => decode(schema, reply, problem));

export const identify = (origin: string) =>
  readJson(
    HostedIdentity,
    { url: `${origin}${executorServerIdentityPath}` },
    `${origin} did not answer as an Executor server.`,
  );

const elsewhere = (entered: string) =>
  `${hostOf(entered)} sends desktop sign-in to another address, so Executor did not sign in.`;
const offered = (entered: string) =>
  `${entered} does not offer desktop sign-in. Update the server, then try again.`;

const sameRoles = (left: ServerOrigins, right: ServerOrigins) =>
  left.dashboard === right.dashboard && left.api === right.api && left.auth === right.auth;

const declared = (entered: string, identity: typeof HostedIdentity.Type) =>
  Effect.gen(function* () {
    const origins = identity.origins;
    if (origins === undefined) return yield* refused(offered(entered));
    const protocol = new URL(entered).protocol;
    const vouched = (role: string) => {
      const url = URL.parse(role);
      return (
        url !== null &&
        url.origin === role &&
        url.protocol === protocol &&
        (protocol === "https:" || role === entered)
      );
    };
    if (!vouched(origins.dashboard) || !vouched(origins.api) || !vouched(origins.auth))
      return yield* refused(elsewhere(entered));
    if (origins.dashboard !== entered) {
      const confirmed = yield* identify(origins.dashboard);
      if (
        confirmed.serverId !== identity.serverId ||
        confirmed.kind !== identity.kind ||
        confirmed.origins === undefined ||
        !sameRoles(confirmed.origins, origins)
      )
        return yield* refused(elsewhere(entered));
    }
    return origins;
  });

const discover = (entered: string, origins: ServerOrigins) =>
  Effect.gen(function* () {
    const protectedResource = yield* readJson(
      ProtectedResource,
      { url: `${origins.api}/.well-known/oauth-protected-resource/api/desktop` },
      offered(entered),
    );
    const advertised = protectedResource.authorization_servers[0];
    const issuer = URL.parse(advertised);
    if (
      protectedResource.resource !== `${origins.api}/api/desktop` ||
      issuer === null ||
      issuer.origin !== origins.auth ||
      issuer.username !== "" ||
      issuer.password !== "" ||
      issuer.search !== "" ||
      issuer.hash !== ""
    )
      return yield* refused(elsewhere(entered));
    const metadata = yield* readJson(
      AuthorizationServer,
      {
        url: `${origins.auth}/.well-known/oauth-authorization-server${issuer.pathname === "/" ? "" : issuer.pathname}`,
      },
      offered(entered),
    );
    const endpoints = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
      ...(metadata.revocation_endpoint === undefined ? [] : [metadata.revocation_endpoint]),
    ];
    if (
      metadata.issuer !== advertised ||
      endpoints.some((endpoint) => URL.parse(endpoint)?.origin !== origins.dashboard)
    )
      return yield* refused(elsewhere(entered));
    return { resource: protectedResource.resource, api: origins.api, metadata };
  });

const repeatGrace = "2 seconds";

const callbackHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

const loopback = (state: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const received = yield* Deferred.make<URLSearchParams>();
      const accepted: Array<string> = [];
      const server = yield* Effect.callback<Server, ServerRefused>((resume) => {
        const created = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          if (request.method !== "GET" || url.pathname !== "/callback") {
            response.writeHead(404).end();
            return;
          }
          const given = url.searchParams.get("state");
          const answered = url.searchParams.has("code") || url.searchParams.has("error");
          const first = accepted[0];
          const repeated = first !== undefined && sameSecret(url.search, first);
          if (
            !repeated &&
            (first !== undefined || given === null || !answered || !sameSecret(given, state))
          ) {
            response.writeHead(400, callbackHeaders).end(callbackPage(false));
            return;
          }
          response.writeHead(200, callbackHeaders).end(callbackPage(url.searchParams.has("code")));
          if (repeated) return;
          accepted.push(url.search);
          Deferred.doneUnsafe(received, Effect.succeed(url.searchParams));
        });
        created.once("error", () =>
          resume(Effect.fail(refused("Executor could not listen for the sign-in to finish."))),
        );
        created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
      });
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      return { server, received, redirect: `http://127.0.0.1:${port}/callback` };
    }),
    ({ server, received }) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(received)) yield* Effect.sleep(repeatGrace);
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeIdleConnections();
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.sync(() => server.closeAllConnections()),
          }),
        );
      }).pipe(Effect.forkDetach, Effect.asVoid),
  );

export const impersonation = (
  identity: { readonly serverId: string; readonly kind: string },
  origin: string,
  cloudOrigin: string,
  accounts: Iterable<{ readonly serverId: string; readonly origin: string }>,
) => {
  if (!identity.serverId.startsWith(`${identity.kind}-`))
    return `${hostOf(origin)} did not answer as an Executor server.`;
  if (identity.kind === "cloud" && origin !== cloudOrigin)
    return `${hostOf(origin)} says it is Executor Cloud, which is only at ${hostOf(cloudOrigin)}.`;
  for (const account of accounts)
    if (account.serverId === identity.serverId && account.origin !== origin)
      return `${hostOf(origin)} says it is the Executor server at ${hostOf(account.origin)}, which this computer already signs in to.`;
  return undefined;
};

export interface SignInExpectation {
  readonly serverId: string;
  readonly organizationId: string;
  readonly userId: string;
}

export type SignInOutcome =
  | { readonly kind: "signed-in"; readonly account: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "cancelled" };

interface Waiting {
  readonly id: string;
  readonly kind: "self-host" | "cloud";
  readonly host: string;
  authorization: string | undefined;
}

export interface HostedView {
  readonly id: string;
  readonly kind: "self-host" | "cloud";
  readonly serverId: string;
  readonly organizationId: string;
  readonly team: string;
  readonly host: string;
  readonly origin: string;
  readonly email: string | undefined;
  readonly state: "signed-in" | "sign-in-again" | "unreachable" | "waiting";
}

const offline = () => new AppUnavailable({ reason: "offline" });
const signedOut = () => new AppUnavailable({ reason: "signed-out" });
const gone = () => new AppUnavailable({ reason: "gone" });

export const makeHostedServers = (options: {
  readonly profile: string;
  readonly installedApps: InstalledApps;
  readonly cloudOrigin: string;
  readonly changed: () => void;
  readonly dashboardClosed: (account: string, byDesktop: boolean) => void;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fork = yield* FiberSet.makeRuntime<FileSystem.FileSystem | Path.Path>();
    const opening = yield* FiberMap.make<string>();
    const openIn = yield* FiberMap.runtime(opening)<FileSystem.FileSystem | Path.Path>();
    const signingIn = yield* FiberMap.make<string>();
    const signInIn = yield* FiberMap.runtime(signingIn)<FileSystem.FileSystem | Path.Path>();
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const file = path.join(options.profile, serversFileName);
    const lock = yield* Semaphore.make(1);
    const refreshing = new Map<string, Semaphore.Semaphore>();
    const linking = new Map<string, Semaphore.Semaphore>();
    const access = new Map<string, { readonly token: string; readonly expiresAt: number }>();
    const removing = new Set<string>();
    const unreachableAccounts = new Set<string>();
    const dashboards = new Map<string, BrowserWindow>();
    const waiting = new Map<string, Waiting>();
    const closing = new Set<BrowserWindow>();
    const FileJson = Schema.fromJsonString(ServersFile);

    const plainStorage =
      process.platform === "linux" &&
      !safeStorage.isEncryptionAvailable() &&
      safeStorage.getSelectedStorageBackend() === "basic_text";
    if (plainStorage) {
      safeStorage.setUsePlainTextEncryption(true);
      yield* Effect.logWarning(
        "No credential store answers on this Linux session; hosted sign-ins are kept only under the profile's file permissions",
      );
    }

    const loaded = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => Predicate.isTagged(error.reason, "NotFound"),
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed<ReadonlyArray<HostedServer>>([]),
          onSome: (text) =>
            Schema.decodeUnknownEffect(FileJson)(text).pipe(Effect.map((value) => value.accounts)),
        }),
      ),
      Effect.result,
    );
    if (Result.isFailure(loaded))
      yield* Effect.logError(
        "Hosted accounts are unreadable; adding accounts stays off until the file is fixed or removed",
        loaded.failure,
      ).pipe(Effect.annotateLogs({ detail: file }));
    const usable = Result.isSuccess(loaded);
    const records = new Map<string, HostedServer>(
      (Result.isSuccess(loaded) ? loaded.success : []).map((record) => [
        accountKey(record),
        record,
      ]),
    );

    const save = Effect.gen(function* () {
      if (!usable) return yield* refused(`Fix or remove ${file}, then try again.`);
      yield* fs.makeDirectory(options.profile, { recursive: true });
      yield* writeAtomically(
        process.platform,
        options.profile,
        file,
        yield* Schema.encodeEffect(FileJson)({ version: 2, accounts: [...records.values()] }),
      );
    }).pipe(
      Effect.provideContext(services),
      Effect.tapCause((cause) => Effect.logError("Could not save hosted accounts", cause)),
      Effect.mapError(() => refused("Executor could not save this account on this computer.")),
    );
    const update = (
      key: string,
      partition: string | undefined,
      change: (current: HostedServer | undefined) => HostedServer | undefined,
    ) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          const before = records.get(key);
          if (before?.partition !== partition)
            return Effect.fail<RecordChanged | ServerRefused>(new RecordChanged());
          const after = change(before);
          if (after === before) return Effect.succeed({ before, after });
          if (after === undefined) records.delete(key);
          else records.set(key, after);
          return save.pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                if (before === undefined) records.delete(key);
                else records.set(key, before);
              }),
            ),
            Effect.as({ before, after }),
          );
        }),
      );

    const seal = (token: string) =>
      Effect.try({
        try: () => safeStorage.encryptString(token).toString("base64"),
        catch: () =>
          refused(
            "This computer has no credential store Executor can use, so it cannot keep a sign-in.",
          ),
      });
    const unseal = (record: HostedServer) =>
      Effect.try({
        try: () => {
          if (record.sealedRefreshToken === null) throw new Error("Signed out");
          return safeStorage.decryptString(Buffer.from(record.sealedRefreshToken, "base64"));
        },
        catch: () => new SignInAgain(),
      });

    const partitions = new Map<string, Session>();
    const sessionOf = (record: HostedServer): Session => {
      const found = partitions.get(record.partition);
      if (found !== undefined) return found;
      const partition = session.fromPartition(partitionName(record));
      partitions.set(record.partition, partition);
      options.installedApps.attachSession(partition, () => record.origin);
      return partition;
    };
    const clearPartition = (record: HostedServer) =>
      Effect.tryPromise(() => {
        const partition = sessionOf(record);
        return Promise.all([partition.clearStorageData(), partition.clearCache()]);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Could not clear a hosted account's browser storage", cause).pipe(
            Effect.annotateLogs({ server: record.serverId }),
          ),
        ),
      );

    const reachable = (key: string, answered: boolean) => {
      const was = !unreachableAccounts.has(key);
      if (answered) unreachableAccounts.delete(key);
      else unreachableAccounts.add(key);
      if (was !== answered) options.changed();
    };

    const closeDashboard = (key: string, window?: BrowserWindow) => {
      const open = dashboards.get(key);
      if (window !== undefined && open !== window) return;
      dashboards.delete(key);
      if (open !== undefined && !open.isDestroyed()) {
        closing.add(open);
        open.destroy();
      }
    };

    const live = (record: HostedServer) => {
      const current = records.get(accountKey(record));
      return (
        current !== undefined &&
        current.partition === record.partition &&
        current.origin === record.origin &&
        current.state === "signed-in"
      );
    };

    const signInAgain = (record: HostedServer) =>
      Effect.gen(function* () {
        const key = accountKey(record);
        const marked = yield* update(key, record.partition, (current) =>
          current === undefined || current.state !== "signed-in"
            ? current
            : { ...current, state: "sign-in-again" },
        ).pipe(
          Effect.catch((error) =>
            Schema.is(RecordChanged)(error)
              ? Effect.succeed(undefined)
              : Effect.logError(
                  "Could not save that a hosted server ended this computer's sign-in",
                  error,
                ).pipe(Effect.as({ before: record })),
          ),
        );
        if (marked === undefined || marked.before?.state !== "signed-in") return;
        access.delete(key);
        closeDashboard(key);
        options.installedApps.disconnect(key, "signed-out");
        yield* clearPartition(record);
        options.changed();
        yield* Effect.logWarning("A hosted server ended this computer's sign-in").pipe(
          Effect.annotateLogs({ server: record.serverId }),
        );
      });

    const perAccount = (locks: Map<string, Semaphore.Semaphore>) => (key: string) => {
      const found = locks.get(key);
      const created = found ?? Semaphore.makeUnsafe(1);
      if (found === undefined) locks.set(key, created);
      return created.withPermits(1);
    };
    const refreshLock = perAccount(refreshing);
    const linkLock = perAccount(linking);

    const remember = (key: string, token: string, seconds: number | undefined) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        access.set(key, { token, expiresAt: now + (seconds ?? 3600) * 1000 });
      });

    const accessToken = (key: string, renew: boolean) =>
      refreshLock(key)(
        Effect.gen(function* () {
          if (removing.has(key)) return yield* new DesktopUnavailable();
          const record = records.get(key);
          if (record === undefined || record.state !== "signed-in") return yield* new SignInAgain();
          const cached = access.get(key);
          const now = yield* Clock.currentTimeMillis;
          if (!renew && cached !== undefined && cached.expiresAt - accessMargin > now)
            return cached.token;
          const refreshToken = yield* unseal(record);
          const reply = yield* send({
            url: record.endpoints.token,
            form: {
              grant_type: "refresh_token",
              client_id: record.endpoints.clientId,
              refresh_token: refreshToken,
              resource: record.endpoints.resource,
            },
          }).pipe(
            Effect.tapError(() => Effect.sync(() => reachable(key, false))),
            Effect.mapError(() => new DesktopUnavailable()),
          );
          reachable(key, true);
          if (reply.status === 400 || reply.status === 401) {
            yield* signInAgain(record);
            return yield* new SignInAgain();
          }
          const tokens = yield* decode(TokenResponse, reply, "").pipe(
            Effect.mapError(() => new DesktopUnavailable()),
          );
          const sealed = yield* seal(tokens.refresh_token).pipe(
            Effect.mapError(() => new DesktopUnavailable()),
          );
          yield* update(key, record.partition, (current) =>
            current === undefined ? current : { ...current, sealedRefreshToken: sealed },
          ).pipe(Effect.mapError(() => new DesktopUnavailable()));
          yield* remember(key, tokens.access_token, tokens.expires_in);
          return tokens.access_token;
        }),
      );

    const bearer = (key: string, outgoing: Omit<Outgoing, "bearer">) =>
      Effect.gen(function* () {
        const record = records.get(key);
        if (record === undefined) return yield* new SignInAgain();
        const attempt = (token: string) =>
          send({ ...outgoing, bearer: token }).pipe(
            Effect.tapError(() => Effect.sync(() => reachable(key, false))),
            Effect.tap(() => Effect.sync(() => reachable(key, true))),
            Effect.mapError(() => new DesktopUnavailable()),
          );
        const first = yield* attempt(yield* accessToken(key, false));
        if (first.status !== 401) return first;
        const second = yield* attempt(yield* accessToken(key, true));
        if (second.status === 401) {
          yield* signInAgain(record);
          return yield* new SignInAgain();
        }
        return second;
      });

    const sessionLink = (record: HostedServer, returnTo: string) =>
      Effect.gen(function* () {
        const verifier = randomBytes(32).toString("base64url");
        const binding = createHash("sha256").update(verifier, "ascii").digest("hex");
        const reply = yield* bearer(accountKey(record), {
          url: `${record.origin}/api/auth/desktop/session-link`,
          json: { binding, returnTo },
        });
        const link = yield* decode(SessionLink, reply, "").pipe(
          Effect.mapError(() => new DesktopUnavailable()),
        );
        const url = URL.parse(link.url);
        if (url === null || url.origin !== record.origin) return yield* new DesktopUnavailable();
        const now = yield* Clock.currentTimeMillis;
        const expires = Math.min(Date.parse(link.expiresAt), now + linkCookieMillis);
        if (!(expires > now)) return yield* new DesktopUnavailable();
        yield* Effect.tryPromise({
          try: () =>
            sessionOf(record).cookies.set({
              url: record.origin,
              name: linkCookieName(record.origin),
              value: verifier,
              path: "/",
              httpOnly: true,
              secure: url.protocol === "https:",
              sameSite: "lax",
              expirationDate: Math.floor(expires / 1000),
            }),
          catch: () => new DesktopUnavailable(),
        });
        return url.href;
      });

    const landedOnLogin = (window: BrowserWindow) =>
      URL.parse(window.webContents.getURL())?.pathname === "/login";

    const dashboardSession = (record: HostedServer) =>
      Effect.tryPromise({
        try: (signal) =>
          sessionOf(record).fetch(`${record.origin}/api/auth/get-session`, {
            credentials: "include",
            redirect: "error",
            signal,
          }),
        catch: () => new DesktopUnavailable(),
      }).pipe(
        Effect.tapError(() => Effect.sync(() => reachable(accountKey(record), false))),
        Effect.flatMap((response) =>
          response.ok
            ? Effect.tryPromise({
                try: () => response.json(),
                catch: () => new DesktopUnavailable(),
              })
            : Effect.fail(new DesktopUnavailable()),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(DashboardSession)),
        Effect.map((found) => found?.user.id === record.account.id),
        Effect.mapError(() => new DesktopUnavailable()),
      );

    const stillLive = (record: HostedServer) =>
      live(record) ? Effect.void : Effect.fail(new DesktopUnavailable());

    const refusedLink = (record: HostedServer) =>
      accessToken(accountKey(record), true).pipe(
        Effect.andThen(Effect.fail(new DesktopUnavailable())),
      );

    const unavailableFor = (key: string) =>
      records.get(key)?.state === "signed-in" ? offline() : signedOut();

    const signedIn = (key: string) =>
      linkLock(key)(
        Effect.gen(function* () {
          const record = records.get(key);
          if (record === undefined || record.state !== "signed-in")
            return yield* new DesktopUnavailable();
          if (yield* dashboardSession(record)) return;
          yield* stillLive(record);
          const link = yield* sessionLink(record, "/");
          yield* stillLive(record);
          const redeemed = yield* Effect.acquireUseRelease(
            Effect.sync(
              () =>
                new BrowserWindow({
                  show: false,
                  webPreferences: {
                    session: sessionOf(record),
                    javascript: false,
                    images: false,
                    sandbox: true,
                    contextIsolation: true,
                    nodeIntegration: false,
                  },
                }),
            ),
            (window) =>
              Effect.tryPromise(() =>
                window.loadURL(link, { extraHeaders: linkRequestHeaders }),
              ).pipe(
                Effect.timeout("20 seconds"),
                Effect.ignore,
                Effect.map(() => !landedOnLogin(window)),
              ),
            (window) => Effect.sync(() => window.destroy()),
          );
          yield* stillLive(record);
          if (!redeemed) return yield* refusedLink(record);
          if (!(yield* dashboardSession(record))) return yield* new DesktopUnavailable();
        }),
      ).pipe(Effect.mapError(() => unavailableFor(key)));

    const details = (key: string) => (app: string) =>
      Effect.gen(function* () {
        const record = records.get(key);
        if (record === undefined || record.state !== "signed-in") return yield* signedOut();
        const reply = yield* bearer(key, {
          url: `${record.endpoints.api}/api/organizations/${encodeURIComponent(record.organizationId)}/apps/${encodeURIComponent(app)}/ui`,
        }).pipe(Effect.mapError(() => unavailableFor(key)));
        if (reply.status === 403 || reply.status === 404) return yield* gone();
        const location = yield* decode(AppLocation, reply, "").pipe(Effect.mapError(offline));
        if (location.status === "unavailable") return yield* gone();
        if (location.status !== "ready") return yield* offline();
        const url = externalUrl(location.url);
        if (url === undefined) return yield* gone();
        if (url.protocol !== new URL(record.origin).protocol) {
          yield* Effect.logWarning(
            "A hosted server named an app address on another protocol than its own; Executor did not open it",
          ).pipe(Effect.annotateLogs({ server: record.serverId, app }));
          return yield* gone();
        }
        return {
          name: location.name,
          url: url.href,
          origin: url.origin,
          menuBar: location.menuBar,
          icon: location.icon,
        };
      });

    const connect = (record: HostedServer) => {
      const key = accountKey(record);
      options.installedApps.connect({
        server: key,
        origin: record.origin,
        session: sessionOf(record),
        label: record.label,
        host: hostOf(record.origin),
        details: details(key),
        signedIn: signedIn(key),
        allows: (url) => url.pathname === "/app-auth",
      });
    };

    for (const record of records.values())
      if (record.state === "signed-in") connect(record);
      else options.installedApps.disconnect(accountKey(record), "signed-out");

    const probe = (record: HostedServer) =>
      identify(record.origin).pipe(
        Effect.match({
          onSuccess: (identity) =>
            reachable(accountKey(record), identity.serverId === record.serverId),
          onFailure: () => reachable(accountKey(record), false),
        }),
      );

    const prepared = yield* Deferred.make<void>();
    if (!usable) Deferred.doneUnsafe(prepared, Effect.void);
    else
      fork(
        Effect.gen(function* () {
          const installed = yield* options.installedApps.installedServers;
          for (const key of installed) {
            if (!hostedServerId(key) || records.has(key)) continue;
            const apps = yield* options.installedApps.removeServer(key);
            yield* Effect.logInfo(
              "Removed installed apps of an account this computer no longer holds",
            ).pipe(Effect.annotateLogs({ server: key, apps }));
          }
          Deferred.doneUnsafe(prepared, Effect.void);
          yield* Effect.forEach(
            [...records.values()].filter((record) => record.state === "signed-in"),
            probe,
            { concurrency: "unbounded", discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Could not finish preparing this computer's hosted accounts", cause),
          ),
          Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(prepared, Effect.void))),
        ),
      );

    const openOutside = (value: string) => {
      const url = externalUrl(value);
      if (url !== undefined) void shell.openExternal(url.href).catch(() => undefined);
    };

    const dashboardWindow = (record: HostedServer, bounds: Rectangle | undefined) => {
      const key = accountKey(record);
      const window = new BrowserWindow({
        width: bounds?.width ?? 1180,
        height: bounds?.height ?? 800,
        ...(bounds === undefined ? {} : { x: bounds.x, y: bounds.y }),
        minWidth: 760,
        minHeight: 540,
        title: `Executor — ${record.label}`,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff",
        webPreferences: {
          session: sessionOf(record),
          preload: path.join(__dirname, "preload-host.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      dashboards.set(key, window);
      window.once("closed", () => {
        if (dashboards.get(key) === window) dashboards.delete(key);
        const byDesktop = closing.delete(window);
        options.dashboardClosed(key, byDesktop);
      });
      window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      const navigate = (event: Electron.Event, url: string) => {
        if (URL.parse(url)?.origin === record.origin) return;
        event.preventDefault();
        openOutside(url);
      };
      window.webContents.on("will-navigate", navigate);
      window.webContents.on("will-redirect", navigate);
      window.webContents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: "deny" };
      });
      return window;
    };

    const shownDashboard = (key: string) => {
      const existing = dashboards.get(key);
      return existing === undefined || existing.isDestroyed() ? undefined : existing;
    };

    const keptDashboard = (key: string) => {
      const kept = shownDashboard(key);
      if (kept === undefined || kept.isVisible() || !landedOnLogin(kept)) return kept;
      dashboards.delete(key);
      kept.destroy();
      return undefined;
    };

    type Shown = Deferred.Deferred<BrowserWindow, SignInAgain | DesktopUnavailable>;
    const showing = new Map<string, Shown>();

    const openDashboard = (key: string, bounds: Rectangle | undefined, shown: Shown) =>
      Effect.gen(function* () {
        const record = records.get(key);
        if (record === undefined || record.state !== "signed-in") return yield* new SignInAgain();
        return yield* linkLock(key)(
          Effect.gen(function* () {
            const again = keptDashboard(key);
            if (again !== undefined) return again;
            const home = `/org/${record.organizationSlug}`;
            const signed = yield* dashboardSession(record);
            yield* stillLive(record);
            const target = signed
              ? new URL(home, record.origin).href
              : yield* sessionLink(record, home);
            yield* stillLive(record);
            const window = dashboardWindow(record, bounds);
            window.once("ready-to-show", () => {
              if (!window.isDestroyed() && live(record) && !landedOnLogin(window))
                Deferred.doneUnsafe(shown, Effect.succeed(window));
            });
            yield* Effect.tryPromise(() =>
              window.loadURL(target, signed ? {} : { extraHeaders: linkRequestHeaders }),
            ).pipe(Effect.ignore);
            if (window.isDestroyed()) return yield* new DesktopUnavailable();
            if (!live(record)) {
              closeDashboard(key, window);
              return yield* new DesktopUnavailable();
            }
            if (landedOnLogin(window)) {
              closeDashboard(key, window);
              return yield* refusedLink(record);
            }
            reachable(key, true);
            yield* Effect.logInfo("Opened a hosted account's dashboard").pipe(
              Effect.annotateLogs({ server: record.serverId }),
            );
            return window;
          }),
        );
      });

    const openDashboardOnce = (key: string, bounds: Rectangle | undefined) =>
      Effect.suspend(() => {
        const pending = showing.get(key);
        if (pending !== undefined) return Deferred.await(pending);
        const kept = keptDashboard(key);
        if (kept !== undefined) return Effect.succeed(kept);
        const shown: Shown = Deferred.makeUnsafe();
        showing.set(key, shown);
        openIn(
          key,
          openDashboard(key, bounds, shown).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (showing.get(key) === shown) showing.delete(key);
                Deferred.doneUnsafe(
                  shown,
                  Exit.isSuccess(exit)
                    ? Effect.succeed(exit.value)
                    : Effect.fail(
                        Option.getOrElse(
                          Option.filter(Cause.findErrorOption(exit.cause), Schema.is(SignInAgain)),
                          () => new DesktopUnavailable(),
                        ),
                      ),
                );
              }),
            ),
          ),
        );
        return Deferred.await(shown);
      });

    const revokeToken = (endpoint: string | null, token: string, clientId: string) =>
      endpoint === null
        ? Effect.succeed(false)
        : send({
            url: endpoint,
            form: { token, token_type_hint: "refresh_token", client_id: clientId },
          }).pipe(
            Effect.map(ok),
            Effect.orElseSucceed(() => false),
          );
    const revoke = (record: HostedServer) =>
      unseal(record).pipe(
        Effect.flatMap((token) =>
          revokeToken(record.endpoints.revocation, token, record.endpoints.clientId),
        ),
        Effect.orElseSucceed(() => false),
      );

    const stopUsing = (record: HostedServer) =>
      Effect.gen(function* () {
        const key = accountKey(record);
        yield* FiberMap.remove(opening, key);
        closeDashboard(key);
        access.delete(key);
      });

    const sameIdentity = (
      record: { readonly userId: string; readonly organizationId: string },
      account: {
        readonly user: { readonly id: string };
        readonly organization: { readonly id: string };
      },
    ) => record.userId === account.user.id && record.organizationId === account.organization.id;

    const trusted = (identity: typeof HostedIdentity.Type, origin: string) =>
      Effect.suspend(() => {
        const problem = impersonation(identity, origin, options.cloudOrigin, records.values());
        return problem === undefined
          ? Effect.void
          : Effect.fail(refused(`${problem} Executor did not sign in.`));
      });

    const signIn = (entered: string, expected: SignInExpectation | undefined, entry: Waiting) =>
      Effect.scoped(
        Effect.gen(function* () {
          const identity = yield* identify(entered);
          if (expected !== undefined && identity.serverId !== expected.serverId)
            return yield* refused(
              `${hostOf(entered)} is a different Executor server than the one this account is on.`,
            );
          if (identity.kind === "local")
            return yield* refused(
              `${entered} is an Executor on a computer, not a hosted server. This desktop already runs its own local Executor.`,
            );
          if (!safeStorage.isEncryptionAvailable())
            return yield* refused(
              "This computer has no credential store Executor can use, so it cannot keep a sign-in.",
            );
          const origins = yield* declared(entered, identity);
          const origin = origins.dashboard;
          yield* trusted(identity, origin);
          const found = yield* discover(entered, origins);
          const state = randomBytes(24).toString("base64url");
          const listener = yield* loopback(state);
          const registered = yield* readJson(
            RegisteredClient,
            {
              url: found.metadata.registration_endpoint,
              json: {
                client_name: desktopClientName,
                redirect_uris: [listener.redirect],
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
              },
            },
            `${hostOf(origin)} refused to register this desktop.`,
          );
          const challenge = pkce();
          const authorization = new URL(found.metadata.authorization_endpoint);
          authorization.search = new URLSearchParams({
            response_type: "code",
            client_id: registered.client_id,
            redirect_uri: listener.redirect,
            code_challenge: challenge.challenge,
            code_challenge_method: "S256",
            scope: desktopScope,
            resource: found.resource,
            state,
          }).toString();
          entry.authorization = authorization.href;
          options.changed();
          yield* Effect.tryPromise({
            try: () => shell.openExternal(authorization.href),
            catch: () => refused("Executor could not open your browser to sign in."),
          });
          const answer = yield* Deferred.await(listener.received).pipe(
            Effect.timeoutOrElse({
              duration: consentTimeout,
              orElse: () => Effect.fail(refused("Signing in took too long. Try again.")),
            }),
          );
          const code = answer.get("code");
          if (answer.get("state") !== state)
            return yield* refused(`${hostOf(origin)} did not sign this desktop in.`);
          if (code === null)
            return yield* refused(
              answer.get("error") === "access_denied"
                ? "You didn't allow Executor to sign in. Try again when you're ready."
                : `${hostOf(origin)} did not sign this desktop in.`,
            );
          const tokens = yield* readJson(
            TokenResponse,
            {
              url: found.metadata.token_endpoint,
              form: {
                grant_type: "authorization_code",
                client_id: registered.client_id,
                code,
                code_verifier: challenge.verifier,
                redirect_uri: listener.redirect,
                resource: found.resource,
              },
            },
            `${hostOf(origin)} did not sign this desktop in.`,
          );
          const account = yield* readJson(
            DesktopAccount,
            { url: `${origin}/api/auth/desktop/account`, bearer: tokens.access_token },
            `${hostOf(origin)} did not say which account signed in.`,
          );
          if (expected !== undefined && !sameIdentity(expected, account)) {
            const previous = records.get(
              accountKey({ serverId: expected.serverId, organizationId: expected.organizationId }),
            );
            yield* revokeToken(
              found.metadata.revocation_endpoint ?? null,
              tokens.refresh_token,
              registered.client_id,
            );
            return yield* refused(
              previous === undefined
                ? `You signed in as ${account.user.email} to ${account.organization.name}, not the account this sign-in was for.`
                : `You signed in as ${account.user.email} to ${account.organization.name}. Sign in as ${previous.account.email} to ${previous.label} instead.`,
            );
          }
          const key = accountKey({
            serverId: identity.serverId,
            organizationId: account.organization.id,
          });
          const sealed = yield* seal(tokens.refresh_token);
          yield* trusted(identity, origin);
          const previous = records.get(key);
          const sameAccount = previous !== undefined && previous.account.id === account.user.id;
          const record: HostedServer = {
            serverId: identity.serverId,
            kind: identity.kind,
            origin,
            organizationId: account.organization.id,
            organizationSlug: account.organization.slug,
            label: account.organization.name,
            account: account.user,
            partition: sameAccount ? previous.partition : randomUUID(),
            state: "signed-in",
            endpoints: {
              resource: found.resource,
              api: found.api,
              token: found.metadata.token_endpoint,
              revocation: found.metadata.revocation_endpoint ?? null,
              clientId: registered.client_id,
            },
            sealedRefreshToken: sealed,
          };
          yield* update(key, previous?.partition, () => record).pipe(
            Effect.catchIf(Schema.is(RecordChanged), () =>
              Effect.fail(
                refused("This account changed on this computer while you signed in. Try again."),
              ),
            ),
          );
          access.delete(key);
          unreachableAccounts.delete(key);
          yield* remember(key, tokens.access_token, tokens.expires_in);
          if (previous !== undefined && !sameAccount) yield* stopUsing(previous);
          connect(record);
          options.changed();
          if (previous !== undefined && !sameAccount) {
            if (previous.state === "signed-in") yield* revoke(previous);
            yield* clearPartition(previous);
          }
          yield* Effect.logInfo("Signed in to a hosted account").pipe(
            Effect.annotateLogs({ server: record.serverId, kind: record.kind }),
          );
          return key;
        }),
      );

    const begin = (
      entered: string,
      expected: SignInExpectation | undefined,
      done: (outcome: SignInOutcome) => void,
    ) => {
      const id = `waiting-${randomUUID()}`;
      const kind = entered === options.cloudOrigin ? "cloud" : "self-host";
      const entry: Waiting = { id, kind, host: hostOf(entered), authorization: undefined };
      waiting.set(id, entry);
      options.changed();
      signInIn(
        id,
        signIn(entered, expected, entry).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              waiting.delete(id);
              options.changed();
              if (Exit.isSuccess(exit)) return done({ kind: "signed-in", account: exit.value });
              if (Cause.hasInterruptsOnly(exit.cause)) return done({ kind: "cancelled" });
              yield* Effect.logWarning("Could not sign in to a hosted server", exit.cause);
              const failure = Option.filter(
                Cause.findErrorOption(exit.cause),
                Schema.is(ServerRefused),
              );
              done({
                kind: "failed",
                message: Option.match(failure, {
                  onNone: () => `Executor could not sign in to ${entry.host}.`,
                  onSome: (error) => error.message,
                }),
              });
            }),
          ),
          Effect.ignore,
        ),
      );
      return id;
    };

    const cancel = (id: string) => FiberMap.remove(signingIn, id);
    const reopen = (id: string) => {
      const url = waiting.get(id)?.authorization;
      if (url !== undefined) void shell.openExternal(url).catch(() => undefined);
    };

    const signOut = (key: string) =>
      Effect.gen(function* () {
        const shown = records.get(key);
        if (shown === undefined) return;
        const signedOutNow = yield* refreshLock(key)(
          Effect.gen(function* () {
            const record = records.get(key);
            if (record === undefined || record.partition !== shown.partition) return undefined;
            const ended = record.state === "signed-in" ? yield* revoke(record) : false;
            yield* update(key, record.partition, (current) =>
              current === undefined
                ? current
                : { ...current, state: "sign-in-again", sealedRefreshToken: null },
            );
            access.delete(key);
            return { record, ended };
          }),
        );
        if (signedOutNow === undefined) return;
        yield* stopUsing(signedOutNow.record);
        options.installedApps.disconnect(key, "signed-out");
        yield* clearPartition(signedOutNow.record);
        options.changed();
        yield* Effect.logInfo("Signed out of a hosted account").pipe(
          Effect.annotateLogs({ server: shown.serverId, revoked: signedOutNow.ended }),
        );
      });

    const remove = (key: string) =>
      Effect.gen(function* () {
        const shown = records.get(key);
        if (shown === undefined) return;
        const revoked = yield* refreshLock(key)(
          Effect.gen(function* () {
            const record = records.get(key);
            if (record === undefined || record.partition !== shown.partition || removing.has(key))
              return Option.none<{ readonly record: HostedServer; readonly signedOut: string }>();
            const signedOut =
              record.state !== "signed-in"
                ? "already"
                : (yield* revoke(record))
                  ? "now"
                  : "unreachable";
            removing.add(key);
            access.delete(key);
            return Option.some({ record, signedOut });
          }),
        );
        if (Option.isNone(revoked)) return;
        const { record, signedOut } = revoked.value;
        const removed = yield* Effect.gen(function* () {
          yield* stopUsing(record);
          const apps = yield* options.installedApps.removeServer(key);
          yield* update(key, record.partition, () => undefined);
          unreachableAccounts.delete(key);
          yield* clearPartition(record);
          return apps;
        }).pipe(
          Effect.tapError(() => (signedOut === "now" ? signInAgain(record) : Effect.void)),
          Effect.ensuring(Effect.sync(() => removing.delete(key))),
        );
        options.changed();
        yield* Effect.logInfo("Removed a hosted account").pipe(
          Effect.annotateLogs({ server: record.serverId, signedOut, apps: removed }),
        );
      });

    const retry = (key: string) =>
      Effect.gen(function* () {
        const record = records.get(key);
        if (record !== undefined) yield* probe(record);
      });

    const view = (key: string, record: HostedServer): HostedView => ({
      id: key,
      kind: record.kind,
      serverId: record.serverId,
      organizationId: record.organizationId,
      team: record.label,
      host: hostOf(record.origin),
      origin: record.origin,
      email: record.account.email,
      state:
        record.state !== "signed-in"
          ? "sign-in-again"
          : unreachableAccounts.has(key)
            ? "unreachable"
            : "signed-in",
    });

    const views = (): ReadonlyArray<HostedView> => [
      ...[...records.entries()].map(([key, record]) => view(key, record)),
      ...[...waiting.values()].map((entry): HostedView => ({
        id: entry.id,
        kind: entry.kind,
        serverId: "",
        organizationId: "",
        team: entry.kind === "cloud" ? "Executor Cloud" : entry.host,
        host: entry.host,
        origin: "",
        email: undefined,
        state: "waiting",
      })),
    ];

    const accountOf = (key: string) => {
      const record = records.get(key);
      return record === undefined ? undefined : view(key, record);
    };

    const expectation = (key: string): SignInExpectation | undefined => {
      const record = records.get(key);
      return record === undefined
        ? undefined
        : {
            serverId: record.serverId,
            organizationId: record.organizationId,
            userId: record.account.id,
          };
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const window of dashboards.values()) if (!window.isDestroyed()) window.destroy();
        dashboards.clear();
      }),
    );

    return {
      usable,
      prepared: Deferred.await(prepared),
      plainStorage,
      cloudOrigin: options.cloudOrigin,
      views,
      accountOf,
      expectation,
      originOf: (key: string) => records.get(key)?.origin,
      begin,
      cancel,
      reopen,
      waitingFor: (id: string) => waiting.get(id),
      signOut,
      remove,
      retry,
      openDashboard: openDashboardOnce,
      dashboard: shownDashboard,
      dashboards: () => [...dashboards.entries()],
      closeDashboard: (key: string) => closeDashboard(key),
    };
  });

export type HostedServers = Effect.Success<ReturnType<typeof makeHostedServers>>;
