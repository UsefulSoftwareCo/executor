/** One-use process-owned pairing grants, exchanged for persistent browser sessions. */
import { Clock, Effect, Redacted, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  AuthForbidden,
  LocalAuthApi,
  PairingRejected,
  PairingUnauthorized,
  SessionHash,
  type AppSessionTarget,
  type SessionAccess,
  type StoredBrowserSession,
} from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { openBrowserSessions } from "./session-store.ts";

const sessionLifetime = 7 * 24 * 60 * 60_000;
type SessionTarget = "dashboard" | AppSessionTarget;
type Grant = Omit<StoredBrowserSession, "hash">;
const matches = (access: SessionAccess, target: SessionTarget) =>
  access === "dashboard" || target === "dashboard"
    ? access === target
    : access.app === target.app && access.origin === target.origin;

/** One token lifecycle for dashboard and app sessions; app access always checks its parent login. */
export const makeLocalAuth = (crypto: Crypto, directory: string) =>
  Effect.gen(function* () {
    const grants = yield* Ref.make<ReadonlyMap<SessionHash, Grant>>(new Map());
    const sessions = yield* openBrowserSessions(directory);
    const token = Effect.sync(() =>
      Redacted.make(
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      ),
    );
    const hash = (value: Redacted.Redacted<string>) =>
      Effect.promise(async () => {
        const bytes = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(Redacted.value(value)),
        );
        return SessionHash.make(
          Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        );
      });
    const current = (key: SessionHash) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(key);
        return session !== null && session.expiresAt.getTime() > (yield* Clock.currentTimeMillis)
          ? session
          : undefined;
      });
    const parentSession = (key: SessionHash) =>
      current(key).pipe(
        Effect.map((session) => (session?.access === "dashboard" ? session : undefined)),
      );
    const issueFor = (access: SessionAccess, supplied?: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const credential = supplied ?? (yield* token);
        const key = yield* hash(credential);
        const now = yield* Clock.currentTimeMillis;
        const expiresAt = new Date(now + (access === "dashboard" ? 5 * 60_000 : 60_000));
        yield* Ref.update(grants, (entries) => {
          const next = new Map([...entries].filter(([, grant]) => grant.expiresAt.getTime() > now));
          const group = [...next].filter(
            ([, grant]) => (grant.access === "dashboard") === (access === "dashboard"),
          );
          const limit = access === "dashboard" ? 32 : 100;
          for (const [oldest] of group.slice(0, Math.max(0, group.length - limit + 1)))
            next.delete(oldest);
          return next.set(key, { access, expiresAt });
        });
        return { token: credential, expiresAt };
      });
    const exchangeFor = (target: SessionTarget, credential: Redacted.Redacted<string>) =>
      Effect.gen(function* () {
        const key = yield* hash(credential);
        const now = yield* Clock.currentTimeMillis;
        const grant = yield* Ref.modify(grants, (entries) => {
          const next = new Map([...entries].filter(([, grant]) => grant.expiresAt.getTime() > now));
          const found = next.get(key);
          // Wrong audiences cannot consume a grant intended for another receiver.
          if (found === undefined || !matches(found.access, target))
            return [undefined, next] as const;
          next.delete(key);
          return [found, next] as const;
        });
        if (grant === undefined) return yield* new PairingRejected();
        let expiresAt = now + sessionLifetime;
        if (grant.access !== "dashboard") {
          const parent = yield* parentSession(grant.access.parent);
          if (parent === undefined) return yield* new PairingRejected();
          expiresAt = Math.min(expiresAt, parent.expiresAt.getTime());
        }
        const value = yield* token;
        yield* sessions.put(
          { hash: yield* hash(value), expiresAt: new Date(expiresAt), access: grant.access },
          new Date(now),
        );
        return value;
      });
    const identifyFor = (target: SessionTarget, credential: string | undefined) =>
      Effect.gen(function* () {
        if (credential === undefined || !/^[a-f0-9]{64}$/.test(credential)) return undefined;
        const session = yield* current(yield* hash(Redacted.make(credential)));
        if (session === undefined || !matches(session.access, target)) return undefined;
        if (
          session.access !== "dashboard" &&
          (yield* parentSession(session.access.parent)) === undefined
        )
          return undefined;
        return session.hash;
      }).pipe(Effect.withSpan("auth.local.identifyFor"));
    const identify = (credential: string | undefined) =>
      identifyFor("dashboard", credential).pipe(Effect.withSpan("auth.local.identify"));
    return {
      issue: (supplied?: Redacted.Redacted<string>) =>
        issueFor("dashboard", supplied).pipe(Effect.withSpan("auth.local.issue")),
      exchange: (credential: Redacted.Redacted<string>) =>
        exchangeFor("dashboard", credential).pipe(Effect.withSpan("auth.local.exchange")),
      identify,
      valid: (credential: string | undefined) =>
        identify(credential)
          .pipe(Effect.map((value) => value !== undefined))
          .pipe(Effect.withSpan("auth.local.valid")),
      issueApp: (target: AppSessionTarget, parent: SessionHash) =>
        Effect.gen(function* () {
          if ((yield* parentSession(parent)) === undefined) return yield* new PairingRejected();
          return yield* issueFor({ ...target, parent });
        }),
      exchangeApp: (target: AppSessionTarget, credential: Redacted.Redacted<string>) =>
        exchangeFor(target, credential),
      validApp: (target: AppSessionTarget, credential: string | undefined) =>
        identifyFor(target, credential).pipe(Effect.map((value) => value !== undefined)),
      revoke: (credential: string | undefined) =>
        Effect.gen(function* () {
          if (credential !== undefined)
            yield* sessions.revoke(yield* hash(Redacted.make(credential)));
        }).pipe(Effect.withSpan("auth.local.revoke")),
    };
  });
/** The local auth store is shared by HTTP access checks and the startup handoff. */
export type LocalAuth = Effect.Success<ReturnType<typeof makeLocalAuth>>;
/**
 * Cookies are shared across ports on one host, so the name carries the browser-facing port.
 * Behind a configured origin that port is stable, so sessions survive a new listening port.
 */
export const sessionCookie = (config: Pick<ServerConfig, "port" | "browserOrigin">) =>
  `executor_session_${
    config.browserOrigin === undefined ? config.port : new URL(config.browserOrigin).port || "443"
  }`;
/** Bootstrap credentials remain in URL fragments, outside HTTP logs and referrers. */
export const pairingUrl = (base: string, token: Redacted.Redacted<string>) =>
  Redacted.make(`${base}/#pair=${Redacted.value(token)}`);

/** Reject foreign browser requests and DNS rebinding; allow only top-level OAuth authorization navigation. */
export const localRequest = (port: number, browserOrigin?: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const origins = [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...(browserOrigin === undefined ? [] : [browserOrigin]),
    ];
    if (
      !origins.some((origin) => new URL(origin).host === request.headers.host) ||
      (request.headers.origin !== undefined && !origins.includes(request.headers.origin)) ||
      (request.headers["sec-fetch-site"] === "cross-site" &&
        !(
          request.method === "GET" &&
          new URL(request.url, origins[0]).pathname === "/api/auth/oauth2/authorize" &&
          request.headers["sec-fetch-mode"] === "navigate" &&
          request.headers["sec-fetch-dest"] === "document"
        ))
    )
      return yield* new AuthForbidden();
    return request;
  });

/**
 * Choose only a configured origin; proxy forwarding headers never establish trust.
 * A loopback proxy speaking HTTP/2 sends the listener address as Host and the public host in
 * X-Forwarded-Host. That header only selects the configured origin, and only on a request
 * whose Host is this loopback listener, which a foreign or rebinding page cannot send.
 */
export const requestOrigin = (
  config: ServerConfig,
  request: HttpServerRequest.HttpServerRequest,
) => {
  if (config.browserOrigin === undefined) return `http://127.0.0.1:${config.port}`;
  const browser = new URL(config.browserOrigin);
  return request.headers.origin === config.browserOrigin ||
    request.headers.host === browser.host ||
    (request.headers.host === `127.0.0.1:${config.port}` &&
      request.headers["x-forwarded-host"] === browser.host &&
      request.headers["x-forwarded-proto"] === "https")
    ? config.browserOrigin
    : `http://127.0.0.1:${config.port}`;
};

/** Pair another browser from an authenticated dashboard or a programmatic bearer client. */
export const authHandlers = (auth: LocalAuth, config: ServerConfig) => {
  const name = sessionCookie(config);
  const options = { httpOnly: true, sameSite: "strict" as const, path: "/" };
  const response = (authenticated: boolean) =>
    HttpServerResponse.jsonUnsafe(
      { authenticated },
      {
        headers: { "cache-control": "no-store" },
      },
    );
  const handlers = HttpApiBuilder.group(LocalAuthApi, "auth", (handlers) =>
    handlers
      .handle("session", () =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          return response(yield* auth.valid(request.cookies[name]));
        }),
      )
      .handle("exchange", ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          const session = yield* auth.exchange(payload.token);
          return yield* response(true).pipe(
            HttpServerResponse.setCookie(name, Redacted.value(session), {
              ...options,
              secure: requestOrigin(config, request).startsWith("https:"),
              maxAge: sessionLifetime,
            }),
            Effect.orDie,
          );
        }),
      )
      .handle("logout", () =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          yield* auth.revoke(request.cookies[name]);
          return yield* response(false).pipe(
            HttpServerResponse.expireCookie(name, options),
            Effect.orDie,
          );
        }),
      )
      .handle("pair", () =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          if (request.headers.origin === undefined) {
            if (request.headers.authorization !== `Bearer ${Redacted.value(config.apiKey)}`)
              return yield* new PairingUnauthorized();
          } else if (!(yield* auth.valid(request.cookies[name]))) {
            return yield* new AuthForbidden();
          }
          const issued = yield* auth.issue();
          return {
            url: pairingUrl(
              config.browserOrigin ?? `http://127.0.0.1:${config.port}`,
              issued.token,
            ),
            expiresAt: issued.expiresAt,
          };
        }),
      ),
  );
  return handlers;
};
