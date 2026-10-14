/** The paired operator's scoped connections. Stored with the local OAuth grants. */
import {
  Connection,
  ConnectionAccessInvalid,
  ConnectionIdTaken,
  ConnectionNotFound,
  type ConnectionApp,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import type { Executor } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { DashboardApi } from "../contracts/dashboard.ts";
import { AuthStorageError } from "../contracts/auth.ts";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";
import type { SqlClient } from "effect/sql";
import { linkedAccounts } from "./app-accounts.ts";

/**
 * Check one app's runs-as targets: the app itself for an app without user requirements, or
 * accounts linked to the app.
 */
const resolveApp = (sql: SqlClient.SqlClient, executor: Executor, input: ConnectionApp) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app = yield* executor.apps
      .get({ app: input.app })
      .pipe(Effect.catchTag("AppNotFound", () => Effect.fail(invalid("app"))));
    // Connections name only user links; the app links need no target.
    const needsAccount = Object.values(app.requirements.accounts).some(
      (requirement) => requirement.scope === "user",
    );
    const linked = new Set(
      (yield* linkedAccounts(sql, executor, app)).map((account) => account.id),
    );
    yield* Effect.forEach(input.runsAs, (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (needsAccount) return yield* invalid("target");
          return;
        }
        if (!linked.has(target.id)) return yield* invalid("account");
      }),
    );
    return input;
  });

/** Pairing authorizes these handlers; the OAuth store owns the records. */
export const localMcpConnectionHandlers = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  oauth: LocalMcpOAuth,
) =>
  HttpApiBuilder.group(DashboardApi, "mcpConnections", (handlers) => {
    const view = (value: unknown) =>
      Schema.decodeUnknownEffect(Connection)(value).pipe(
        Effect.mapError(() => new AuthStorageError()),
        Effect.map((connection) => ({
          ...connection,
          url: mcpResource(oauth.origin, { mode: "model", connection: connection.id }),
        })),
      );
    const list = oauth.connections.list.pipe(
      Effect.mapError(() => new AuthStorageError()),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(Schema.Array(Connection))(value).pipe(
          Effect.mapError(() => new AuthStorageError()),
        ),
      ),
    );
    const resolve = (apps: readonly ConnectionApp[]) =>
      Effect.forEach(apps, (app) => resolveApp(sql, executor, app)).pipe(
        Effect.map((resolved) => ({ apps: resolved })),
      );
    return handlers
      .handle("list", () =>
        list.pipe(
          Effect.map((connections) =>
            connections.map((connection) => ({
              ...connection,
              url: mcpResource(oauth.origin, { mode: "model", connection: connection.id }),
            })),
          ),
        ),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const policy = yield* resolve(payload.apps);
          const saved = yield* oauth.connections
            .create({ id: payload.id, name: payload.name, policy })
            .pipe(
              Effect.mapError((status) =>
                status === 409
                  ? new ConnectionIdTaken({ connection: payload.id })
                  : new AuthStorageError(),
              ),
            );
          return yield* view(saved);
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          if (!(yield* list).some((connection) => connection.id === params.connection))
            return yield* new ConnectionNotFound({ connection: params.connection });
          const policy = yield* resolve(payload.apps);
          const saved = yield* oauth.connections
            .update({ id: params.connection, name: payload.name, policy })
            .pipe(
              Effect.mapError((status) =>
                status === 404
                  ? new ConnectionNotFound({ connection: params.connection })
                  : new AuthStorageError(),
              ),
            );
          return yield* view(saved);
        }),
      )
      .handle("revoke", ({ params }) =>
        oauth.connections.revoke(params.connection).pipe(
          Effect.asVoid,
          Effect.mapError((status) =>
            status === 404
              ? new ConnectionNotFound({ connection: params.connection })
              : new AuthStorageError(),
          ),
        ),
      );
  });
