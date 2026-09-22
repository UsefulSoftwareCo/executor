/** Host-owned signed browser links over the reusable SDK lifecycle. */
import { Effect, Encoding, Layer, Redacted } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type Executor, CredentialsError, type AccountId, type AppId } from "@executor-js/sdk/core";
import {
  AccountConnectApi,
  ConnectionLinkRejected,
  type ConnectionGrant,
} from "../contracts/account-connections.ts";
import { AuthForbidden, PairingUnauthorized } from "../contracts/auth.ts";
import { OAuthCallbackPath } from "../contracts/dashboard.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, requestOrigin } from "./auth.ts";

/** Sign only this purpose and connection ID. Existing links survive server restarts with the same key. */
export const accountConnectHandlers = (
  executor: Executor,
  config: ServerConfig,
  crypto: Crypto,
  managed: { readonly app: AppId; readonly account: AccountId },
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const key = yield* Effect.tryPromise({
        try: () =>
          crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(Redacted.value(config.apiKey)),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign", "verify"],
          ),
        catch: () => new CredentialsError(),
      });
      const message = (connection: string) =>
        new TextEncoder().encode(`executor:account-connect:v1:${connection}`);
      const authorize = (grant: ConnectionGrant) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          const decoded = Encoding.decodeHex(Redacted.value(grant.token));
          if (decoded._tag === "Failure") return yield* new ConnectionLinkRejected();
          const signature = decoded.success;
          const valid = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.verify(
                "HMAC",
                key,
                new Uint8Array(signature),
                message(grant.connection),
              ),
            catch: () => new ConnectionLinkRejected(),
          });
          if (!valid) return yield* new ConnectionLinkRejected();
          return request;
        });
      const handlers = HttpApiBuilder.group(AccountConnectApi, "accountConnect", (handlers) =>
        handlers
          .handle("issue", ({ payload }) =>
            Effect.gen(function* () {
              const request = yield* localRequest(config.port, config.browserOrigin);
              if (request.headers.origin !== undefined) return yield* new AuthForbidden();
              if (request.headers.authorization !== `Bearer ${Redacted.value(config.apiKey)}`)
                return yield* new PairingUnauthorized();
              if (payload.account === managed.account || payload.target?.app === managed.app)
                return yield* new ConnectionLinkRejected();
              const connection = yield* executor.accountConnections.create(payload);
              const signed = yield* Effect.tryPromise({
                try: () => crypto.subtle.sign("HMAC", key, message(connection.id)),
                catch: () => new CredentialsError(),
              });
              const url = new URL(
                `/account-connect/${encodeURIComponent(connection.id)}`,
                requestOrigin(config, request),
              );
              url.hash = `token=${Encoding.encodeHex(new Uint8Array(signed))}`;
              return {
                connection: connection.id,
                url: Redacted.make(url.href),
                expiresAt: connection.expiresAt,
              };
            }),
          )
          .handle("read", ({ payload }) =>
            authorize(payload).pipe(Effect.andThen(executor.accountConnections.get(payload))),
          )
          .handle("cancel", ({ payload }) =>
            authorize(payload).pipe(Effect.andThen(executor.accountConnections.cancel(payload))),
          )
          .handle("submit", ({ payload }) =>
            authorize(payload).pipe(Effect.andThen(executor.accountConnections.submit(payload))),
          )
          .handle("oauthSetup", ({ payload }) =>
            Effect.gen(function* () {
              const request = yield* authorize(payload);
              const connection = yield* executor.accountConnections.get(payload);
              return yield* executor.accountConnections.oauthSetup({
                owner: connection.owner,
                provider: connection.provider.id,
                method: payload.method,
                redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
              });
            }),
          )
          .handle("startOAuth", ({ payload }) =>
            Effect.gen(function* () {
              const request = yield* authorize(payload);
              return yield* executor.accountConnections.startOAuth({
                ...payload,
                redirectUri: new URL(OAuthCallbackPath, requestOrigin(config, request)).href,
              });
            }),
          )
          .handle("completeOAuth", ({ payload }) =>
            authorize(payload).pipe(
              Effect.andThen(executor.accountConnections.completeOAuth(payload)),
            ),
          ),
      );
      return handlers;
    }),
  );
