import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { refreshProfiles } from "./profiles.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Organization-specific app queries and mutations use the shared hosted API. */
import {
  AppId,
  ProfileId,
  DeploymentId,
  AccountConnectionId,
  AccountConnectionTargetChanged,
  type AccountConnection,
  type ProviderId,
  HttpUrl,
  type App,
  type Account,
  type AccountFieldsInput,
  type SelectedAccounts,
  type OAuthClientInput,
  type ToolName,
  type Json,
} from "@executor-js/sdk";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { Data, Effect, Option, Schema, type Redacted } from "effect";
import { HostedClient } from "./api.ts";
import { acknowledge, upsert, currentQuery, invalidate } from "@executor-js/ui/contracts/mutations";
import { inventoryAtom } from "./organization.ts";
import { accountAtom, acknowledgeAccount } from "./accounts.ts";
import { selectedIds } from "@executor-js/ui/contracts/dashboard";

/** App data is never reused between organizations. */
class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class SourceKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId;
}> {}
class SourceFileKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId;
  readonly path: string;
}> {}
class ConnectionKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly connection: AccountConnectionId;
}> {}

class OAuthSetupKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly provider: ProviderId;
  readonly method: string;
}> {}
const oauthSetupQuery = Atom.family((key: OAuthSetupKey) =>
  HostedClient.query("accounts", "oauthSetup", { params: key }).pipe(
    Atom.setIdleTTL("5 minutes"),
    Atom.refreshOnWindowFocus,
  ),
);
/** Safe client capability hints are shared across forms for the same organization, provider, and method. */
export const oauthSetupAtom = (key: {
  organization: OrganizationReference;
  provider: ProviderId;
  method: string;
}) => oauthSetupQuery(new OAuthSetupKey(key));

const appQuery = Atom.family(
  (key: { readonly organization: OrganizationReference; readonly app: AppId }) =>
    HostedClient.query("apps", "get", { params: key }).pipe(
      Atom.refreshOnWindowFocus,
      protectedQuery,
    ),
);
const deploymentsQuery = Atom.family((key: AppKey) =>
  HostedClient.query("apps", "deployments", { params: key }).pipe(Atom.refreshOnWindowFocus),
);
const sourceQuery = Atom.family((key: SourceKey) =>
  HostedClient.query("apps", "sourceDisplay", {
    params: { organization: key.organization, app: key.app },
    query: { deployment: key.deployment },
  }),
);
const sourceFileQuery = Atom.family((key: SourceFileKey) =>
  HostedClient.query("apps", "sourceDisplayFile", {
    params: { organization: key.organization, app: key.app, deployment: key.deployment },
    query: { path: key.path },
  }).pipe(Atom.setIdleTTL("5 minutes")),
);
/** One page evaluates the current app/account catalog. */
class ToolKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment?: DeploymentId | undefined;
  readonly profile?: ProfileId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly accounts?: string | undefined;
}> {}
const toolsQuery = Atom.family((key: ToolKey) =>
  HostedClient.query("tools", "list", {
    params: key,
    query: {
      deployment: key.deployment,
      profile: key.profile,
      expectedProfileRevision: key.expectedProfileRevision,
    },
  }).pipe(currentQuery),
);
/** Pending credentials are fetched without reading saved secrets. */
const connectionQuery = Atom.family(
  (key: {
    readonly organization: OrganizationReference;
    readonly connection: AccountConnectionId;
  }) => HostedClient.query("accounts", "connection", { params: key }),
);
/** Catalog installation, selection, connection and execution actions. */
const activateApp = Atom.family((key: AppKey) =>
  HostedClient.runtime.fn(
    (payload: { deployment: DeploymentId; expectedDeployment: DeploymentId | null }, get) =>
      Effect.flatMap(HostedClient, (client) => client.apps.activate({ params: key, payload })).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            acknowledgeApp(get, key.organization, saved);
            get.refresh(toolsAtom(key));
            get.refresh(deploymentsAtom(key));
          }),
        ),
      ),
  ),
);
const renameApp = Atom.family((key: AppKey) =>
  HostedClient.runtime.fn((name: string, get) =>
    Effect.flatMap(HostedClient, (client) =>
      client.apps.rename({ params: key, payload: { name } }),
    ).pipe(Effect.tap((saved) => Effect.sync(() => acknowledgeApp(get, key.organization, saved)))),
  ),
);
const removeApp = Atom.family((key: AppKey) =>
  HostedClient.runtime.fn((_: void, get) =>
    Effect.flatMap(HostedClient, (client) => client.apps.remove({ params: key })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const current = AsyncResult.value(get(inventoryAtom(key.organization)));
          refreshResourceDirectory(get, key.organization);
          acknowledge(get, inventoryAtom(key.organization), (data) => ({
            ...data,
            apps: data.apps.filter((app) => app.id !== key.app),
            profiles: data.profiles.filter((profile) => profile.app !== key.app),
          }));
          if (Option.isSome(current))
            for (const account of current.value.profiles
              .filter((profile) => profile.app === key.app)
              .flatMap((profile) => selectedIds(profile.accounts)))
              acknowledge(
                get,
                accountAtom({ organization: key.organization, account }),
                (data) => ({ ...data, apps: data.apps.filter((app) => app.id !== key.app) }),
              );
          invalidate(get, appAtom(key));
          get.refresh(toolsAtom(key));
        }),
      ),
    ),
  ),
);
/** Mutations are keyed by their target, so another app cannot cancel an in-flight write. */
export const activateAppAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  activateApp(new AppKey(key));
export const renameAppAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  renameApp(new AppKey(key));
export const removeAppAtom = (key: { organization: OrganizationReference; app: AppId }) =>
  removeApp(new AppKey(key));
/** A dialog owns one submission attempt. Reopening it gets a fresh request; retries keep its ID. */
export function appConnectionAtoms(key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly requirement: string;
  readonly provider: ProviderId;
  readonly profile?: ProfileId | undefined;
  readonly accounts: SelectedAccounts;
}) {
  const requestKey = crypto.randomUUID();
  const profile = Atom.make<ProfileId | undefined>(key.profile);
  const request = Atom.make<AccountConnection | undefined>(undefined);
  const connection = (get: Atom.FnContext) =>
    Effect.gen(function* () {
      const current = get(request);
      const client = yield* HostedClient;
      const selected =
        get(profile) ??
        (yield* client.profiles.create({
          params: { organization: key.organization, app: key.app },
          payload: { accounts: key.accounts, idempotencyKey: requestKey },
        })).id;
      get.set(profile, selected);
      const saved =
        current ??
        (yield* client.accounts.connect({
          params: { organization: key.organization, app: key.app },
          payload: { requirement: key.requirement, profile: selected },
        }));
      if (current === undefined) get.set(request, saved);
      // Cached form definitions cannot send credentials to a different provider after an app edit.
      if (saved.provider.id !== key.provider) {
        get.refresh(appAtom({ organization: key.organization, app: key.app }));
        get.refresh(inventoryAtom(key.organization));
        return yield* new AccountConnectionTargetChanged({
          app: key.app,
          requirement: key.requirement,
        });
      }
      return { connection: saved, profile: selected };
    });
  return {
    request,
    profile,
    submit: HostedClient.runtime.fn(
      (payload: { method: string; label: string; fields: typeof AccountFieldsInput.Type }, get) =>
        Effect.gen(function* () {
          const pending = yield* connection(get);
          const client = yield* HostedClient;
          const params = { organization: key.organization, connection: pending.connection.id };
          const saved = yield* client.accounts.submit({ params, payload });
          connectionSaved(get, new ConnectionKey(params), saved, key.app);
          return { account: saved, profile: pending.profile };
        }),
    ),
    startOAuth: HostedClient.runtime.fn(
      (payload: { method: string; label: string; client?: OAuthClientInput }, get) =>
        Effect.gen(function* () {
          const pending = yield* connection(get);
          const client = yield* HostedClient;
          const signIn = yield* client.accounts.startOAuth({
            params: { organization: key.organization, connection: pending.connection.id },
            payload,
          });
          if (signIn.status === "completed")
            connectionSaved(
              get,
              new ConnectionKey({
                organization: key.organization,
                connection: pending.connection.id,
              }),
              signIn.account,
              key.app,
            );
          return {
            ...signIn,
            connection: pending.connection.id,
            profile: pending.profile,
          };
        }),
    ),
  };
}

const submitConnection = Atom.family((key: ConnectionKey) =>
  HostedClient.runtime.fn(
    (payload: { method: string; label: string; fields: typeof AccountFieldsInput.Type }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.accounts.submit({ params: key, payload }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            const connection = AsyncResult.value(get(connectionAtom(key)));
            connectionSaved(
              get,
              key,
              saved,
              Option.isSome(connection) ? (connection.value.target?.app ?? null) : null,
            );
            get.refresh(connectionAtom(key));
          }),
        ),
      ),
  ),
);
const completeOAuth = Atom.family((key: ConnectionKey) =>
  HostedClient.runtime.fn(
    (input: { callbackUrl: Redacted.Redacted<string>; app: AppId | null }, get) =>
      Effect.flatMap(HostedClient, (client) =>
        client.accounts.completeOAuth({ params: key, payload: { callbackUrl: input.callbackUrl } }),
      ).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            connectionSaved(get, key, saved, input.app);
          }),
        ),
      ),
  ),
);
/** Completion reconciles account and target data before the view navigates. */
export const submitConnectionAtom = (key: {
  organization: OrganizationReference;
  connection: AccountConnectionId;
}) => submitConnection(new ConnectionKey(key));
export const completeOAuthAtom = (key: {
  organization: OrganizationReference;
  connection: AccountConnectionId;
}) => completeOAuth(new ConnectionKey(key));
const startOAuth = Atom.family((key: ConnectionKey) =>
  HostedClient.runtime.fn(
    (
      payload: {
        readonly method: string;
        readonly label: string;
        readonly client?: OAuthClientInput;
      },
      get,
    ) =>
      Effect.flatMap(HostedClient, (client) =>
        client.accounts.startOAuth({ params: key, payload }),
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result.status === "completed") {
              const connection = AsyncResult.value(get(connectionAtom(key)));
              connectionSaved(
                get,
                key,
                result.account,
                Option.isSome(connection) ? (connection.value.target?.app ?? null) : null,
              );
            }
          }),
        ),
      ),
  ),
);
/** Retry or manual setup belongs to one connection and cannot supersede another provider's sign-in. */
export const startOAuthAtom = (key: {
  organization: OrganizationReference;
  connection: AccountConnectionId;
}) => startOAuth(new ConnectionKey(key));
class CallKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly profile?: ProfileId | undefined;
  readonly tool: ToolName;
}> {}
const calls = Atom.family((key: CallKey) =>
  HostedClient.runtime.fn(
    (input: {
      input: Json;
      deployment?: DeploymentId | undefined;
      expectedProfileRevision?: number | undefined;
    }) =>
      Effect.flatMap(HostedClient, (client) =>
        client.tools.call({
          params: key,
          payload: { ...input, tool: key.tool, profile: key.profile },
        }),
      ),
  ),
);
/** Each account and operation owns its invocation state. */
export const callToolAtom = (key: ConstructorParameters<typeof CallKey>[0]) =>
  calls(new CallKey(key));

/** Browser-only return context. The server verifies connection ownership and OAuth state. */
export const PendingOAuth = Schema.Struct({
  organization: OrganizationReference,
  organizationSlug: Schema.NonEmptyString,
  connection: AccountConnectionId,
  app: Schema.NullOr(AppId),
  profile: Schema.optional(ProfileId),
  redirectUri: HttpUrl,
  label: Schema.optionalKey(Schema.String),
  manualClient: Schema.optionalKey(Schema.Boolean),
});
export { appError } from "./errors.ts";

const liveApps = Atom.family((key: AppKey) => pollingQuery(appQuery(key)));
/** Open app pages follow activations from another tab or caller without evaluating app code. */
export const liveAppAtom = (key: ConstructorParameters<typeof AppKey>[0]) =>
  liveApps(new AppKey(key));

/** Structural keys keep each query stable across React renders. */
export const appAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
}) => appQuery(new AppKey(key));
export const toolsAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment?: DeploymentId | undefined;
  readonly profile?: ProfileId | undefined;
  readonly expectedProfileRevision?: number | undefined;
  readonly accounts?: string | undefined;
}) => toolsQuery(new ToolKey(key));
export const connectionAtom = (key: {
  readonly organization: OrganizationReference;
  readonly connection: AccountConnectionId;
}) => connectionQuery(new ConnectionKey(key));

/** Retained source is immutable; its atom includes both app and deployment identity. */
export const sourceAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId;
}) => sourceQuery(new SourceKey(key));
/** One display file of a retained deployment, read when the listing did not inline it. */
export const sourceFileAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly deployment: DeploymentId;
  readonly path: string;
}) => sourceFileQuery(new SourceFileKey(key));
/** History remains separate from the inexpensive app metadata query. */
export const deploymentsAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
}) => deploymentsQuery(new AppKey(key));

/** Apply a complete saved app to metadata readers; unknown tool results must be reloaded. */
export function acknowledgeApp(
  get: Atom.FnContext,
  organization: OrganizationReference,
  saved: App,
) {
  refreshResourceDirectory(get, organization);
  const inventory = AsyncResult.value(get(inventoryAtom(organization)));
  const profiles = Option.isSome(inventory)
    ? inventory.value.profiles.filter((profile) => profile.app === saved.id)
    : [];
  for (const profile of profiles)
    get.refresh(
      toolsAtom({
        organization,
        app: saved.id,
        profile: profile.id,
        expectedProfileRevision: profile.revision,
      }),
    );
  const accounts = new Set(profiles.flatMap((profile) => selectedIds(profile.accounts)));
  acknowledge(get, appAtom({ organization, app: saved.id }), () => saved);
  acknowledge(get, inventoryAtom(organization), (data) => ({
    ...data,
    apps: upsert(data.apps, saved),
  }));
  for (const account of accounts)
    acknowledge(get, accountAtom({ organization, account }), (data) => ({
      ...data,
      apps: upsert(data.apps, saved),
    }));
}

function connectionSaved(
  get: Atom.FnContext,
  key: ConnectionKey,
  saved: Account,
  app: AppId | null,
) {
  acknowledgeAccount(get, key.organization, saved, true);
  if (app !== null) {
    const target = { organization: key.organization, app };
    refreshProfiles(get, target);
    invalidate(get, appAtom(target));
    get.refresh(toolsAtom(target));
  }
  // The inventory response contains selected accounts, which the account response does not.
  invalidate(get, inventoryAtom(key.organization));
}

const toolLists = Atom.family((key: ToolKey) =>
  Atom.map(
    toolsQuery(key),
    AsyncResult.map((page) => page.items),
  ),
);
/** Shared browser view for the selected profile. */
export const toolListAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolLists(new ToolKey(key));
