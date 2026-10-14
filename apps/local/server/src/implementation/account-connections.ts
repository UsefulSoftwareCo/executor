/** Host-owned signed browser links over the reusable SDK lifecycle. */
import { Effect, Layer, Redacted } from "effect";
import { Hex } from "effect/encoding";
import { HttpApiBuilder } from "effect/http-api";
import {
  type Executor,
  CredentialsError,
  type AccountId,
  type AccountScope,
  type AppId,
  type CreateAccountConnection,
} from "@executor-js/sdk/core";
import {
  AccountConnectApi,
  ConnectionLinkRejected,
  type ConnectionGrant,
} from "../contracts/account-connections.ts";
import { AuthForbidden, PairingUnauthorized } from "../contracts/auth.ts";
import { OAuthCallbackPath } from "../contracts/dashboard.ts";
import type { ServerConfig } from "../contracts/config.ts";
import { localRequest, requestOrigin } from "./auth.ts";
import { connectOptions, connectionClient } from "./oauth-clients.ts";
import { executorAppOwner, localOwner } from "./owners.ts";
import { requireScopedRequirement } from "./app-accounts.ts";

/**
 * A connected account belongs to the owner local gives the app it is connected for: `local`, or
 * `executor-local` for the server's own Executor app. Neither the caller's owner nor the app's
 * stored one is trusted; an app stored under another owner is not found.
 */
export const connectForApp = (
  executor: Executor,
  managedApp: AppId | undefined,
  input: Omit<typeof CreateAccountConnection.Type, "owner">,
) => {
  const owner = input.target.app === managedApp ? executorAppOwner : localOwner;
  return executor.apps
    .get({ app: input.target.app, owner })
    .pipe(Effect.andThen(executor.accountConnections.create({ ...input, owner })));
};

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
          const decoded = Hex.decode(Redacted.value(grant.token));
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
      /**
       * Issue a signed browser link for an app requirement, for the agent's own API key only. The
       * local server's own app and account are never connected this way.
       */
      const issue = (payload: Omit<typeof CreateAccountConnection.Type, "owner">) =>
        Effect.gen(function* () {
          const request = yield* localRequest(config.port, config.browserOrigin);
          if (request.headers.origin !== undefined) return yield* new AuthForbidden();
          if (request.headers.authorization !== `Bearer ${Redacted.value(config.apiKey)}`)
            return yield* new PairingUnauthorized();
          if (payload.account === managed.account || payload.target.app === managed.app)
            return yield* new ConnectionLinkRejected();
          const connection = yield* connectForApp(executor, managed.app, payload);
          const signed = yield* Effect.tryPromise({
            try: () => crypto.subtle.sign("HMAC", key, message(connection.id)),
            catch: () => new CredentialsError(),
          });
          const url = new URL(
            `/account-connect/${encodeURIComponent(connection.id)}`,
            requestOrigin(config, request),
          );
          url.hash = `token=${Hex.encode(new Uint8Array(signed))}`;
          return {
            connection: connection.id,
            url: Redacted.make(url.href),
            expiresAt: connection.expiresAt,
          };
        });
      /**
       * A scope's connect route, as `appAccounts.<scope>.connect`: the app must declare the
       * requirement in that scope. The connection keeps that scope, so completing it refuses a
       * requirement redeployed into the other one instead of linking in a scope nobody chose.
       */
      const scopeConnect =
        (scope: AccountScope) =>
        ({
          params,
          payload,
        }: {
          readonly params: { readonly app: AppId; readonly requirement: string };
          readonly payload: { readonly account?: AccountId | undefined };
        }) =>
          requireScopedRequirement(executor, { ...params, scope }).pipe(
            Effect.andThen(
              issue({
                target: { app: params.app, requirement: params.requirement, scope },
                ...(payload.account === undefined ? {} : { account: payload.account }),
              }),
            ),
          );
      const handlers = HttpApiBuilder.group(AccountConnectApi, "accountConnect", (handlers) =>
        handlers
          .handle("issue", ({ payload }) => issue(payload))
          .handle("appConnect", scopeConnect("app"))
          .handle("userConnect", scopeConnect("user"))
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
              return yield* connectOptions(executor, {
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
              const connection = yield* executor.accountConnections.get(payload);
              const { client: selected, ...rest } = payload;
              const client = yield* connectionClient(connection, {
                method: payload.method,
                client: selected,
              });
              return yield* executor.accountConnections.startOAuth({
                ...rest,
                ...(client === undefined ? {} : { client }),
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
