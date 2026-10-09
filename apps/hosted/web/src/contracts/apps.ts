import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { refreshProfiles } from "./profiles.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Organization-specific app queries and mutations use the shared hosted API. */
import {
  AppId,
  AppEvaluationFailed,
  type Tool,
  type Cursor,
  ProfileId,
  DeploymentId,
  AccountConnectionId,
  AccountConnectionTargetChanged,
  type AccountConnection,
  type ProviderId,
  HttpUrl,
  type App,
  type Account,
  type AccountId,
  type AccountFieldsInput,
  type SelectedAccounts,
  type OAuthClientInput,
  type ToolName,
  type Json,
} from "@executor-js/sdk";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { AsyncResult, Atom } from "effect/reactivity";
import { Cause, Data, Effect, Option, Schema, type Redacted } from "effect";
import { HostedClient } from "./api.ts";
import {
  acknowledge,
  acknowledgedQuery,
  upsert,
  invalidate,
} from "@executor-js/ui/contracts/mutations";
import { inventoryAtom } from "./organization.ts";
import { accountAtom, acknowledgeAccount } from "./accounts.ts";
import { selectedIds, type ToolCatalog } from "@executor-js/ui/contracts/dashboard";

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
  HostedClient.query("accounts", "oauthSetup", hydrated({ params: key })).pipe(revalidated),
);
/** Safe client capability hints are shared across forms for the same organization, provider, and method. */
export const oauthSetupAtom = (key: {
  organization: OrganizationReference;
  provider: ProviderId;
  method: string;
}) => oauthSetupQuery(new OAuthSetupKey(key));

const appQuery = Atom.family(
  (key: { readonly organization: OrganizationReference; readonly app: AppId }) =>
    HostedClient.query("apps", "get", hydrated({ params: key })).pipe(revalidated, protectedQuery),
);
const deploymentsQuery = Atom.family((key: AppKey) =>
  HostedClient.query("apps", "deployments", hydrated({ params: key })).pipe(revalidated),
);
const sourceQuery = Atom.family((key: SourceKey) =>
  HostedClient.query(
    "apps",
    "sourceDisplay",
    hydrated({
      params: { organization: key.organization, app: key.app },
      query: { deployment: key.deployment },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
);
const sourceFileQuery = Atom.family((key: SourceFileKey) =>
  HostedClient.query(
    "apps",
    "sourceDisplayFile",
    hydrated({
      params: { organization: key.organization, app: key.app, deployment: key.deployment },
      query: { path: key.path },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
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
/** Browsing reads the schema-free index; one tool's schemas load when it is selected. */
const toolsQuery = Atom.family((key: ToolKey) =>
  HostedClient.query(
    "tools",
    "index",
    hydrated({
      params: key,
      query: {
        deployment: key.deployment,
        profile: key.profile,
        expectedProfileRevision: key.expectedProfileRevision,
      },
    }),
  ).pipe(revalidated),
);
/**
 * Pending credentials are fetched without reading saved secrets. A request whose app changed can
 * never complete, so a read reporting that drops the old form instead of showing it beside the error.
 */
const connectionQuery = Atom.family((key: ConnectionKey) =>
  acknowledgedQuery(
    HostedClient.query("accounts", "connection", hydrated({ params: key })),
    (cause) =>
      !Option.exists(Cause.findErrorOption(cause), Schema.is(AccountConnectionTargetChanged)),
  ),
);
/** A write that reports a changed app reads the request again, so the change replaces its form. */
const reloadConnection = (get: Atom.FnContext, key: ConnectionKey) =>
  Effect.sync(() => get.refresh(connectionQuery(key)));
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
  /** Replace this selected account's credentials instead of adding an account. */
  readonly account?: AccountId | undefined;
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
          payload: {
            requirement: key.requirement,
            profile: selected,
            ...(key.account === undefined ? {} : { account: key.account }),
          },
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
      (payload: { method: string; fields: typeof AccountFieldsInput.Type }, get) =>
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
      (payload: { method: string; client?: OAuthClientInput }, get) =>
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
    (payload: { method: string; fields: typeof AccountFieldsInput.Type }, get) =>
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
        Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get, key)),
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
/** The callback's OAuth state, not the browser tab, identifies the connection it completes. */
export const resolveOAuthCallbackAtom = HostedClient.runtime.fn(
  (callbackUrl: Redacted.Redacted<string>) =>
    Effect.flatMap(HostedClient, (client) =>
      client.oauthCallback.resolve({ payload: { callbackUrl } }),
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
        Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get, key)),
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
  readonly expectedProfileRevision?: number | undefined;
  readonly deployment?: DeploymentId | undefined;
  readonly tool: ToolName;
  readonly kind: "query" | "mutation";
}> {}
const calls = Atom.family(({ organization, app, ...target }: CallKey) =>
  HostedClient.runtime.fn((input: Json) =>
    Effect.flatMap(HostedClient, (client) =>
      client.tools.call({ params: { organization, app }, payload: { ...target, input } }),
    ),
  ),
);
/** Each account and operation owns its invocation state. */
export const callToolAtom = (key: ConstructorParameters<typeof CallKey>[0]) =>
  calls(new CallKey(key));

/** Return context from the tab that started sign-in; the callback page resolves it from the server. */
export const PendingOAuth = Schema.Struct({
  organization: OrganizationReference,
  organizationSlug: Schema.NonEmptyString,
  connection: AccountConnectionId,
  app: Schema.NullOr(AppId),
  profile: Schema.optional(ProfileId),
  redirectUri: HttpUrl,
  /** A reconnect keeps its account name, so completion does not ask for one. */
  reconnect: Schema.optionalKey(Schema.Boolean),
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
    get.refresh(appAtom(target));
    get.refresh(toolsAtom(target));
  }
  // The inventory response contains selected accounts, which the account response does not.
  get.refresh(inventoryAtom(key.organization));
}

const toolCatalogs = Atom.family((key: ToolKey) =>
  Atom.map(
    toolsQuery(key),
    AsyncResult.map((page): ToolCatalog => ({ tools: page.items, routers: page.routers })),
  ),
);
/** Shared browser view for the selected profile, with the routers that group its tools. */
export const toolCatalogAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolCatalogs(new ToolKey(key));
class ToolDetailKey extends Data.Class<
  ConstructorParameters<typeof ToolKey>[0] & { readonly tool: ToolName }
> {}
const toolDetailQueries = Atom.family((key: ToolDetailKey) =>
  HostedClient.query(
    "tools",
    "get",
    hydrated({
      params: { organization: key.organization, app: key.app, tool: key.tool },
      query: {
        deployment: key.deployment,
        profile: key.profile,
        expectedProfileRevision: key.expectedProfileRevision,
      },
    }),
  ).pipe(revalidated),
);
const toolDetails = Atom.family((key: ToolDetailKey) =>
  HostedClient.runtime.atom((get) =>
    get
      .result(toolDetailQueries(key))
      // A tool that left the catalog since the list was read is not a failure.
      .pipe(Effect.catchTag("ToolNotFound", () => Effect.succeed(undefined))),
  ),
);
/** One tool's schemas for the same catalog identity as the list. */
export const toolDetailAtom = (key: ConstructorParameters<typeof ToolDetailKey>[0]) =>
  toolDetails(new ToolDetailKey(key));

const connectionToolLists = Atom.family((key: ToolKey) =>
  HostedClient.runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* HostedClient;
        const tools: Tool[] = [];
        const cursors = new Set<Cursor>();
        let cursor: Cursor | undefined;
        let deployment = key.deployment;
        let revision = key.expectedProfileRevision;
        do {
          const page = yield* client.tools.list({
            params: { organization: key.organization, app: key.app },
            query: { profile: key.profile, expectedProfileRevision: revision, deployment, cursor },
          });
          if (
            (deployment !== undefined && deployment !== page.deployment) ||
            (revision !== undefined && revision !== page.profileRevision) ||
            (page.next !== undefined && cursors.has(page.next))
          ) {
            return yield* new AppEvaluationFailed({
              app: key.app,
              deployment: page.deployment,
              reason: "The tool catalog changed while loading. Try again.",
            });
          }
          deployment = page.deployment;
          revision = page.profileRevision;
          tools.push(...page.items);
          cursor = page.next;
          if (cursor !== undefined) cursors.add(cursor);
        } while (cursor !== undefined);
        return tools;
      }),
    )
    .pipe(Atom.setIdleTTL("5 minutes")),
);
/** Load the complete selected catalog on demand so connection search includes every tool. */
export const connectionToolListAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  connectionToolLists(new ToolKey(key));
