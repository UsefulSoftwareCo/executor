/** Local identity/session adapter for the shared app-origin authentication protocol. */
import { OwnerId, type Executor } from "@executor-js/sdk/core";
import {
  AppSignInApi,
  AppSignInCode,
  AppSignInId,
  appPrivateHeaders,
  type AppReturnPath,
} from "apps/ui/auth";
import { UiFailed, UiForbidden, UiUnauthorized } from "apps/ui/contracts";
import { Clock, Effect, Option, Redacted, Ref, Schema, Semaphore } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  AppAuthenticationApi,
  appFromHost,
  appOrigin,
  appSessionCookie,
} from "../contracts/app-ui.ts";
import { PairingRejected, type AppSessionTarget, type SessionHash } from "../contracts/auth.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, sessionCookie, type LocalAuth } from "./auth.ts";

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

/** Validate the exact app origin before decoding any browser body or reading its session. */
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

/** Browser-bound attempts are process-owned locally; established sessions keep using the persistent auth store. */
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
    const cookieOptions = { httpOnly: true, sameSite: "strict" as const, path: "/_executor/auth" };
    const usable = (target: AppSessionTarget) =>
      Effect.gen(function* () {
        const app = yield* executor.apps.get({ app: target.app, owner: OwnerId.make("local") });
        const source = yield* executor.apps.source({ app: app.id, owner: app.owner });
        if (!source.files.some((file) => file.path === "ui/index.html"))
          return yield* unavailable();
      }).pipe(
        Effect.catchTags({
          AppNotFound: () => Effect.fail(new UiForbidden()),
          AppNotDeployed: () => Effect.fail(unavailable()),
          DeploymentNotFound: () => Effect.fail(unavailable()),
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
    const handlers = HttpApiBuilder.group(AppSignInApi, "appSignIn", (handlers) =>
      handlers
        .handle("start", ({ payload }) =>
          Effect.gen(function* () {
            const { target } = yield* appRequest(config.port);
            yield* usable(target);
            const id = AppSignInId.make(Redacted.value(yield* nonce));
            const proof = yield* nonce;
            const verifier = yield* digest(proof);
            const now = yield* Clock.currentTimeMillis;
            const accepted = yield* Ref.modify(attempts, (entries) => {
              const next = new Map([...entries].filter(([, entry]) => entry.expiresAt > now));
              if (next.size >= 100) return [false, next] as const;
              next.set(id, {
                target,
                returnTo: payload.returnTo,
                verifier,
                expiresAt: now + pendingLifetime,
              });
              return [true, next] as const;
            });
            if (!accepted) return yield* unavailable();
            const login = new URL(
              "/app-auth",
              config.browserOrigin ?? `http://127.0.0.1:${config.port}`,
            );
            login.searchParams.set("request", id);
            return yield* HttpServerResponse.jsonUnsafe(
              { url: login.href },
              { headers: appPrivateHeaders },
            ).pipe(
              HttpServerResponse.setCookie(cookie(id), Redacted.value(proof), {
                ...cookieOptions,
                maxAge: "10 minutes",
              }),
              Effect.orDie,
            );
          }),
        )
        .handle("complete", ({ payload }) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const { target, request } = yield* appRequest(config.port);
              const proof = Schema.decodeUnknownOption(AppSignInCode)(
                request.cookies[cookie(payload.request)],
              );
              if (Option.isNone(proof)) return yield* new UiUnauthorized();
              const verifier = yield* digest(proof.value);
              const now = yield* Clock.currentTimeMillis;
              const entry = yield* Ref.modify(attempts, (entries) => {
                const entry = entries.get(payload.request);
                if (
                  entry === undefined ||
                  entry.expiresAt <= now ||
                  entry.approval === undefined ||
                  entry.approval.expiresAt <= now ||
                  entry.target.app !== target.app ||
                  entry.target.origin !== target.origin ||
                  entry.verifier !== verifier ||
                  Redacted.value(entry.approval.code) !== Redacted.value(payload.code)
                )
                  return [undefined, entries] as const;
                const next = new Map(entries);
                next.delete(payload.request);
                return [entry, next] as const;
              });
              if (entry === undefined) return yield* new UiUnauthorized();
              yield* usable(target);
              const session = yield* auth
                .exchangeApp(target, payload.code)
                .pipe(
                  Effect.mapError((error) =>
                    Schema.is(PairingRejected)(error) ? new UiUnauthorized() : unavailable(),
                  ),
                );
              return yield* HttpServerResponse.jsonUnsafe(
                { returnTo: entry.returnTo },
                { headers: appPrivateHeaders },
              ).pipe(
                HttpServerResponse.setCookie(
                  appSessionCookie(config.port),
                  Redacted.value(session),
                  { httpOnly: true, sameSite: "lax", path: "/", maxAge: "7 days" },
                ),
                Effect.flatMap(
                  HttpServerResponse.expireCookie(cookie(payload.request), cookieOptions),
                ),
                Effect.orDie,
              );
            }),
          ),
        ),
    );
    const authorize = HttpApiBuilder.group(AppAuthenticationApi, "appAuthentication", (handlers) =>
      handlers.handle("authorize", ({ payload }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const request = yield* localRequest(config.port, config.browserOrigin).pipe(
              Effect.mapError(() => new UiForbidden()),
            );
            const parent = yield* auth
              .identify(request.cookies[sessionCookie(config)])
              .pipe(Effect.mapError(unavailable));
            if (parent === undefined) return yield* new UiUnauthorized();
            const entry = yield* active(payload.request);
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
              new Map(entries).set(payload.request, { ...entry, approval }),
            );
            const callback = new URL("/_executor/auth/callback", entry.target.origin);
            callback.hash = new URLSearchParams({
              request: payload.request,
              code: Redacted.value(approval.code),
            }).toString();
            return { url: Redacted.make(callback.href) };
          }),
        ),
      ),
    );
    // Both groups share the same attempts. The composition root mounts each on its own host router.
    return { app: handlers, dashboard: authorize };
  });
