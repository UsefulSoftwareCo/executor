// ---------------------------------------------------------------------------
// Plugin-contributed HttpApi composition.
//
// The host iterates plugins, calls each plugin's `routes()` to get its
// `HttpApiGroup`, and reduces them into a single `HttpApi` for the runtime.
// Each plugin's `handlers()` returns a late-binding Layer keyed by the
// plugin's group identity, with the plugin's `extensionService` Tag left
// as a Layer requirement. The host satisfies that Tag — at boot for
// local (`composePluginHandlers(plugins, executor)`), per-request for
// cloud (`providePluginExtensions(plugins)(executor)` in the auth
// middleware).
//
// Static typing is intentionally loose here: the host composes a
// runtime-arbitrary set of plugin groups, so `FullApi` can't be tracked
// at compile time. Per-endpoint typing lives inside each plugin (its
// own bundled `HttpApi.make(id).add(group)` and its
// `createPluginAtomClient` frontend client). The host only needs the
// runtime composition.
// ---------------------------------------------------------------------------

import { Effect, Layer } from "effect";
import type { Context } from "effect";
import type { HttpApi, HttpApiGroup } from "effect/unstable/httpapi";
import type { AnyPlugin, PluginExtensions } from "@executor-js/sdk";

import { CoreExecutorApi } from "./api";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

/** Extract the Service-tag identifier (the class itself) from a plugin's
 *  `extensionService` field — used to populate the `provides` clause of
 *  `HttpRouter.middleware<{ provides: ... }>()` from the plugin tuple
 *  without enumerating each Tag by hand at the host.
 *
 *  Helper type indirection (`ExtractServiceId`) forces distribution over
 *  the union of plugin tags — TS only distributes conditionals when the
 *  LHS is a naked type parameter, not a derived type expression. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExtractServiceId<S> = S extends Context.Service<infer Id, any> ? Id : never;

export type PluginExtensionServices<TPlugins extends readonly AnyPlugin[]> = ExtractServiceId<
  NonNullable<TPlugins[number]["extensionService"]>
>;

/** Extract the precise `HttpApiGroup` type carried by a plugin's
 *  `routes()` field. Plugins without a `routes()` field contribute
 *  nothing to the union (filtered out by `Extract<..., HttpApiGroup.Any>`). */
type ExtractPluginGroup<P> = P extends { readonly routes?: () => infer G }
  ? Extract<G, HttpApiGroup.Any>
  : never;

/** Union of every plugin's contributed group — combined with the core
 *  executor groups to type `composePluginApi(plugins)` precisely. */
export type PluginGroups<TPlugins extends readonly AnyPlugin[]> = ExtractPluginGroup<
  TPlugins[number]
>;

/** Group identities baked into `CoreExecutorApi` (tools, integrations, secrets,
 *  …). Extracted via inference so adding a core group flows through
 *  without touching this helper. */
type CoreGroups =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  typeof CoreExecutorApi extends HttpApi.HttpApi<any, infer G> ? G : never;

/** Result of `composePluginApi(plugins)` — the core API extended with
 *  every plugin group from `TPlugins`. */
export type ComposedExecutorApi<TPlugins extends readonly AnyPlugin[]> = HttpApi.HttpApi<
  "executor",
  CoreGroups | PluginGroups<TPlugins>
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLayer = Layer.Layer<any, any, any>;

// Use the field accessor + NonNullable rather than `extends { handlers: ... }`
// because the spec marks `handlers` optional (`handlers?:`); the conditional
// form would fail the match because the field type includes `undefined`.
type ExtractHandlerLayer<P> =
  NonNullable<P extends { readonly handlers?: infer F } ? F : never> extends () => infer L
    ? L
    : never;

// Compute the union of every plugin's handler-Layer type. Each plugin's
// `handlers()` returns a specific `Layer<Group, never, ExtensionService>`;
// we union them so `Layer.mergeAll(...)`'s output type can be extracted
// without erasing per-plugin requirements.
type PluginHandlerLayers<TPlugins extends readonly AnyPlugin[]> = ExtractHandlerLayer<
  TPlugins[number]
>;

// Distribute over the union of handler layers to extract each channel
// individually, then re-pack into a single `Layer<UnionROut, UnionE,
// UnionRIn>` matching what `Layer.mergeAll` produces at runtime. Naive
// `Union extends Layer<infer A, ...>` would distribute and yield a
// union of layers, not a merged layer — these helpers fold instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerROut<L> = L extends Layer.Layer<infer ROut, any, any> ? ROut : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerE<L> = L extends Layer.Layer<any, infer E, any> ? E : never;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LayerRIn<L> = L extends Layer.Layer<any, any, infer RIn> ? RIn : never;

type MergedHandlerLayer<TPlugins extends readonly AnyPlugin[]> = Layer.Layer<
  LayerROut<PluginHandlerLayers<TPlugins>>,
  LayerE<PluginHandlerLayers<TPlugins>>,
  LayerRIn<PluginHandlerLayers<TPlugins>>
>;

/**
 * Compose plugin-contributed `HttpApiGroup`s into the core executor API.
 * Plugins without a `routes()` field are skipped.
 *
 * Returns a precisely typed `HttpApi<"executor", CoreGroups |
 * PluginGroups<TPlugins>>`. Hosts that need `HttpApiClient.ForApi<typeof
 * ProtectedCloudApi>` get exact endpoint types without per-plugin
 * `import type { …Group }` statements at the host.
 */
export const composePluginApi = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
): ComposedExecutorApi<TPlugins> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any = CoreExecutorApi;
  for (const plugin of plugins) {
    if (plugin.routes) {
      const group = plugin.routes();
      api = api.add(group);
    }
  }
  return api as ComposedExecutorApi<TPlugins>;
};

/**
 * Build the merged Layer of plugin handler implementations, satisfying
 * each plugin's `extensionService` Tag eagerly from `executor[id]`.
 *
 * Suitable for hosts (like local) that have a single, boot-time
 * executor. Hosts with per-request executors (cloud) should use
 * `composePluginHandlerLayer` + `providePluginExtensions` instead.
 */
export const composePluginHandlers = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
  extensions: PluginExtensions<TPlugins>,
): AnyLayer => {
  const layers: AnyLayer[] = [];
  for (const p of plugins) {
    if (!p.handlers) continue;
    const handlerLayer = p.handlers();
    if (!p.extensionService) {
      layers.push(handlerLayer);
      continue;
    }
    const ext = (extensions as Record<string, unknown>)[p.id];
    layers.push(
      handlerLayer.pipe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Layer.provide(Layer.succeed(p.extensionService)(ext as any)),
      ),
    );
  }
  // `Layer.empty` is `Layer<never, never, never>`; widening to `AnyLayer`
  // (`Layer<any, any, any>`) needs the unknown step because TS can't see
  // through Layer's variance markers without it.
  // oxlint-disable-next-line executor/no-double-cast
  if (layers.length === 0) return Layer.empty as unknown as AnyLayer;
  return Layer.mergeAll(...(layers as [AnyLayer, ...AnyLayer[]]));
};

/**
 * Build the merged late-binding Layer of plugin handler implementations
 * WITHOUT satisfying their `extensionService` Tags. Compose into
 * `HttpApiBuilder.layer(FullApi)` at boot; satisfy the Tags per-request
 * via `providePluginExtensions` in an `HttpRouter` middleware.
 *
 * The return type is the union of each plugin's `handlers()` Layer
 * type — that preserves the per-plugin requirements (typically
 * `*ExtensionService` Tags) so the host's `HttpRouter.middleware`
 * recognises them as per-request requires.
 */
export const composePluginHandlerLayer = <TPlugins extends readonly AnyPlugin[]>(
  plugins: TPlugins,
): MergedHandlerLayer<TPlugins> => {
  const layers = plugins.flatMap((p) => (p.handlers ? [p.handlers()] : []));
  // `MergedHandlerLayer<TPlugins>` is computed from the plugin tuple at
  // the type level — TS can't witness that `Layer.mergeAll(...layers)` /
  // `Layer.empty` actually produces it without the unknown bridge.
  if (layers.length === 0) {
    // oxlint-disable-next-line executor/no-double-cast
    return Layer.empty as unknown as MergedHandlerLayer<TPlugins>;
  }
  // oxlint-disable-next-line executor/no-double-cast
  return Layer.mergeAll(
    ...(layers as [AnyLayer, ...AnyLayer[]]),
  ) as unknown as MergedHandlerLayer<TPlugins>;
};

/**
 * Per-request helper: fold each plugin's `extensionService` Tag onto an
 * effect via `Effect.provideService(tag, executor[id])`. The plugin
 * spec carries the Tag so the host doesn't import each plugin's
 * `<plugin>/api` subpath directly.
 *
 *   const provide = providePluginExtensions(plugins);
 *   return yield* httpEffect.pipe(provide(requestExecutor));
 */
export const providePluginExtensions =
  <TPlugins extends readonly AnyPlugin[]>(plugins: TPlugins) =>
  (extensions: PluginExtensions<TPlugins>) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, PluginExtensionServices<TPlugins>>> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let out: Effect.Effect<A, E, any> = effect;
    for (const plugin of plugins) {
      if (!plugin.extensionService) continue;
      const ext = (extensions as Record<string, unknown>)[plugin.id];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      out = out.pipe(Effect.provideService(plugin.extensionService, ext as any));
    }
    return out as Effect.Effect<A, E, Exclude<R, PluginExtensionServices<TPlugins>>>;
  };
