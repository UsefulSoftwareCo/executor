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

export interface PageDecl {
  /** Path relative to the plugin's mount point, e.g. `/`, `/edit/$id`. */
  readonly path: string;
  readonly component: ComponentType;
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
// SourcePlugin / SourcePreset — UI contract for plugins that expose
// "sources" (OpenAPI specs, MCP servers, GraphQL endpoints, etc.). The
// host owns the source list / detail chrome; the plugin owns the
// add-flow, edit form, and (optional) summary + sign-in buttons.
//
// Lives here, not in `@executor-js/react`, so it's part of the plugin
// contract: a plugin's `./client` entry assembles its `sourcePlugin`
// alongside `pages`/`widgets`, and the host derives the union list
// from `virtual:executor/plugins-client`.
// ---------------------------------------------------------------------------

export interface SourcePreset {
  /** Unique id (e.g. "stripe", "github-graphql"). */
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** URL passed as `initialUrl` to the add form. Omit for presets that
   *  don't use a URL (e.g. stdio MCP presets). */
  readonly url?: string;
  /** Optional icon URL (favicon, logo). */
  readonly icon?: string;
  /** Shown in the top-level grid on the sources page when true. */
  readonly featured?: boolean;
}

export interface SourcePlugin {
  /** Unique key matching the SDK plugin id (e.g. "openapi"). */
  readonly key: string;
  readonly label: string;
  readonly add: ComponentType<{
    readonly onComplete: () => void;
    readonly onCancel: () => void;
    readonly initialUrl?: string;
    readonly initialPreset?: string;
    readonly initialNamespace?: string;
  }>;
  readonly edit: ComponentType<{
    readonly sourceId: string;
    readonly onSave: () => void;
  }>;
  readonly summary?: ComponentType<{
    readonly sourceId: string;
    readonly variant?: "badge" | "panel";
    readonly onAction?: () => void;
  }>;
  readonly presets?: readonly SourcePreset[];
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
  /** Source plugin contribution — populated by plugins that expose
   *  `kind` rows in the core `source` table (openapi, mcp, graphql,
   *  google-discovery). The host's sources page derives its provider
   *  list from the union of every loaded plugin's `sourcePlugin`. */
  readonly sourcePlugin?: SourcePlugin;
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
}

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
  const { baseUrl = "/api" } = options;
  const pluginId = group.identifier;
  const bundle = HttpApi.make(`plugin-${pluginId}`).add(group);
  return AtomHttpApi.Service<`Plugin_${G["identifier"]}Client`>()(`Plugin_${pluginId}Client`, {
    api: bundle,
    httpClient: FetchHttpClient.layer,
    ...(typeof baseUrl === "function"
      ? {
          transformClient: HttpClient.mapRequest((request) =>
            HttpClientRequest.prependUrl(request, baseUrl()),
          ),
        }
      : { baseUrl }),
  });
};

// ---------------------------------------------------------------------------
// ExecutorPluginsProvider + hooks — host-level distribution of the loaded
// `ClientPluginSpec[]` via React context.
//
// The host wraps once at the root of its tree (typically reading from
// `virtual:executor/plugins-client`); pages and shared components consume
// via the focused hooks (`useSourcePlugins` etc.) so they don't import
// from any host-app aggregator file. Pages stay portable across hosts —
// the same component renders against whatever plugin set the surrounding
// `<ExecutorPluginsProvider>` provides.
//
// Hooks throw if no provider is in scope so missing setup fails loudly;
// matches the pattern of `useScope` / `useAuth` already in the codebase.
// ---------------------------------------------------------------------------

interface ExecutorPluginsContextValue {
  readonly plugins: readonly ClientPluginSpec[];
  readonly sourcePlugins: readonly SourcePlugin[];
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
      sourcePlugins: plugins.flatMap((p) => (p.sourcePlugin ? [p.sourcePlugin] : [])),
      secretProviderPlugins: plugins.flatMap((p) =>
        p.secretProviderPlugin ? [p.secretProviderPlugin] : [],
      ),
    }),
    [plugins],
  );
  // Kick off lazy chunk downloads for every source plugin once the host
  // mounts, so navigating into an add/edit page doesn't suspend.
  useEffect(() => {
    for (const sp of value.sourcePlugins) sp.preload?.();
  }, [value.sourcePlugins]);
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

/** Source plugins extracted from `clientPlugins[].sourcePlugin`. */
export const useSourcePlugins = (): readonly SourcePlugin[] =>
  usePluginsCtx("useSourcePlugins").sourcePlugins;

/** Secret-provider plugins extracted from `clientPlugins[].secretProviderPlugin`. */
export const useSecretProviderPlugins = (): readonly SecretProviderPlugin[] =>
  usePluginsCtx("useSecretProviderPlugins").secretProviderPlugins;
