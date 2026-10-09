/** Members manage their own connections and connected agents; apps, profiles and accounts use the same access checks as calls. */
import {
  bareAccountProfileKey,
  bareAccountSelection,
  ConnectionAccessInvalid,
  ConnectionNotFound,
  type Connection,
  type ConnectionApp,
  type ConnectionAppInput,
  type ConnectionId,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import type { RunTarget } from "@executor-js/authorization";
import type { App, Executor, OwnerId } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { checkAccounts, currentOwner, ownProfile, selectedApp } from "./access.ts";

const owner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  return { userId, resource: organization.organization };
});

const targetKey = (target: RunTarget) => (target.kind === "app" ? "app" : target.id);

/**
 * Resolve one app's runs-as choices to saved targets. A bare account becomes the member's
 * own profile for this app, named after the account; creation is idempotent per connection.
 */
const resolveApp = (
  executor: Executor,
  organizationOwner: OwnerId,
  userId: string,
  connection: ConnectionId,
  input: ConnectionAppInput,
) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app: App = yield* selectedApp(executor, organizationOwner, input.app).pipe(
      Effect.catchTags({
        AppNotFound: () => Effect.fail(invalid("app")),
        OrganizationForbidden: () => Effect.fail(invalid("app")),
      }),
    );
    const needsAccount = Object.keys(app.requirements.accounts).length > 0;
    const runsAs = yield* Effect.forEach(input.runsAs, (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (needsAccount) return yield* invalid("target");
          return target;
        }
        if (target.kind === "profile") {
          // Only the member's own live profile, with accounts they may still use.
          const profile = yield* ownProfile(executor, organizationOwner, app.id, target.id).pipe(
            Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("profile"))),
          );
          if (profile.status === "removed" || profile.status === "removing")
            return yield* invalid("profile");
          yield* checkAccounts(organizationOwner, profile.accounts).pipe(
            Effect.catchTags({
              OrganizationForbidden: () => Effect.fail(invalid("profile")),
              AccountNotFound: () => Effect.fail(invalid("profile")),
            }),
          );
          return target;
        }
        const account = yield* executor.accounts
          .get({ owner: organizationOwner, account: target.id })
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(invalid("account"))));
        const accounts = bareAccountSelection(app.requirements.accounts, account);
        if (accounts === undefined) return yield* invalid("account");
        yield* checkAccounts(organizationOwner, accounts).pipe(
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
        const profile = yield* executor.apps.profiles.create({
          app: app.id,
          owner: organizationOwner,
          subject: userId,
          accounts,
          ...(account.label.trim() === "" ? {} : { name: account.label.slice(0, 128) }),
          idempotencyKey: bareAccountProfileKey(connection, account.id),
        });
        yield* Effect.flatten(ScheduleWakeup);
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

const resolvePolicy = (connection: ConnectionId, apps: readonly ConnectionAppInput[]) =>
  Effect.gen(function* () {
    const { userId } = yield* owner;
    const organizationOwner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    return {
      apps: yield* Effect.forEach(apps, (app) =>
        resolveApp(executor, organizationOwner, userId, connection, app),
      ),
    };
  });

/** RequireUser rejects bearer credentials; RequireOrganization checks current membership. */
export const hostedMcpConnectionHandlers = HttpApiBuilder.group(
  HostedApi,
  "mcpConnections",
  (handlers) =>
    Effect.gen(function* () {
      const auth = yield* McpAuthentication;
      const view = (connection: Connection) => ({
        ...connection,
        url: mcpResource(auth.resourceOrigins.mcp[0], { mode: "model", connection: connection.id }),
      });
      return handlers
        .handle("list", () =>
          Effect.flatMap(owner, (current) => auth.connections.list(current)).pipe(
            Effect.map((connections) => connections.map(view)),
          ),
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            const policy = yield* resolvePolicy(payload.id, payload.apps);
            return view(
              yield* auth.connections.create(yield* owner, {
                id: payload.id,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            // Check ownership before creating any profile for this connection.
            const existing = yield* auth.connections.list(yield* owner);
            if (!existing.some((connection) => connection.id === params.connection))
              return yield* new ConnectionNotFound({ connection: params.connection });
            const policy = yield* resolvePolicy(params.connection, payload.apps);
            return view(
              yield* auth.connections.update(yield* owner, {
                id: params.connection,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("revoke", ({ params }) =>
          Effect.flatMap(owner, (current) => auth.connections.revoke(current, params.connection)),
        )
        .handle("agents", () =>
          Effect.flatMap(owner, (current) => auth.connections.agents(current)),
        )
        .handle("revokeAgent", ({ params }) =>
          Effect.flatMap(owner, (current) => auth.connections.revokeAgent(current, params.agent)),
        );
    }),
);
