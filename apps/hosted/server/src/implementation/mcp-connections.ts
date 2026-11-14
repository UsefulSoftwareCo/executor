/** Members manage their own connections and connected agents; apps and accounts use the same access checks as calls. */
import { isToolSelectionSubset } from "@executor-js/authorization";
import {
  ConnectionAccessInvalid,
  ConnectionId,
  ConnectionNotFound,
  connectionPermissions,
  type Connection,
  type ConnectionApp,
  type ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import { mcpResource } from "@executor-js/mcp-auth";
import {
  callerConnectionHeader,
  CurrentCaller,
  type App,
  type Executor,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest } from "effect/http";
import { HostedApi } from "../contracts/api.ts";
import { CurrentPrincipal, CurrentUserId } from "../contracts/auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { McpAuthentication, type McpConnectionStore } from "../contracts/mcp.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import { checkAccounts, currentOwner, usableApp } from "./access.ts";
import { addLink, linkedAccounts, lockedChange } from "./app-accounts.ts";
import {
  currentResourceAuthority,
  policyDatabase,
  requireAccountOwnerAs,
} from "./resource-policy.ts";

import { audited } from "./security-audit.ts";

const owner = Effect.gen(function* () {
  const organization = yield* CurrentOrganization;
  const userId = yield* CurrentUserId;
  if (userId === undefined) return yield* new OrganizationForbidden();
  return { userId, resource: organization.organization };
});

/**
 * Who may change connections through this request. Any current member manages their own, from a
 * browser session or from a bearer that RequireOrganization accepted for `manage` (an API key or a
 * full API grant; MCP tokens never reach the API). A self-call from a scoped MCP connection is
 * limited to that connection's policy before this runs. The store returns and changes only that
 * member's connections. Bearer changes are logged with the caller and, when the host attached
 * one, the calling connection.
 */
const manager = (
  action: "list" | "create" | "update" | "revoke" | "mint-key" | "list-keys" | "revoke-key",
  connection?: string,
) =>
  Effect.gen(function* () {
    const current = yield* owner;
    const person = yield* Effect.serviceOption(CurrentPrincipal);
    // Minting and revoking a key record their own audit line for every caller, with the key.
    if (
      Option.isNone(person) &&
      (action === "create" || action === "update" || action === "revoke")
    )
      yield* Effect.logInfo("MCP connection changed with an API credential").pipe(
        Effect.annotateLogs({
          "executor.audit": "mcp-connection",
          "executor.audit.action": action,
          "executor.user.id": current.userId,
          "executor.organization.id": current.resource,
          ...(connection === undefined ? {} : { "executor.mcp.connection": connection }),
          ...(yield* callerAudit),
        }),
      );
    return current;
  });

/** The host-attached calling connection, or undefined when this request did not arrive on one. */
const callingConnection = (auth: { readonly connections: McpConnectionStore }) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const header = new Headers(request.headers).get(callerConnectionHeader);
    if (header === null || header === "") return undefined;
    const id = yield* Schema.decodeUnknownEffect(ConnectionId)(header).pipe(
      Effect.mapError(() => new OrganizationForbidden()),
    );
    const current = yield* owner;
    const found = (yield* auth.connections.list(current)).find(
      (connection) => connection.id === id,
    );
    if (found === undefined) return yield* new OrganizationForbidden();
    return found;
  });

/**
 * A connection whose every app grants all of its tools and events may manage connections inside
 * that policy. Read-only and selected tool scopes do not: they have no `manage` authority.
 */
const connectionMayManage = (policy: ConnectionPolicy) =>
  policy.apps.length > 0 &&
  policy.apps.every(
    (app) => app.tools.kind === "all" && (app.events === undefined || app.events.kind === "all"),
  );

/** The next policy is no wider than the calling connection: apps, tools, events and runsAs. */
const withinCallingConnection = (caller: ConnectionPolicy, next: ConnectionPolicy) =>
  isToolSelectionSubset(
    { kind: "tools", apps: connectionPermissions(caller) },
    { kind: "tools", apps: connectionPermissions(next) },
  );

/**
 * Refuse a calling connection that cannot manage, and a change whose policy is wider than that
 * connection. No calling connection keeps the member's own full authority.
 */
const requireCallingScope = (caller: Connection | undefined, next?: ConnectionPolicy) =>
  Effect.gen(function* () {
    if (caller === undefined) return;
    if (!connectionMayManage(caller.policy)) return yield* new OrganizationForbidden();
    if (next !== undefined && !withinCallingConnection(caller.policy, next))
      return yield* new OrganizationForbidden();
  });

/** Caller kind and the host-attached connection, for the connection audit lines. */
const callerAudit = Effect.gen(function* () {
  const caller = Option.getOrUndefined(yield* Effect.serviceOption(CurrentCaller));
  const request = yield* HttpServerRequest.HttpServerRequest;
  const connection = new Headers(request.headers).get(callerConnectionHeader);
  return {
    ...(caller === undefined ? {} : { "executor.caller.kind": caller.kind }),
    ...(connection === null || connection === ""
      ? {}
      : { "executor.mcp.caller_connection": connection }),
  };
});

/**
 * Check one app's runs-as targets. An account target the member has not linked to any of the app's
 * user requirements is linked to each one its provider fills, as linking it from the app would: a
 * plain requirement's previous link is replaced.
 */
const resolveApp = (
  executor: Executor,
  organizationOwner: OwnerId,
  userId: string,
  input: ConnectionApp,
) =>
  Effect.gen(function* () {
    const invalid = (reason: ConnectionAccessInvalid["reason"]) =>
      new ConnectionAccessInvalid({ app: input.app, reason });
    const app: App = yield* usableApp(executor, organizationOwner, input.app).pipe(
      Effect.catchTags({
        AppNotFound: () => Effect.fail(invalid("app")),
        OrganizationForbidden: () => Effect.fail(invalid("app")),
      }),
    );
    // Grants and connections name only the caller's own accounts; app access authorizes the
    // app links.
    const requirements = Object.entries(app.requirements.accounts)
      .filter(([, requirement]) => requirement.scope === "user")
      .map(([slot, requirement]) => ({ slot, ...requirement }));
    const sql = yield* policyDatabase;
    const linked = yield* Effect.forEach(input.runsAs, (target) =>
      Effect.gen(function* () {
        if (target.kind === "app") {
          if (requirements.length > 0) return yield* invalid("target");
          return false;
        }
        const account = yield* executor.accounts
          .get({ owner: organizationOwner, account: target.id })
          .pipe(Effect.catchTag("AccountNotFound", () => Effect.fail(invalid("account"))));
        if (!requirements.some((requirement) => requirement.provider === account.provider))
          return yield* invalid("account");
        yield* checkAccounts(organizationOwner, { account: account.id }).pipe(
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
        // Group-shared accounts are usable by the group. A connection may run only as an account
        // this member owns: their personal account.
        const actor = yield* currentResourceAuthority.pipe(
          Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("account"))),
        );
        yield* requireAccountOwnerAs(actor, account.id).pipe(
          Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("account"))),
        );
        const linked = yield* linkedAccounts(sql, { subject: userId, apps: [app.id] });
        if (linked.some((link) => link.id === account.id)) return false;
        // Check both again under the app's link lock: either may have been revoked while the
        // change waited for it (see `lockedChange`).
        return yield* lockedChange(executor, { app: app.id, access: "use" }, (locked, actor) =>
          Effect.gen(function* () {
            yield* requireAccountOwnerAs(actor, account.id).pipe(
              Effect.catchTag("OrganizationForbidden", () => Effect.fail(invalid("account"))),
            );
            return yield* Effect.forEach(
              requirements.filter((requirement) => requirement.provider === account.provider),
              (requirement) =>
                addLink(locked, executor.webhooks, {
                  app: app.id,
                  requirement: requirement.slot,
                  account: account.id,
                  subject: userId,
                  linkedBy: userId,
                }),
            );
          }),
        ).pipe(
          Effect.map((changed) => changed.some(Boolean)),
          Effect.catchTags({
            OrganizationForbidden: () => Effect.fail(invalid("app")),
            RequirementMismatch: () => Effect.fail(invalid("account")),
            AccountNotFound: () => Effect.fail(invalid("account")),
          }),
        );
      }),
    );
    if (linked.some(Boolean)) yield* Effect.flatten(ScheduleWakeup);
    return input;
  });

const resolvePolicy = (apps: readonly ConnectionApp[]) =>
  Effect.gen(function* () {
    const { userId } = yield* owner;
    const organizationOwner = yield* currentOwner;
    const executor = yield* Effect.flatten(HostedExecutor);
    return {
      apps: yield* Effect.forEach(apps, (app) =>
        resolveApp(executor, organizationOwner, userId, app),
      ),
    };
  });

/**
 * Membership is current. A request the host marked with a calling connection may create, update
 * and mint only within that connection's policy, and a narrowed connection without manage is
 * refused. Key lifetime stays inside the declared 5-second to 90-day bound.
 */

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
          Effect.gen(function* () {
            yield* requireCallingScope(yield* callingConnection(auth));
            return (yield* auth.connections.list(yield* manager("list"))).map(view);
          }),
        )
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            // Refuse a wider policy before linking any account for it.
            yield* requireCallingScope(yield* callingConnection(auth), { apps: payload.apps });
            const current = yield* manager("create", payload.id);
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.create(current, {
                id: payload.id,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            const caller = yield* callingConnection(auth);
            yield* requireCallingScope(caller);
            const current = yield* owner;
            const found = (yield* auth.connections.list(current)).find(
              (connection) => connection.id === params.connection,
            );
            if (found === undefined)
              return yield* new ConnectionNotFound({ connection: params.connection });
            yield* requireCallingScope(caller, found.policy);
            yield* requireCallingScope(caller, { apps: payload.apps });
            const actor = yield* manager("update", params.connection);
            const policy = yield* resolvePolicy(payload.apps);
            return view(
              yield* auth.connections.update(actor, {
                id: params.connection,
                name: payload.name,
                policy,
              }),
            );
          }),
        )
        .handle("revoke", ({ params }) =>
          Effect.gen(function* () {
            const caller = yield* callingConnection(auth);
            yield* requireCallingScope(caller);
            if (caller !== undefined) {
              const found = (yield* auth.connections.list(yield* owner)).find(
                (connection) => connection.id === params.connection,
              );
              if (found !== undefined) yield* requireCallingScope(caller, found.policy);
            }
            return yield* auth.connections.revoke(
              yield* manager("revoke", params.connection),
              params.connection,
            );
          }).pipe(
            audited("mcp_connection.revoke", { kind: "mcp_connection", id: (revoked) => revoked }),
            Effect.asVoid,
          ),
        )
        .handle("mintKey", ({ params, payload }) =>
          Effect.gen(function* () {
            // Only the connection's owner: the store mints only for the caller's own standing
            // connection, and reports any other as not found.
            const caller = yield* callingConnection(auth);
            yield* requireCallingScope(caller);
            if (caller !== undefined) {
              const found = (yield* auth.connections.list(yield* owner)).find(
                (connection) => connection.id === params.connection,
              );
              if (found !== undefined) yield* requireCallingScope(caller, found.policy);
            }
            const current = yield* manager("mint-key", params.connection);
            const minted = yield* auth.connections.mintKey(current, {
              id: params.connection,
              name: payload.name ?? `Connection key: ${params.connection}`,
              expiresIn: payload.expiresInSeconds,
            });
            const person = yield* Effect.serviceOption(CurrentPrincipal);
            yield* Effect.logInfo("MCP connection key minted").pipe(
              Effect.annotateLogs({
                "executor.audit": "mcp-connection-key",
                "executor.audit.action": "mint",
                "executor.audit.via": Option.isSome(person) ? "browser" : "api-credential",
                "executor.user.id": current.userId,
                "executor.organization.id": current.resource,
                "executor.mcp.connection": params.connection,
                "executor.api_key.id": minted.id,
                "executor.api_key.expires_at": minted.expiresAt,
                ...(yield* callerAudit),
              }),
            );
            return {
              id: minted.id,
              key: minted.key,
              connection: params.connection,
              url: mcpResource(auth.resourceOrigins.mcp[0], {
                mode: "model",
                connection: params.connection,
              }),
              expiresAt: minted.expiresAt,
            };
          }),
        )
        .handle("listKeys", ({ params }) =>
          Effect.gen(function* () {
            // Only the connection's owner: the store reports any other connection as not found.
            const caller = yield* callingConnection(auth);
            yield* requireCallingScope(caller);
            if (caller !== undefined) {
              const found = (yield* auth.connections.list(yield* owner)).find(
                (connection) => connection.id === params.connection,
              );
              if (found !== undefined) yield* requireCallingScope(caller, found.policy);
            }
            return yield* auth.connections.keys(
              yield* manager("list-keys", params.connection),
              params.connection,
            );
          }),
        )
        .handle("revokeKey", ({ params }) =>
          Effect.gen(function* () {
            const caller = yield* callingConnection(auth);
            yield* requireCallingScope(caller);
            if (caller !== undefined) {
              const found = (yield* auth.connections.list(yield* owner)).find(
                (connection) => connection.id === params.connection,
              );
              if (found !== undefined) yield* requireCallingScope(caller, found.policy);
            }
            const current = yield* manager("revoke-key", params.connection);
            yield* auth.connections.revokeKey(current, {
              id: params.connection,
              key: params.key,
            });
            const person = yield* Effect.serviceOption(CurrentPrincipal);
            yield* Effect.logInfo("MCP connection key revoked").pipe(
              Effect.annotateLogs({
                "executor.audit": "mcp-connection-key",
                "executor.audit.action": "revoke",
                "executor.audit.via": Option.isSome(person) ? "browser" : "api-credential",
                "executor.user.id": current.userId,
                "executor.organization.id": current.resource,
                "executor.mcp.connection": params.connection,
                "executor.api_key.id": params.key,
                ...(yield* callerAudit),
              }),
            );
          }),
        )
        .handle("agents", () =>
          Effect.flatMap(owner, (current) => auth.connections.agents(current)),
        )
        .handle("revokeAgent", ({ params }) =>
          Effect.flatMap(owner, (current) =>
            auth.connections.revokeAgent(current, params.agent),
          ).pipe(
            audited("mcp_agent.revoke", { kind: "mcp_agent", id: (revoked) => revoked }),
            Effect.asVoid,
          ),
        );
    }),
);
