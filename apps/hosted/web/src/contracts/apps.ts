import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { pollingQuery } from "@executor-js/ui/contracts/polling";
import { refreshAppLinks } from "./app-accounts.ts";
import { discoveryTarget, refreshAppDiscovery } from "./app-discovery.ts";
import { refreshResourceDirectory } from "./resource-access.ts";
import { protectedQuery } from "./protected-query.ts";
/** Organization-specific app queries and mutations use the shared hosted API. */
import {
  AppId,
  VersionId,
  AccountConnectionId,
  AccountConnectionTargetChanged,
  type AccountConnection,
  type AccountScope,
  type ProviderId,
  HttpUrl,
  OAuthClientId,
  type App,
  type Account,
  type AccountId,
  type AccountFieldsInput,
  type OAuthClientSelection,
  type ToolName,
  type Json,
  type ApprovalRequestId,
} from "@executor-js/sdk";
import { toolRunApproval } from "@executor-js/ui/contracts/browser-approval";
import { BrowserAtoms } from "./telemetry.ts";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { AsyncResult, Atom } from "effect/reactivity";
import { Cause, Data, Effect, Option, Schema, type Redacted } from "effect";
import { HostedClient } from "./api.ts";
import { SetupHandoff } from "./navigation.ts";
import {
  acknowledge,
  acknowledgedQuery,
  currentQuery,
  upsert,
  invalidate,
} from "@executor-js/ui/contracts/mutations";
import { inventoryAtom } from "./organization.ts";
import { accountAtom, acknowledgeAccount } from "./accounts.ts";
import type { ToolCatalog } from "@executor-js/ui/contracts/dashboard";
import { linkedAccountIds } from "@executor-js/ui/contracts/app-accounts";

/** App data is never reused between organizations. */
class AppKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
}> {}
class SourceKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId;
}> {}
class SourceFileKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId;
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
const versionsQuery = Atom.family((key: AppKey) =>
  HostedClient.query("apps", "versions", hydrated({ params: key })).pipe(revalidated),
);
const sourceQuery = Atom.family((key: SourceKey) =>
  HostedClient.query(
    "apps",
    "sourceDisplay",
    hydrated({
      params: { organization: key.organization, app: key.app },
      query: { version: key.version },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
);
const versionSourceQuery = Atom.family((key: SourceKey) =>
  HostedClient.query(
    "apps",
    "source",
    hydrated({
      params: { organization: key.organization, app: key.app },
      query: { version: key.version },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
);
const sourceFileQuery = Atom.family((key: SourceFileKey) =>
  HostedClient.query(
    "apps",
    "sourceDisplayFile",
    hydrated({
      params: { organization: key.organization, app: key.app, version: key.version },
      query: { path: key.path },
    }),
  ).pipe(Atom.setIdleTTL("5 minutes")),
);
/**
 * One page evaluates the current app catalog with the app's linked accounts, read again after the
 * caller links, unlinks or connects one.
 */
class ToolKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version?: VersionId | undefined;
}> {}
/**
 * Browsing reads the schema-free index; one tool's schemas load when it is selected. A refresh
 * shows the catalog loading rather than the previous one: the key does not name the linked
 * accounts, so a retained catalog may belong to accounts that are no longer linked.
 */
const toolsQuery = Atom.family((key: ToolKey) =>
  HostedClient.query(
    "tools",
    "index",
    hydrated({
      params: key,
      query: { version: key.version },
    }),
  ).pipe(revalidated, currentQuery),
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
    (payload: { version: VersionId; expectedVersion: VersionId | null }, get) =>
      Effect.flatMap(HostedClient, (client) => client.apps.activate({ params: key, payload })).pipe(
        Effect.tap((saved) =>
          Effect.sync(() => {
            acknowledgeApp(get, key.organization, saved);
            get.refresh(toolsAtom(key));
            get.refresh(versionsAtom(key));
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
            links: data.links.filter((link) => link.app !== key.app),
          }));
          if (Option.isSome(current))
            for (const account of linkedAccountIds(current.value.links, key.app))
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
/**
 * A dialog owns one submission attempt. Reopening it gets a fresh request; retries keep its
 * connection. Completing a connection started from the app saves the account and links it to the
 * requirement in the scope the dialog names.
 */
export function appConnectionAtoms(key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  /** The version whose discovery the page shows, read again once the account is linked. */
  readonly version: VersionId | null;
  readonly scope: AccountScope;
  readonly requirement: string;
  readonly provider: ProviderId;
  /** Replace this account's credentials instead of adding an account. */
  readonly account?: AccountId | undefined;
}) {
  const request = Atom.make<AccountConnection | undefined>(undefined);
  const connection = (get: Atom.FnContext) =>
    Effect.gen(function* () {
      const current = get(request);
      const client = yield* HostedClient;
      const args = {
        params: { organization: key.organization, app: key.app, requirement: key.requirement },
        payload: key.account === undefined ? {} : { account: key.account },
      };
      const saved =
        current ??
        (yield* key.scope === "app"
          ? client.appAccounts.appConnect(args)
          : client.appAccounts.userConnect(args));
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
      return saved;
    });
  const saved = (get: Atom.FnContext, connection: AccountConnectionId, account: Account) => {
    connectionSaved(
      get,
      new ConnectionKey({ organization: key.organization, connection }),
      account,
      key.app,
    );
    refreshAppDiscovery(get, key);
  };
  return {
    request,
    submit: HostedClient.runtime.fn(
      (payload: { method: string; fields: typeof AccountFieldsInput.Type }, get) =>
        Effect.gen(function* () {
          const pending = yield* connection(get);
          const client = yield* HostedClient;
          const params = { organization: key.organization, connection: pending.id };
          const account = yield* client.accounts.submit({ params, payload });
          saved(get, pending.id, account);
          return account;
        }),
    ),
    startOAuth: HostedClient.runtime.fn(
      (payload: { method: string; client?: OAuthClientSelection }, get) =>
        Effect.gen(function* () {
          const pending = yield* connection(get);
          const client = yield* HostedClient;
          const signIn = yield* client.accounts.startOAuth({
            params: { organization: key.organization, connection: pending.id },
            payload,
          });
          if (signIn.status === "completed") saved(get, pending.id, signIn.account);
          return { ...signIn, connection: pending.id };
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
              Option.isSome(connection) ? connection.value.target.app : null,
            );
            get.refresh(connectionAtom(key));
          }),
        ),
        Effect.tapErrorTag("AccountConnectionTargetChanged", () => reloadConnection(get, key)),
      ),
  ),
);
const completeOAuth = Atom.family((key: ConnectionKey) =>
  HostedClient.runtime.fn((input: { callbackUrl: Redacted.Redacted<string>; app: AppId }, get) =>
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
        readonly client?: OAuthClientSelection;
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
                Option.isSome(connection) ? connection.value.target.app : null,
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
  readonly version?: VersionId | undefined;
  readonly tool: ToolName;
  readonly kind: "query" | "mutation";
}> {}
const calls = Atom.family(({ organization, app, ...target }: CallKey) =>
  HostedClient.runtime.fn((input: Json) =>
    Effect.flatMap(HostedClient, (client) =>
      client.tools.run({
        params: { organization, app },
        payload: { ...target, input },
      }),
    ),
  ),
);
/** Each operation owns its invocation state. */
export const callToolAtom = (key: ConstructorParameters<typeof CallKey>[0]) =>
  calls(new CallKey(key));
const toolRunApprovals = Atom.family((endpoint: string) => toolRunApproval(BrowserAtoms, endpoint));
/** One pending dashboard run's review; each request owns its answer state. */
export const toolRunApprovalAtoms = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly requestId: ApprovalRequestId;
}) =>
  toolRunApprovals(
    `/api/organizations/${encodeURIComponent(key.organization)}/apps/${encodeURIComponent(key.app)}/tools/approvals/${encodeURIComponent(key.requestId)}`,
  );

/**
 * Pages other than the app's Accounts view that an account sign-in can return to: onboarding's
 * account step, with the assistant handoff its URL carried.
 */
export const OAuthReturn = Schema.Struct({
  page: Schema.Literal("setup"),
  handoff: Schema.optionalKey(SetupHandoff),
});
export type OAuthReturn = typeof OAuthReturn.Type;
/** Return context from the tab that started sign-in; the callback page resolves it from the server. */
export const PendingOAuth = Schema.Struct({
  organization: OrganizationReference,
  organizationSlug: Schema.NonEmptyString,
  connection: AccountConnectionId,
  app: AppId,
  redirectUri: HttpUrl,
  /** A reconnect keeps its account name, so completion does not ask for one. */
  reconnect: Schema.optionalKey(Schema.Boolean),
  manualClient: Schema.optionalKey(Schema.Boolean),
  /** The client this attempt registered, which stays registered if sign-in fails. */
  registeredClient: Schema.optionalKey(OAuthClientId),
  /** The page the sign-in started from when it is not the app's own: onboarding's account step. */
  returnTo: Schema.optionalKey(OAuthReturn),
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
export const toolsAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  toolsQuery(new ToolKey(key));
export const connectionAtom = (key: {
  readonly organization: OrganizationReference;
  readonly connection: AccountConnectionId;
}) => connectionQuery(new ConnectionKey(key));

/** Retained source is immutable; its atom includes both app and version identity. */
export const sourceAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId;
}) => sourceQuery(new SourceKey(key));
/** A retained version's stored files, unformatted and complete, as workflow diagrams read them. */
export const versionSourceAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId;
}) => versionSourceQuery(new SourceKey(key));
/** One display file of a retained version, read when the listing did not inline it. */
export const sourceFileAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly version: VersionId;
  readonly path: string;
}) => sourceFileQuery(new SourceFileKey(key));
/** History remains separate from the inexpensive app metadata query. */
export const versionsAtom = (key: {
  readonly organization: OrganizationReference;
  readonly app: AppId;
}) => versionsQuery(new AppKey(key));

/** Apply a complete saved app to metadata readers; unknown tool results must be reloaded. */
export function acknowledgeApp(
  get: Atom.FnContext,
  organization: OrganizationReference,
  saved: App,
) {
  refreshResourceDirectory(get, organization);
  const inventory = AsyncResult.value(get(inventoryAtom(organization)));
  get.refresh(toolsAtom({ organization, app: saved.id }));
  const accounts = new Set(
    Option.isSome(inventory) ? linkedAccountIds(inventory.value.links, saved.id) : [],
  );
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

/**
 * A saved connection for an app requirement links its account to the requirement, so the app's
 * links, its requirements' choices and its discovery are read again.
 */
function connectionSaved(
  get: Atom.FnContext,
  key: ConnectionKey,
  saved: Account,
  app: AppId | null,
) {
  acknowledgeAccount(get, key.organization, saved, true);
  if (app !== null) {
    const target = { organization: key.organization, app };
    const inventory = AsyncResult.value(get(inventoryAtom(key.organization)));
    const current = Option.isSome(inventory)
      ? inventory.value.apps.find((item) => item.id === app)
      : undefined;
    refreshAppLinks(get, { ...target, requirements: current?.requirements.accounts });
    get.refresh(appAtom(target));
    get.refresh(toolsAtom(target));
    if (current !== undefined) refreshAppDiscovery(get, discoveryTarget(key.organization, current));
  }
  // The inventory response contains linked accounts, which the account response does not.
  get.refresh(inventoryAtom(key.organization));
}

const toolCatalogs = Atom.family((key: ToolKey) =>
  Atom.map(
    toolsQuery(key),
    AsyncResult.map((page): ToolCatalog => ({ tools: page.items, routers: page.routers })),
  ),
);
/** Shared browser view for the page's accounts, with the routers that group its tools. */
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
      query: { version: key.version },
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

/** Connection search reads the whole schema-free index, so it includes every tool. */
const connectionToolLists = Atom.family((key: ToolKey) =>
  Atom.map(
    toolsQuery(key),
    AsyncResult.map((index) => index.items),
  ),
);
export const connectionToolListAtom = (key: ConstructorParameters<typeof ToolKey>[0]) =>
  connectionToolLists(new ToolKey(key));
