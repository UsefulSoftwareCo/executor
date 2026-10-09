/** The paired operator's scoped connections. Stored with the local OAuth grants. */
import {
  bareAccountProfileKey,
  bareAccountSelection,
  Connection,
  ConnectionAccessInvalid,
  ConnectionIdTaken,
  ConnectionNotFound,
  type ConnectionApp,
  type ConnectionAppInput,
  type ConnectionId,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import type { Executor } from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { DashboardApi } from "../contracts/dashboard.ts";
import { AuthStorageError } from "../contracts/auth.ts";
import type { LocalMcpOAuth } from "./mcp-oauth.ts";

const subject = "local";
const targetKey = (target: ConnectionApp["runsAs"][number]) =>
  target.kind === "app" ? "app" : target.id;

/** Resolve one app's runs-as choices; a bare account becomes a local profile named after it. */
const resolveApp = (executor: Executor, connection: ConnectionId, input: ConnectionAppInput) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app = yield* executor.apps
      .get({ app: input.app })
      .pipe(Effect.catchTag("AppNotFound", () => Effect.fail(invalid("app"))));
    const needsAccount = Object.keys(app.requirements.accounts).length > 0;
    const runsAs = yield* Effect.forEach(input.runsAs, (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (needsAccount) return yield* invalid("target");
          return target;
        }
        if (target.kind === "profile") {
          const profile = yield* executor.apps.profiles
            .get({ app: app.id, profile: target.id })
            .pipe(Effect.catchTag("ProfileNotFound", () => Effect.fail(invalid("profile"))));
          if (
            profile.app !== app.id ||
            profile.subject !== subject ||
            profile.status === "removed" ||
            profile.status === "removing"
          )
            return yield* invalid("profile");
          return target;
        }
        const account = yield* executor.accounts
          .get({ account: target.id })
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(invalid("account"))));
        const accounts = bareAccountSelection(app.requirements.accounts, account);
        if (accounts === undefined) return yield* invalid("account");
        const profile = yield* executor.apps.profiles.create({
          app: app.id,
          owner: app.owner,
          subject,
          accounts,
          ...(account.label.trim() === "" ? {} : { name: account.label.slice(0, 128) }),
          idempotencyKey: bareAccountProfileKey(connection, account.id),
        });
        if (profile.status === "removed" || profile.status === "removing")
          return yield* invalid("profile");
        return { kind: "profile" as const, id: profile.id };
      }),
    );
    const unique = [...new Map(runsAs.map((target) => [targetKey(target), target])).values()];
    const [first, ...rest] = unique;
    if (first === undefined) return yield* invalid("target");
    return {
      app: app.id,
      runsAs: [first, ...rest],
      tools: input.tools,
      ...(input.events === undefined ? {} : { events: input.events }),
    } satisfies ConnectionApp;
  });

/** Pairing authorizes these handlers; the OAuth store owns the records. */
export const localMcpConnectionHandlers = (executor: Executor, oauth: LocalMcpOAuth) =>
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
    const resolve = (connection: ConnectionId, apps: readonly ConnectionAppInput[]) =>
      Effect.forEach(apps, (app) => resolveApp(executor, connection, app)).pipe(
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
          const policy = yield* resolve(payload.id, payload.apps);
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
          // Check the connection before creating any profile for it.
          if (!(yield* list).some((connection) => connection.id === params.connection))
            return yield* new ConnectionNotFound({ connection: params.connection });
          const policy = yield* resolve(params.connection, payload.apps);
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
