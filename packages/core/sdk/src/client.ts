// ---------------------------------------------------------------------------
// @executor-js/sdk/client — frontend half of the plugin SDK.
//
// Plugins import from this entry to register pages/widgets and consume
// their own typed reactive client. Server bundles must NOT import this
// module — it pulls in React + @effect/atom-react. Plugin packages should
// keep React/atom imports inside `./client.tsx` and Effect/Node imports
// inside `./server.ts`; shared schema definitions go in `./shared.ts` and
// can be imported from both halves.
// ---------------------------------------------------------------------------

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { HttpApi } from "effect/unstable/httpapi";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";

// ---------------------------------------------------------------------------
// Re-exports — the curated set of primitives a plugin author needs to
// build a typed reactive UI without reaching into `effect/*` directly.
// ---------------------------------------------------------------------------

export { Schema } from "effect";
export { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

export * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
export * as Atom from "effect/unstable/reactivity/Atom";
export * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi";

export { useAtomValue, useAtomSet, useAtomMount, useAtomRefresh } from "@effect/atom-react";

// ---------------------------------------------------------------------------
// defineClientPlugin — declarative spec for the frontend half of a plugin.
//
// Mirror of `definePlugin` on the server, but everything here is React /
// browser-only. The host treats the value as data: collects routes,
// widgets, and slot components from every loaded plugin and mounts them
// alongside the host's own UI.
// ---------------------------------------------------------------------------

export interface PluginPageProps {
  /** Plugin-relative route params captured from `PageDecl.path` segments. */
  readonly params: Readonly<Record<string, string>>;
  /** The normalized plugin-relative URL path that matched this page. */
  readonly path: string;
  /** The plugin id from `/plugins/$pluginId/...`. */
  readonly pluginId: string;
}

export interface PageDecl {
  /** Path relative to the plugin's mount point, e.g. `/`, `/edit/$id`. */
  readonly path: string;
  readonly component: ComponentType<PluginPageProps>;
  /** Optional sidebar nav metadata — the host renders these alongside its
   *  own nav links. Omit to register a page without a nav entry. */
  readonly nav?: {
    readonly label: string;
    readonly section?: string;
  };
}

export interface WidgetProps {
  readonly scopeId?: string;
}

export interface WidgetDecl {
  readonly id: string;
  readonly component: ComponentType<WidgetProps>;
  readonly size?: "half" | "full";
}

/**
 * Open record of host-defined slot components a plugin can fill. Slot
 * names are part of the host UI contract — plugins opt in by registering
 * a component for the slot they care about. Adding a slot is a host-side
 * change; plugin authors don't define new slots.
 */
export type SlotComponent = ComponentType<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// IntegrationPlugin / IntegrationPreset — UI contract for plugins that expose
// "integrations" (OpenAPI specs, MCP servers, GraphQL endpoints, etc.). The
// host owns the integration list / detail chrome; the plugin owns the
// add-flow, edit form, and (optional) summary + sign-in buttons.
//
// Lives here, not in `@executor-js/react`, so it's part of the plugin
// contract: a plugin's `./client` entry assembles its `integrationPlugin`
// alongside `pages`/`widgets`, and the host derives the union list
// from `virtual:executor/plugins-client`.
// ---------------------------------------------------------------------------

export interface IntegrationPreset {
  /** Unique id (e.g. "stripe", "github-graphql"). */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** URL passed as `initialUrl` to the add form. Omit for presets that
   *  don't use a URL (e.g. stdio MCP presets). */
  readonly url?: string;
  /** Endpoint passed to agent-facing probe/add tools when their schema
   *  uses `endpoint` instead of `url`. */
  readonly endpoint?: string;
  /** Optional icon URL (favicon, logo). */
  readonly icon?: string;
  /** Shown in the top-level grid on the integrations page when true. */
  readonly featured?: boolean;
}

export interface IntegrationAccountHandoff {
  /** Changes on each handoff URL, so the accounts UI can open once per link. */
  readonly key: string;
  readonly owner?: "org" | "user";
  /** Auth template/method to preselect when present. */
  readonly template?: string;
  /** Non-secret connection label to prefill. */
  readonly label?: string;
  /** Existing display identity to preserve when reconnecting a saved row. */
  readonly identityLabel?: string;
  /** Present when the agent handed off a CONFIDENTIAL OAuth-app registration
   *  (via `oauth.clients.createHandoff`) or when a saved OAuth connection is
   *  reconnecting through its stored app. Registration opens the
   *  Register-OAuth-app form pre-filled with these NON-secret fields, and the
   *  human types the client secret directly into the browser. Reconnect starts
   *  OAuth with the existing public client. */
  readonly oauthClient?: {
    readonly action?: "register" | "reconnect";
    /** Preselected client slug; when set the form's slug is fixed. */
    readonly slug?: string;
    readonly owner?: "org" | "user";
    readonly grant?: string;
    readonly clientId?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly resource?: string;
  };
}

/** Outcome of applying an edit-sheet section's staged change. `summary` is
 *  toasted on success; `ok: false` keeps the sheet open (the section renders
 *  its own error inline). */
export type EditSheetApplyResult =
  | { readonly ok: true; readonly summary: string | null }
  | { readonly ok: false };

export interface EditSheetSectionProps {
  readonly sourceId: string;
  readonly onPendingChange?: (apply: (() => Promise<EditSheetApplyResult>) | null) => void;
}

export interface IntegrationPlugin {
  /** Unique key matching the SDK plugin id (e.g. "openapi"). */
  readonly key: string;
  readonly label: string;
  readonly add: ComponentType<{
    /** Called when the integration has been registered. Receives the slug of
     *  the just-registered integration, so the host can route to its detail
     *  hub (`/integrations/<slug>`). Optional so existing no-arg calls still
     *  typecheck while plugins are threading the slug through. */
    readonly onComplete: (slug?: string) => void;
    readonly onCancel: () => void;
    readonly initialUrl?: string;
    readonly initialPreset?: string;
    readonly initialNamespace?: string;
  }>;
  /** Legacy full-page edit surface. No host renders this anymore — plugin
   *  configuration lives in the integration Edit sheet via `editSheet`. */
  readonly edit?: ComponentType<{
    readonly sourceId: string;
    readonly onSave: () => void;
  }>;
  /** Plugin-owned configuration rendered inside the integration's Edit sheet,
   *  below the shared metadata fields (e.g. the OpenAPI spec-update controls).
   *  The sheet has ONE Save: the section stages its pending change locally and
   *  reports it through `onPendingChange` — a thunk that applies the staged
   *  change. Save runs the metadata update, then the staged apply; a failed
   *  apply keeps the sheet open with the section showing its own error. */
  readonly editSheet?: ComponentType<EditSheetSectionProps>;
  readonly summary?: ComponentType<{
    readonly sourceId: string;
    readonly variant?: "badge" | "panel";
    readonly onAction?: () => void;
  }>;
  /** Renders the integration's Accounts hub (auth methods + connections) inside
   *  the detail page's Accounts tab. Plugins that declare auth methods implement
   *  this; the page falls back to a generic accounts list when absent. */
  readonly accounts?: ComponentType<{
    readonly sourceId: string;
    readonly integrationName: string;
    readonly accountHandoff?: IntegrationAccountHandoff | null;
  }>;
  readonly presets?: readonly IntegrationPreset[];
  /** Trigger early download of the plugin's lazy component chunks (add/edit/etc.).
   *  Call from the host on intent (hover/focus) so the chunks land before the
   *  user navigates into the add page. Idempotent. */
  readonly preload?: () => void;
}

// ---------------------------------------------------------------------------
// SecretProviderPlugin — UI contract for plugins that contribute secret
// providers (1Password, WorkOS Vault, etc.). The host owns the secrets
// page chrome; the plugin owns the settings card rendered inside.
// ---------------------------------------------------------------------------

export interface SecretProviderPlugin {
  /** Unique key matching the SDK plugin id (e.g. "onepassword"). */
  readonly key: string;
  readonly label: string;
  readonly settings: ComponentType<Record<string, never>>;
}

export interface ClientPluginSpec<TId extends string = string> {
  readonly id: TId;
  readonly pages?: readonly PageDecl[];
  readonly widgets?: readonly WidgetDecl[];
  readonly slots?: Record<string, SlotComponent>;
  /** Integration plugin contribution — populated by plugins that expose
   *  `kind` rows in the core `source` table (openapi, mcp, graphql).
   *  The host's integrations page derives its provider
   *  list from the union of every loaded plugin's `integrationPlugin`. */
  readonly integrationPlugin?: IntegrationPlugin;
  /** Secret provider plugin contribution — populated by plugins that
   *  also ship a `secretProviders` (or related) server-side capability
   *  AND want to expose a settings card on the host's secrets page. */
  readonly secretProviderPlugin?: SecretProviderPlugin;
}

/**
 * Identity factory — returns the spec unchanged but pins the inferred
 * literal type of `id` so the host can index plugin records by id with
 * full autocomplete. Plugins export this as their package's default
 * (or named) export from `./client`.
 */
export const defineClientPlugin = <const TId extends string>(
  spec: ClientPluginSpec<TId>,
): ClientPluginSpec<TId> => spec;

// ---------------------------------------------------------------------------
// createPluginAtomClient — typed reactive HTTP client for one plugin.
//
// Wraps the plugin's `HttpApiGroup` in a per-plugin `HttpApi`, then
// hands back an `AtomHttpApi.Service` keyed to that bundle. The
// resulting service exposes `.query("group", "endpoint", opts)` and
// `.mutation("group", "endpoint")` factories — same shape as the host's
// existing `ExecutorApiClient` (see packages/react/src/api/client.tsx).
// Per-endpoint payload/response/error types flow through from the
// imported group, so plugin client code typechecks without codegen.
//
// The plugin id (used for the Service Tag and the synthetic API id) is
// read from `group.identifier` — the same string the plugin passed to
// `HttpApiGroup.make("foo")`. No second-source duplication.
// ---------------------------------------------------------------------------

export interface CreatePluginAtomClientOptions {
  /** Override the base URL. Defaults to `/api` (host strips this prefix
   *  when forwarding to the Effect handler) — same convention as the
   *  core `ExecutorApiClient`. */
  readonly baseUrl?: string | (() => string);
  /** Optional dynamic Authorization header for hosts whose active
   *  Executor Server Connection requires Basic or Bearer auth. */
  readonly authorizationHeader?: string | null | (() => string | null);
  /** Optional dynamic request headers supplied by the host shell. */
  readonly headers?:
    | Readonly<Record<string, string | null | undefined>>
    | (() => Readonly<Record<string, string | null | undefined>>);
}

export interface PluginAtomClientRequestTransformOptions {
  readonly baseUrl?: () => string;
  readonly authorizationHeader?: string | null | (() => string | null);
  readonly headers?:
    | Readonly<Record<string, string | null | undefined>>
    | (() => Readonly<Record<string, string | null | undefined>>);
}

/** @internal */
export const applyPluginAtomClientRequestTransform = (
  request: HttpClientRequest.HttpClientRequest,
  options: PluginAtomClientRequestTransformOptions,
): HttpClientRequest.HttpClientRequest => {
  let next = options.baseUrl ? HttpClientRequest.prependUrl(request, options.baseUrl()) : request;
  const authorization =
    typeof options.authorizationHeader === "function"
      ? options.authorizationHeader()
      : options.authorizationHeader;
  if (authorization) {
    next = HttpClientRequest.setHeader(next, "authorization", authorization);
  }
  const headers = typeof options.headers === "function" ? options.headers() : options.headers;
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) {
        next = HttpClientRequest.setHeader(next, name, value);
      }
    }
  }
  return next;
};

/**
 * Build a typed reactive client for a plugin's HttpApiGroup.
 *
 *   const FooClient = createPluginAtomClient(FooApi)
 *   export const fooThings = FooClient.query("foo", "listThings", { ... })
 *   export const fooSync   = FooClient.mutation("foo", "syncThing")
 *
 * Each plugin gets a private service Tag (`Plugin_<id>Client`) keyed by
 * the group's `identifier`, so multiple plugins coexist in the same
 * React tree without colliding.
 */
export const createPluginAtomClient = <
  G extends HttpApiGroup.HttpApiGroup<string, HttpApiEndpoint.Any, boolean>,
>(
  group: G,
  options: CreatePluginAtomClientOptions = {},
) => {
  const { baseUrl = "/api", authorizationHeader, headers } = options;
  const pluginId = group.identifier;
  const bundle = HttpApi.make(`plugin-${pluginId}`).add(group);
  const getBaseUrl = typeof baseUrl === "function" ? baseUrl : null;
  const staticBaseUrl = typeof baseUrl === "function" ? undefined : baseUrl;
  const getAuthorizationHeader =
    typeof authorizationHeader === "function" ? authorizationHeader : null;
  const hasAuthorization = authorizationHeader !== undefined && authorizationHeader !== null;
  const hasHeaders = headers !== undefined;
  const transformClient =
    getBaseUrl || hasAuthorization || hasHeaders
      ? HttpClient.mapRequest((request) =>
          applyPluginAtomClientRequestTransform(request, {
            ...(getBaseUrl ? { baseUrl: getBaseUrl } : {}),
            ...(getAuthorizationHeader
              ? { authorizationHeader: getAuthorizationHeader }
              : authorizationHeader !== undefined
                ? { authorizationHeader }
                : {}),
            ...(headers !== undefined ? { headers } : {}),
          }),
        )
      : undefined;

  return AtomHttpApi.Service<`Plugin_${G["identifier"]}Client`>()(`Plugin_${pluginId}Client`, {
    api: bundle,
    httpClient: FetchHttpClient.layer,
    ...(staticBaseUrl !== undefined ? { baseUrl: staticBaseUrl } : {}),
    ...(transformClient ? { transformClient } : {}),
  });
};

// ---------------------------------------------------------------------------
// ExecutorPluginsProvider + hooks — host-level distribution of the loaded
// `ClientPluginSpec[]` via React context.
//
// The host wraps once at the root of its tree (typically reading from
// `virtual:executor/plugins-client`); pages and shared components consume
// via the focused hooks (`useIntegrationPlugins` etc.) so they don't import
// from any host-app aggregator file. Pages stay portable across hosts —
// the same component renders against whatever plugin set the surrounding
// `<ExecutorPluginsProvider>` provides.
//
// Hooks throw if no provider is in scope so missing setup fails loudly;
// matches the pattern of `useScope` / `useAuth` already in the codebase.
// ---------------------------------------------------------------------------

interface ExecutorPluginsContextValue {
  readonly plugins: readonly ClientPluginSpec[];
  readonly integrationPlugins: readonly IntegrationPlugin[];
  readonly secretProviderPlugins: readonly SecretProviderPlugin[];
}

const ExecutorPluginsContext = createContext<ExecutorPluginsContextValue | null>(null);
ExecutorPluginsContext.displayName = "ExecutorPluginsContext";

export interface ExecutorPluginsProviderProps {
  readonly plugins: readonly ClientPluginSpec[];
  readonly children: ReactNode;
}

export function ExecutorPluginsProvider(
  props: ExecutorPluginsProviderProps,
): ReturnType<typeof createElement> {
  const { plugins, children } = props;
  const value = useMemo<ExecutorPluginsContextValue>(
    () => ({
      plugins,
      integrationPlugins: plugins.flatMap((p) =>
        p.integrationPlugin ? [p.integrationPlugin] : [],
      ),
      secretProviderPlugins: plugins.flatMap((p) =>
        p.secretProviderPlugin ? [p.secretProviderPlugin] : [],
      ),
    }),
    [plugins],
  );
  // Kick off lazy chunk downloads for every integration plugin once the host
  // mounts, so navigating into an add/edit page doesn't suspend.
  useEffect(() => {
    for (const ip of value.integrationPlugins) ip.preload?.();
  }, [value.integrationPlugins]);
  return createElement(ExecutorPluginsContext.Provider, { value }, children);
}

const usePluginsCtx = (hookName: string): ExecutorPluginsContextValue => {
  const ctx = useContext(ExecutorPluginsContext);
  if (!ctx) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React hook invariant
    throw new Error(`${hookName} must be called inside an <ExecutorPluginsProvider>.`);
  }
  return ctx;
};

/** Full list of loaded `ClientPluginSpec` values. */
export const useClientPlugins = (): readonly ClientPluginSpec[] =>
  usePluginsCtx("useClientPlugins").plugins;

/** Integration plugins extracted from `clientPlugins[].integrationPlugin`. */
export const useIntegrationPlugins = (): readonly IntegrationPlugin[] =>
  usePluginsCtx("useIntegrationPlugins").integrationPlugins;

/** Secret-provider plugins extracted from `clientPlugins[].secretProviderPlugin`. */
export const useSecretProviderPlugins = (): readonly SecretProviderPlugin[] =>
  usePluginsCtx("useSecretProviderPlugins").secretProviderPlugins;
