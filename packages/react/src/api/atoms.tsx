import {
  ConnectionAddress,
  PolicyId,
  ProviderKey,
  type AuthTemplateSlug,
  type Connection,
  type ConnectionName,
  type IntegrationSlug,
  type OAuthClientSlug,
  type OAuthClientSummary,
  type OAuthGrant,
  type Owner,
  type ProviderItemId,
  type ToolAddress,
} from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Effect from "effect/Effect";

import { ExecutorApiClient } from "./client";
import { connectionWriteKeys, ReactivityKey } from "./reactivity-keys";

// ---------------------------------------------------------------------------
// Query atoms — typed, cached, reactive. v2: owner-scoped (org | user) instead
// of scope-stacked. The executor is bound to its `{ tenant, subject }` from the
// request auth, so atoms carry only the UI's `owner` choice — never a scope id.
// ---------------------------------------------------------------------------

/**
 * Whole tool catalog across BOTH owners (`tools.list` with no `owner`).
 *
 * Omitting `owner` short-circuits the executor's owner WHERE clause to `true`,
 * so org (`subject=""`) and user (`subject=<user>`) rows return together. Each
 * wire row still carries its own `owner` + `connection`, so the view layer can
 * group/badge per account without re-querying. This replaces the old
 * owner-scoped `toolsAtom(owner)` view filter.
 */
export const toolsAllAtom = ExecutorApiClient.query("tools", "list", {
  query: {},
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.tools],
});

/**
 * Tools produced by one integration's connections across BOTH owners. Same
 * omit-owner merge as `toolsAllAtom`, narrowed to a single integration. Each row
 * retains its `owner` + `connection` for per-account grouping.
 */
export const integrationToolsAllAtom = (integration: IntegrationSlug) =>
  ExecutorApiClient.query("tools", "list", {
    query: { integration },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.tools],
  });

export const toolSchemaAtom = (address: ToolAddress) =>
  ExecutorApiClient.query("tools", "schema", {
    query: { address },
    timeToLive: "1 minute",
    reactivityKeys: [ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Integrations — the tenant-shared catalog (was `sources`).
// ---------------------------------------------------------------------------

export const integrationsAtom = ExecutorApiClient.query("integrations", "list", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.integrations],
});

/** Single integration by slug — derived from the catalog list. */
export const integrationAtom = (slug: IntegrationSlug) =>
  Atom.mapResult(
    integrationsOptimisticAtom,
    (integrations) => integrations.find((i) => i.slug === slug) ?? null,
  );

// ---------------------------------------------------------------------------
// Connections — owner-scoped credentials (was `secrets` + `connections`).
// ---------------------------------------------------------------------------

export const connectionsAtom = (owner: Owner) =>
  ExecutorApiClient.query("connections", "list", {
    query: { owner },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.connections],
  });

/**
 * All connections across BOTH owners (`connections.list` with no `owner`). Same
 * omit-owner merge as the tools atoms: org + user connections return together,
 * each carrying its own `owner`. This is the read/view surface; owner-scoped
 * optimistic write families (`connectionsOptimisticAtom(owner)` etc.) stay keyed
 * by owner because writes target a specific owner.
 */
export const connectionsAllAtom = ExecutorApiClient.query("connections", "list", {
  query: {},
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.connections],
});

// ---------------------------------------------------------------------------
// Providers — credential-backend discovery (new in v2).
// ---------------------------------------------------------------------------

export const providersAtom = ExecutorApiClient.query("providers", "list", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.providers],
});

export const providerItemsAtom = (key: ProviderKey) =>
  ExecutorApiClient.query("providers", "items", {
    params: { key },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.providers],
  });

// ---------------------------------------------------------------------------
// Policies — owner-scoped.
// ---------------------------------------------------------------------------

export const policiesAtom = ExecutorApiClient.query("policies", "list", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.policies],
});

export const pausedExecutionAtom = (executionId: string) =>
  ExecutorApiClient.query("executions", "getPaused", {
    params: { executionId },
    timeToLive: "5 seconds",
  });

// ---------------------------------------------------------------------------
// Mutation atoms — reactivityKeys must be passed at call site (effect-atom
// does not accept them at definition time). See `reactivity-keys.tsx` for the
// canonical key arrays.
// ---------------------------------------------------------------------------

export const createConnection = ExecutorApiClient.mutation("connections", "create");

export const removeConnection = ExecutorApiClient.mutation("connections", "remove");

/** Edit a connection's user-curated metadata (description, identityLabel).
 *  Pass `reactivityKeys: connectionWriteKeys` at the call site. */
export const updateConnection = ExecutorApiClient.mutation("connections", "update");

export const refreshConnection = ExecutorApiClient.mutation("connections", "refresh");

export const updateIntegration = ExecutorApiClient.mutation("integrations", "update");

export const removeIntegration = ExecutorApiClient.mutation("integrations", "remove");

export const detectIntegration = ExecutorApiClient.mutation("integrations", "detect");

// ---------------------------------------------------------------------------
// OAuth — v2 flow. `start` runs a registered client to mint a connection for an
// integration; `complete` exchanges the authorization code; `cancel` drops an
// in-flight session; `probe` discovers an authorization-server's metadata.
// ---------------------------------------------------------------------------

export const createOAuthClient = ExecutorApiClient.mutation("oauth", "createClient");

/** RFC 7591 Dynamic Client Registration — mint a client against the server's
 *  registration endpoint, with NO pasted client id/secret.
 *  Pass `reactivityKeys: oauthClientWriteKeys` at the call site to refresh the
 *  clients list. */
export const registerDynamicOAuthClient = ExecutorApiClient.mutation("oauth", "registerDynamic");

/** Registered OAuth clients (apps) visible to the caller — the org's shared
 *  clients + the caller's own user clients. Metadata-only summaries; the
 *  server never returns the client secret. */
export const oauthClientsAtom = ExecutorApiClient.query("oauth", "listClients", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.oauthClients],
});

/** Permanently remove a registered OAuth app. Keyed by `(owner, slug)`: the
 *  slug is a path param, the owner a payload field (mirrors the connections /
 *  policies delete contract). Connections that referenced the app keep their
 *  stored slug and surface a reconnect prompt at next token refresh — this
 *  never cascades into connections. */
export const removeOAuthClient = ExecutorApiClient.mutation("oauth", "removeClient");

export const probeOAuth = ExecutorApiClient.mutation("oauth", "probe");

export const startOAuth = ExecutorApiClient.mutation("oauth", "start");

export const completeOAuth = ExecutorApiClient.mutation("oauth", "complete");

export const cancelOAuth = ExecutorApiClient.mutation("oauth", "cancel");

/** Fire-and-forget reactivity bump after an OAuth flow mints/refreshes a
 *  connection out-of-band (the popup completes via the server callback). The
 *  body is a no-op; declaring `connectionWriteKeys` invalidates the connection
 *  and tool queries so the UI re-reads the freshly-minted connection. */
export const oauthConnectionCompleted = ExecutorApiClient.runtime.fn<{
  readonly reactivityKeys: typeof connectionWriteKeys;
}>()(() => Effect.void, {
  reactivityKeys: connectionWriteKeys,
});

export const createPolicy = ExecutorApiClient.mutation("policies", "create");

export const updatePolicy = ExecutorApiClient.mutation("policies", "update");

export const removePolicy = ExecutorApiClient.mutation("policies", "remove");

export const resumeExecution = ExecutorApiClient.mutation("executions", "resume");

/** Run codemode source (`POST /executions`). Used by the per-tool Run/Test panel
 *  to invoke a single tool against a connection and verify credentials. */
export const executeCode = ExecutorApiClient.mutation("executions", "execute");

// ---------------------------------------------------------------------------
// Integrations — optimistic surface.
// ---------------------------------------------------------------------------

export const integrationsOptimisticAtom = Atom.optimistic(integrationsAtom);

export const removeIntegrationOptimistic = integrationsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (current, arg: { readonly params: { readonly slug: IntegrationSlug } }) =>
      AsyncResult.map(current, (rows) =>
        rows.filter((integration) => integration.slug !== arg.params.slug),
      ),
    fn: removeIntegration,
  }),
);

// ---------------------------------------------------------------------------
// Connections — optimistic removals. Owner-scoped: a connection is identified
// by (owner, integration, name) so removals filter by all three.
// ---------------------------------------------------------------------------

export const connectionsOptimisticAtom = Atom.family((owner: Owner) =>
  Atom.optimistic(connectionsAtom(owner)),
);

export const removeConnectionOptimistic = Atom.family((owner: Owner) =>
  connectionsOptimisticAtom(owner).pipe(
    Atom.optimisticFn({
      reducer: (
        current,
        arg: {
          readonly params: {
            readonly owner: Owner;
            readonly integration: IntegrationSlug;
            readonly name: ConnectionName;
          };
        },
      ) =>
        AsyncResult.map(current, (rows) =>
          rows.filter(
            (connection) =>
              connection.owner !== arg.params.owner ||
              connection.integration !== arg.params.integration ||
              connection.name !== arg.params.name,
          ),
        ),
      fn: removeConnection,
    }),
  ),
);

/** This owner's connections, narrowed to a single integration. Derived from the
 *  optimistic surface so adds/removes flow through without an extra fetch. */
export const connectionsForIntegrationAtom = Atom.family(
  (key: { readonly integration: IntegrationSlug; readonly owner: Owner }) =>
    Atom.mapResult(connectionsOptimisticAtom(key.owner), (rows: readonly Connection[]) =>
      rows.filter((connection: Connection) => connection.integration === key.integration),
    ),
);

// The connection-create payload mirrors `CreateConnectionPayload` from the core
// API: the common fields plus exactly one value origin — a single pasted `value`
// (the `token` input), a `values` map (one per named input, e.g. Datadog's two
// keys), or an external `from` reference.
type CreateConnectionArg = {
  readonly payload: {
    readonly owner: Owner;
    readonly name: ConnectionName;
    readonly integration: IntegrationSlug;
    readonly template: AuthTemplateSlug;
    readonly identityLabel?: string | null;
    readonly description?: string | null;
  } & (
    | { readonly value: string }
    | { readonly values: Record<string, string> }
    | {
        readonly from: {
          readonly provider: ProviderKey;
          readonly id: ProviderItemId;
        };
      }
  );
  readonly reactivityKeys: typeof connectionWriteKeys;
};

/** Optimistic create — prepends a placeholder row built from the payload so the
 *  new account appears immediately, then reconciles when the server returns the
 *  canonical connection. `provider`/`address` are placeholders until the refresh
 *  lands. */
export const addConnectionOptimistic = Atom.family((owner: Owner) =>
  connectionsOptimisticAtom(owner).pipe(
    Atom.optimisticFn({
      reducer: (current, arg: CreateConnectionArg) =>
        AsyncResult.map(current, (rows) => {
          const { payload } = arg;
          // Shape matches the wire `ConnectionResponse` (non-optional
          // `identityLabel`/`expiresAt`), not the broader SDK `Connection`.
          const optimistic = {
            owner: payload.owner,
            name: payload.name,
            integration: payload.integration,
            template: payload.template,
            provider: ProviderKey.make("default"),
            address: ConnectionAddress.make(
              `tools.${payload.integration}.${payload.owner}.${payload.name}`,
            ),
            identityLabel: payload.identityLabel ?? null,
            description: payload.description ?? null,
            expiresAt: null,
            // Optimistic placeholder predates the server resolving which app (if
            // any) minted this connection; reconciled on refresh. Matches the
            // wire `ConnectionResponse.oauthClient` (nullable).
            oauthClient: null,
            oauthClientOwner: null,
            oauthScope: null,
          };
          return [optimistic, ...rows];
        }),
      fn: createConnection,
    }),
  ),
);

// ---------------------------------------------------------------------------
// Policies — optimistic surface. Reads go through `policiesOptimisticAtom`
// (which layers in-flight transitions on top of `policiesAtom`), and writes
// go through the matching `*PolicyOptimistic` mutation atoms. Each mutation
// declares a reducer that produces the next array of rows; effect-atom's
// `Atom.optimisticFn` handles transition tracking, waiting state, and the
// post-commit refresh — including racing calls (latest reducer wins).
// ---------------------------------------------------------------------------

export const policiesOptimisticAtom = Atom.optimistic(policiesAtom);

export const createPolicyOptimistic = policiesOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly payload: {
          readonly owner: Owner;
          readonly pattern: string;
          readonly action: "approve" | "require_approval" | "block";
        };
      },
    ) =>
      AsyncResult.map(current, (rows) => [
        {
          id: PolicyId.make(`pending-${Math.random().toString(36).slice(2)}`),
          owner: arg.payload.owner,
          pattern: arg.payload.pattern,
          action: arg.payload.action,
          // Empty string sorts before any fractional-indexing key, so the
          // placeholder lands at the top until the server returns the
          // canonical key.
          position: "",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        ...rows,
      ]),
    fn: createPolicy,
  }),
);

export const updatePolicyOptimistic = policiesOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly params: { readonly policyId: PolicyId };
        readonly payload: {
          readonly action?: "approve" | "require_approval" | "block";
          readonly pattern?: string;
          readonly position?: string;
        };
      },
    ) =>
      AsyncResult.map(current, (rows) =>
        rows.map((r) =>
          r.id === arg.params.policyId
            ? {
                ...r,
                ...(arg.payload.action !== undefined ? { action: arg.payload.action } : {}),
                ...(arg.payload.pattern !== undefined ? { pattern: arg.payload.pattern } : {}),
                ...(arg.payload.position !== undefined ? { position: arg.payload.position } : {}),
              }
            : r,
        ),
      ),
    fn: updatePolicy,
  }),
);

export const removePolicyOptimistic = policiesOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (current, arg: { readonly params: { readonly policyId: PolicyId } }) =>
      AsyncResult.map(current, (rows) => rows.filter((r) => r.id !== arg.params.policyId)),
    fn: removePolicy,
  }),
);

// ---------------------------------------------------------------------------
// OAuth clients (apps) — optimistic surface. The list reads through
// `oauthClientsOptimisticAtom`; the remove mutation drops the matching
// `(owner, slug)` row immediately, then `oauthClientWriteKeys` refreshes the
// canonical list. Removals never touch `connections`: an orphaned connection
// stays visible and surfaces a reconnect prompt at its next refresh.
// ---------------------------------------------------------------------------

export const oauthClientsOptimisticAtom = Atom.optimistic(oauthClientsAtom);

export const removeOAuthClientOptimistic = oauthClientsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly params: { readonly slug: OAuthClientSlug };
        readonly payload: { readonly owner: Owner };
      },
    ) =>
      AsyncResult.map(current, (rows) =>
        rows.filter(
          (client) => client.owner !== arg.payload.owner || client.slug !== arg.params.slug,
        ),
      ),
    fn: removeOAuthClient,
  }),
);

/** Register (or edit) an OAuth app and paint it into the list immediately.
 *  `createClient` upserts by `(owner, slug)` server-side, so the reducer mirrors
 *  that: an existing row is replaced (edit), a new slug is appended (register).
 *  The client secret is never part of the summary, so it is dropped. The
 *  post-commit refresh (`oauthClientWriteKeys`) reconciles with the server. */
export const createOAuthClientOptimistic = oauthClientsOptimisticAtom.pipe(
  Atom.optimisticFn({
    reducer: (
      current,
      arg: {
        readonly payload: {
          readonly owner: Owner;
          readonly slug: OAuthClientSlug;
          readonly authorizationUrl: string;
          readonly tokenUrl: string;
          readonly grant: OAuthGrant;
          readonly clientId: string;
          readonly resource?: string | null;
        };
      },
    ) =>
      AsyncResult.map(current, (rows) => {
        const summary: OAuthClientSummary = {
          owner: arg.payload.owner,
          slug: arg.payload.slug,
          grant: arg.payload.grant,
          authorizationUrl: arg.payload.authorizationUrl,
          tokenUrl: arg.payload.tokenUrl,
          resource: arg.payload.resource ?? null,
          clientId: arg.payload.clientId,
          origin: { kind: "manual" },
        };
        const index = rows.findIndex(
          (client) => client.owner === summary.owner && client.slug === summary.slug,
        );
        if (index === -1) return [...rows, summary];
        const next = rows.slice();
        next[index] = summary;
        return next;
      }),
    fn: createOAuthClient,
  }),
);
