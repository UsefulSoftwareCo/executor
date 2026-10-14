/**
 * The organization's OAuth sign-in clients. The executor stores them under the organization's
 * owner; this product decides who may manage them (administrators) and who may connect with
 * them (each client's audience), and rechecks both on every call.
 */
import {
  OAuthClientNotEditable,
  OAuthClientReference,
  StorageError,
  StorageHost,
  type Executor,
  type HttpUrl,
  type OAuthClient,
  type OAuthClientId,
  type OAuthClientSelection,
  type OwnerId,
  type ProviderId,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { Authentication } from "../contracts/auth.ts";
import { accountOAuthRedirectUri } from "./auth.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { OrganizationForbidden, organizationOwner } from "../contracts/organization.ts";
import {
  AccessConflict,
  type AccessRevision,
  type AppAudience,
} from "../contracts/resource-access.ts";
import { requireGroupSharing } from "./group-sharing.ts";
import { oauthClientAudience } from "./resource-lifecycle.ts";
import {
  currentResourceAuthority,
  oauthClientAccesses,
  policyDatabase,
  requireOAuthClientAccessAs,
  type ResourceAuthority,
} from "./resource-policy.ts";

/** Current administrators only; the role is read again rather than trusted from the session. */
const administrator = Effect.gen(function* () {
  const actor = yield* currentResourceAuthority;
  if (actor.role === "member") return yield* new OrganizationForbidden();
  return actor;
});

/** A browser sign-in method: an OAuth method other than client credentials. */
const signsInWithClient = (method: { readonly type: string; readonly grant?: string }) =>
  method.type === "oauth2" && method.grant !== "client_credentials";

/**
 * Every client of the organization with its policy, and the authorization servers its apps sign in
 * at, for administrators. A server is found as a sign-in finds it: declared endpoints name it, and
 * a provider that discovers its server is asked now. A provider whose discovery fails is listed as
 * unresolved rather than failing the whole view.
 */
export const oauthClientDirectory = (redirectUri: typeof HttpUrl.Type) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = organizationOwner(actor.organization);
    const clients = yield* executor.oauthClients.list({ owner });
    const policies = new Map(
      (yield* oauthClientAccesses(
        clients.map((client) => client.id),
        actor,
      )).map((access) => [access.client, access]),
    );
    const providers = new Map<ProviderId, string>();
    for (const app of yield* executor.apps.list({ owner }))
      for (const requirement of Object.values(app.requirements.accounts))
        if (Object.values(requirement.definition.auth).some(signsInWithClient))
          providers.set(requirement.provider, requirement.definition.name);
    const resolved = yield* Effect.forEach(
      [...providers],
      ([id, name]) =>
        executor.oauthClients.issuers({ provider: id }).pipe(
          Effect.map((methods) => ({ id, name, issuers: methods.map((method) => method.issuer) })),
          Effect.catch(() =>
            Effect.succeed({ id, name, issuers: [] as Array<typeof HttpUrl.Type> }),
          ),
        ),
      { concurrency: 4 },
    );
    const services = new Map<
      typeof HttpUrl.Type,
      Array<{ readonly id: ProviderId; readonly name: string }>
    >();
    for (const provider of resolved)
      for (const issuer of new Set(provider.issuers))
        services.set(issuer, [
          ...(services.get(issuer) ?? []),
          { id: provider.id, name: provider.name },
        ]);
    return {
      clients: clients.flatMap((client) => {
        const access = policies.get(client.id);
        return access === undefined ? [] : [{ client, access }];
      }),
      services: [...services].flatMap(([issuer, list]) => {
        const sorted = list.toSorted((a, b) => a.name.localeCompare(b.name));
        const [first, ...rest] = sorted;
        return first === undefined ? [] : [{ issuer, providers: [first, ...rest] as const }];
      }),
      unresolved: resolved
        .filter((provider) => provider.issuers.length === 0)
        .map(({ id, name }) => ({ id, name })),
      redirectUri,
    };
  });

/**
 * Register a client for the organization with its audience, everyone by default. The access
 * record is written with that audience, so the client is never usable by anyone else first.
 */
export const registerOAuthClient = ({
  audience = { kind: "everyone" },
  ...input
}: Omit<Parameters<Executor["oauthClients"]["register"]>[0], "owner"> & {
  readonly audience?: typeof AppAudience.Type | undefined;
}) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    // Refuse unknown groups before the client exists rather than leave it hidden.
    if (audience.kind === "groups")
      yield* requireGroupSharing(
        yield* policyDatabase,
        actor.organization,
        actor.user,
        audience.groups,
      );
    const executor = yield* Effect.flatten(HostedExecutor);
    const client = yield* executor.oauthClients
      .register({ ...input, owner: organizationOwner(actor.organization) })
      .pipe(oauthClientAudience(audience));
    const access = yield* requireOAuthClientAccessAs(actor, client.id, "manage");
    return { client, access };
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Remove a client; accounts connected with it keep the copy their grants hold. */
export const removeOAuthClient = (client: OAuthClientId) =>
  Effect.gen(function* () {
    const actor = yield* administrator;
    const executor = yield* Effect.flatten(HostedExecutor);
    yield* requireOAuthClientAccessAs(actor, client, "manage");
    return yield* executor.oauthClients.remove({
      owner: organizationOwner(actor.organization),
      client,
    });
  });

/** Group order carries no meaning; the policy reads them sorted. */
const sameAudience = (a: typeof AppAudience.Type, b: typeof AppAudience.Type) =>
  a.kind === "groups" && b.kind === "groups"
    ? [...a.groups].sort().join("\n") === [...b.groups].sort().join("\n")
    : a.kind === b.kind;

/**
 * Edit a registered client's details and audience. The client's credentials, its audience, its
 * group grants and its access revision commit in one transaction, the way registering a client
 * records its access: through the executor's tracked transaction, which this product's SQL shares,
 * so new details are never offered to an old audience, nor old details to a new one. The access row
 * is locked first and every edit is checked against the revision it was made from. Any change to
 * the credentials, audience or groups advances the revision.
 */
export const updateOAuthClient = (
  client: OAuthClientId,
  {
    audience,
    revision,
    ...details
  }: Omit<Parameters<Executor["oauthClients"]["update"]>[0], "owner" | "client"> & {
    readonly audience?: typeof AppAudience.Type | undefined;
    readonly revision: typeof AccessRevision.Type;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    const actor = yield* administrator;
    const executor = yield* Effect.flatten(HostedExecutor);
    const owner = organizationOwner(actor.organization);
    return yield* executor[StorageHost].transaction(
      Effect.gen(function* () {
        yield* sql`select client_id from hosted_oauth_client_access
      where client_id = ${client} and organization_id = ${actor.organization} for update`;
        const access = yield* requireOAuthClientAccessAs(actor, client, "manage");
        // Automatic clients are everyone's and keep the service's registration, so neither changes.
        const current = yield* executor.oauthClients.get({ owner, client });
        if (current.source !== "manual") return yield* new OAuthClientNotEditable({ client });
        if (access.revision !== revision) return yield* new AccessConflict({ reason: "changed" });
        const audienceChanged = audience !== undefined && !sameAudience(access.audience, audience);
        const credentialsChanged =
          (details.clientId !== undefined && details.clientId !== current.clientId) ||
          details.clientSecret !== undefined;
        if (audienceChanged) {
          if (audience.kind === "private" && access.creator === null)
            return yield* new AccessConflict({ reason: "creator_unavailable" });
          if (audience.kind === "groups")
            yield* requireGroupSharing(sql, actor.organization, actor.user, audience.groups);
          yield* sql`update hosted_oauth_client_access set audience = ${audience.kind}
        where client_id = ${client} and organization_id = ${actor.organization}`;
          yield* sql`delete from hosted_oauth_client_groups where client_id = ${client}`;
          if (audience.kind === "groups")
            for (const group of audience.groups)
              yield* sql`insert into hosted_oauth_client_groups (organization_id, client_id, group_id) values (${actor.organization}, ${client}, ${group})`;
        }
        const updated = credentialsChanged
          ? yield* executor.oauthClients.update({ ...details, owner, client })
          : current;
        if (audienceChanged || credentialsChanged)
          yield* sql`update hosted_oauth_client_access set revision = gen_random_uuid()::text
        where client_id = ${client} and organization_id = ${actor.organization}`;
        return {
          client: updated,
          access: yield* requireOAuthClientAccessAs(actor, client, "manage"),
        };
      }),
    );
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );

/** Registered clients for the server a sign-in uses that this member may sign in with. */
export const usableOAuthClients = (
  executor: Executor,
  owner: OwnerId,
  actor: ResourceAuthority,
  issuer: typeof HttpUrl.Type,
) =>
  Effect.gen(function* () {
    // Automatically registered clients are offered as the automatic choice, not one by one.
    const clients = (yield* executor.oauthClients.list({ owner, issuer })).filter(
      (client) => client.source === "manual",
    );
    const usable = new Set(
      (yield* oauthClientAccesses(
        clients.map((client) => client.id),
        actor,
      ))
        .filter((access) => access.canUse)
        .map((access) => access.client),
    );
    return clients.filter((client): client is OAuthClient => usable.has(client.id));
  });

/**
 * The client a member's connection names, refused early, as forbidden, outside its audience.
 * Without a choice the SDK signs in automatically, or a reconnect keeps its account's client.
 * Whatever the SDK resolves, it asks `oauthClientResolving` in the resource lifecycle before using
 * the client's credentials and again before completing, so this check is not the only one.
 */
export const connectionClient = (
  executor: Executor,
  owner: OwnerId,
  input: { readonly client?: OAuthClientSelection | undefined },
) =>
  Effect.gen(function* () {
    const selected = input.client;
    if (selected === undefined || !Schema.is(OAuthClientReference)(selected)) return selected;
    yield* requireOAuthClientAccessAs(yield* currentResourceAuthority, selected.id, "use");
    // The client must be the organization's; the SDK checks it against the connection again.
    const client = yield* executor.oauthClients.get({ owner, client: selected.id });
    return { id: client.id };
  });

/** Administrator management of the organization's OAuth clients. */
export const hostedOAuthClientHandlers = HttpApiBuilder.group(
  HostedApi,
  "oauthClients",
  (handlers) =>
    Effect.gen(function* () {
      const redirectUri = accountOAuthRedirectUri(yield* Authentication);
      return handlers
        .handle("list", () => oauthClientDirectory(redirectUri))
        .handle("register", ({ payload }) => registerOAuthClient(payload))
        .handle("remove", ({ params }) => removeOAuthClient(params.client))
        .handle("update", ({ params, payload }) => updateOAuthClient(params.client, payload));
    }),
);
