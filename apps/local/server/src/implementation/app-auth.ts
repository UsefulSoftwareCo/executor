import { type Executor } from "@executor-js/sdk/core";
import { localOwner } from "./owners.ts";
import {
  AppReturnPath,
  AppSignInCallback,
  AppSignInCode,
  AppSignInId,
  appPrivateHeaders,
  appRedirect,
  appSignInCallback,
  appSignInFailed,
  type AppSignInFailure,
} from "apps/ui/auth";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { Clock, Effect, Option, Redacted, Ref, Result, Schema, Semaphore } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { appFromHost, appOrigin, appSessionCookie } from "../contracts/app-ui.ts";
import { PairingRejected, type AppSessionTarget, type SessionHash } from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { sessionCookie, type LocalAuth } from "./auth.ts";

const pendingLifetime = 10 * 60_000;
type Attempt = {
  readonly target: AppSessionTarget;
  readonly returnTo: AppReturnPath;
  readonly verifier: string;
  readonly expiresAt: number;
  readonly approval?: {
    readonly parent: SessionHash;
    readonly code: Redacted.Redacted<string>;
    readonly expiresAt: number;
  };
};
const unavailable = () => new UiFailed({ reason: "unavailable" });

export const appRequest = (port: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const app = appFromHost(request.headers.host, port);
    if (app === undefined) return yield* new UiForbidden();
    const origin = appOrigin(app, port);
    const safe = request.method === "GET" || request.method === "HEAD";
    if (
      (!safe && request.headers.origin !== origin) ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (request.headers["sec-fetch-site"] === "cross-site" &&
        !(request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate"))
    )
      return yield* new UiForbidden();
    return { target: { app, origin }, request };
  });

export const appAuthentication = (
  executor: Executor,
  auth: LocalAuth,
  config: ServerConfig,
  crypto: Crypto,
) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make<ReadonlyMap<AppSignInId, Attempt>>(new Map());
    const lock = yield* Semaphore.make(1);
    const nonce = Effect.sync(() =>
      Redacted.make(
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      ),
    );
    const digest = (value: Redacted.Redacted<string>) =>
      Effect.promise(async () =>
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(value))),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join(""),
      );
    const cookie = (id: AppSignInId) => `executor_app_attempt_${config.port}_${id}`;
    const cookieOptions = { httpOnly: true, sameSite: "lax" as const, path: "/_executor/auth" };
    const dashboardOrigin = config.browserOrigin ?? `http://127.0.0.1:${config.port}`;
    const usable = (target: AppSessionTarget) =>
      executor.apps.get({ app: target.app, owner: localOwner }).pipe(
        Effect.flatMap((app) =>
          app.activeVersion === null ? Effect.fail(unavailable()) : Effect.void,
        ),
        Effect.catchTags({
          AppNotFound: () => Effect.fail(new UiForbidden()),
          StorageError: () => Effect.fail(unavailable()),
        }),
      );
    const active = (id: AppSignInId) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(attempts)).get(id);
        if (entry === undefined || entry.expiresAt <= (yield* Clock.currentTimeMillis))
          return yield* new UiUnauthorized();
        return entry;
      });
    const begin = Effect.gen(function* () {
      const { target, request } = yield* appRequest(config.port);
      yield* usable(target);
      const url = new URL(request.url, target.origin);
      const returnTo = yield* Schema.decodeUnknownEffect(AppReturnPath)(
        url.pathname + url.search,
      ).pipe(Effect.mapError(() => new UiForbidden()));
      const id = AppSignInId.make(Redacted.value(yield* nonce));
      const proof = yield* nonce;
      const verifier = yield* digest(proof);
      const now = yield* Clock.currentTimeMillis;
      const accepted = yield* Ref.modify(attempts, (entries) => {
        const next = new Map([...entries].filter(([, entry]) => entry.expiresAt > now));
        if (next.size >= 100) return [false, next] as const;
        next.set(id, { target, returnTo, verifier, expiresAt: now + pendingLifetime });
        return [true, next] as const;
      });
      if (!accepted) return yield* unavailable();
      const login = new URL("/app-auth", dashboardOrigin);
      login.searchParams.set("request", id);
      return yield* appRedirect(login.href).pipe(
        HttpServerResponse.setCookie(cookie(id), Redacted.value(proof), {
          ...cookieOptions,
          maxAge: "10 minutes",
        }),
        Effect.orDie,
      );
    });
    const callback = lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { target, request } = yield* appRequest(config.port);
          const url = new URL(request.url, target.origin);
          const query = yield* Schema.decodeUnknownEffect(AppSignInCallback)({
            request: url.searchParams.get("request"),
            code: url.searchParams.get("code"),
          }).pipe(Effect.mapError(() => new UiUnauthorized()));
          const proof = Schema.decodeUnknownOption(AppSignInCode)(
            request.cookies[cookie(query.request)],
          );
          if (Option.isNone(proof)) return yield* new UiUnauthorized();
          const verifier = yield* digest(proof.value);
          const now = yield* Clock.currentTimeMillis;
          const entry = yield* Ref.modify(attempts, (entries) => {
            const entry = entries.get(query.request);
            if (
              entry === undefined ||
              entry.expiresAt <= now ||
              entry.approval === undefined ||
              entry.approval.expiresAt <= now ||
              entry.target.app !== target.app ||
              entry.target.origin !== target.origin ||
              entry.verifier !== verifier ||
              Redacted.value(entry.approval.code) !== Redacted.value(query.code)
            )
              return [undefined, entries] as const;
            const next = new Map(entries);
            next.delete(query.request);
            return [entry, next] as const;
          });
          if (entry === undefined) return yield* new UiUnauthorized();
          const session = yield* auth
            .exchangeApp(target, query.code)
            .pipe(
              Effect.mapError((error) =>
                Schema.is(PairingRejected)(error) ? new UiUnauthorized() : unavailable(),
              ),
            );
          return yield* appRedirect(entry.returnTo).pipe(
            HttpServerResponse.setCookie(appSessionCookie(config.port), Redacted.value(session), {
              httpOnly: true,
              sameSite: "lax",
              path: "/",
              maxAge: "7 days",
            }),
            Effect.flatMap(HttpServerResponse.expireCookie(cookie(query.request), cookieOptions)),
            Effect.orDie,
          );
        }),
      )
      .pipe(Effect.catchTag("UiUnauthorized", () => Effect.succeed(appSignInFailed())));
    const approve = (id: AppSignInId, parent: SessionHash) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* active(id);
          yield* usable(entry.target);
          if (entry.approval !== undefined && entry.approval.parent !== parent)
            return yield* new UiUnauthorized();
          const approval = entry.approval ?? {
            parent,
            ...(yield* auth.issueApp(entry.target, parent).pipe(
              Effect.map(({ token, expiresAt }) => ({
                code: token,
                expiresAt: expiresAt.getTime(),
              })),
              Effect.mapError((error) =>
                Schema.is(PairingRejected)(error) ? new UiUnauthorized() : unavailable(),
              ),
            )),
          };
          if (approval.expiresAt <= (yield* Clock.currentTimeMillis))
            return yield* new UiUnauthorized();
          yield* Ref.update(attempts, (entries) =>
            new Map(entries).set(id, { ...entry, approval }),
          );
          return appSignInCallback(entry.target.origin, id, Redacted.value(approval.code));
        }),
      );
    const failure = (error: UiUnauthorized | UiForbidden | UiFailed): AppSignInFailure =>
      Schema.is(UiUnauthorized)(error)
        ? "ended"
        : Schema.is(UiForbidden)(error)
          ? "forbidden"
          : "unavailable";
    const failed = (error: UiUnauthorized | UiForbidden | UiFailed) =>
      appRedirect(`/app-auth?${new URLSearchParams({ failure: failure(error) })}`);
    const signIn = <E, R>(page: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, dashboardOrigin);
        const id = Schema.decodeUnknownOption(AppSignInId)(url.searchParams.get("request"));
        if (Option.isNone(id)) return yield* page;
        const identified = yield* auth
          .identify(request.cookies[sessionCookie(config)])
          .pipe(Effect.result);
        if (Result.isFailure(identified)) return failed(unavailable());
        const parent = identified.success;
        if (parent === undefined) {
          if (request.headers["sec-fetch-site"] === "cross-site")
            return HttpServerResponse.text(
              `<!doctype html><html><head><meta http-equiv="refresh" content="0"><title>Opening app</title></head><body></body></html>`,
              {
                contentType: "text/html",
                headers: {
                  ...appPrivateHeaders,
                  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
                },
              },
            );
          return yield* page;
        }
        return yield* approve(id.value, parent).pipe(
          Effect.map(appRedirect),
          Effect.catch((error) => Effect.succeed(failed(error))),
        );
      });
    return { begin, callback, signIn };
  });
