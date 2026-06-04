import type { Effect } from "effect";

import type { ConnectionRef } from "./connection";
import type { StorageError } from "./errors";
import type { ToolDef } from "./tool";

/* ─────────────────────────────  plugins  ─────────────────────────────
 * The v1 SDK's plugin model: `definePlugin` returns a spec keyed by a string
 * discriminant, `any`-defaulted generics keep the explosion contained to the
 * one declaration (`AnyIntegrationPlugin` is structurally a supertype of every
 * concrete plugin), and a distributive projection folds the registered tuple
 * back into the executor surface.
 *
 * Here that projection produces a single generic `add` instead of a per-plugin
 * extension bag: every plugin contributes one integration `kind` and the `add`
 * function for it, and `executor.integrations.add` is the union of all of them —
 * one method, dispatched on the input's `kind`, narrowing input and return to
 * the matching plugin. Core stays agnostic to any specific integration type.
 */

/**
 * A plugin contributes one integration *kind* to the catalog. It owns the shape
 * `add` accepts (must carry the `kind` discriminant) and what `add` returns for
 * that kind. `add` is pure — it normalizes the input into a catalog record;
 * persistence is the executor's job.
 */
export interface IntegrationPlugin<
  TKind extends string = string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TAddInput extends { readonly kind: TKind } = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TAddOutput = any,
> {
  /** Discriminant. Matches `input.kind` on `add` and the plugin's identity. */
  readonly kind: TKind;
  /** Normalize a kind-tagged add-input into its catalog record. Pure. */
  readonly add: (input: TAddInput) => TAddOutput;
  /**
   * Produce the tools for one connection — the v1 analog of how openapi/mcp
   * populate tool rows. Called by the SDK at create/refresh; its result is
   * stamped with addresses and persisted, so listing never calls back here.
   * openapi derives them from the integration record (its spec); mcp dials the
   * server via `getValue()` (the lazily-resolved credential). Omit for kinds
   * with no tools.
   */
  readonly resolveTools?: (
    input: ResolveToolsInput<TAddOutput>,
  ) => Effect.Effect<readonly ToolDef[], StorageError>;
}

/** Input to a plugin's `resolveTools`. */
export interface ResolveToolsInput<TIntegration> {
  /** The catalog record this plugin's `add` returned. */
  readonly integration: TIntegration;
  /** The connection whose tools are being resolved. */
  readonly connection: ConnectionRef;
  /** Lazily resolve the connection's credential value via its provider — only
   *  the kinds that actually call out (mcp) pay for it. */
  readonly getValue: () => Effect.Effect<string | null, StorageError>;
}

/**
 * `IntegrationPlugin<string>` (input/output taking their `any` defaults) is
 * structurally any concrete plugin — the `any` cascade stays inside the
 * interface defaults instead of leaking into every consumer.
 */
export type AnyIntegrationPlugin = IntegrationPlugin<string>;

/**
 * Author a plugin. Identity at runtime; its job is to pin the literal generics
 * (`kind`, add-input, add-output) so the tuple passed to `createExecutor`
 * carries precise per-plugin types into the generic `add` projection.
 */
export const definePlugin = <
  TKind extends string,
  TAddInput extends { readonly kind: TKind },
  TAddOutput,
>(
  plugin: IntegrationPlugin<TKind, TAddInput, TAddOutput>,
): IntegrationPlugin<TKind, TAddInput, TAddOutput> => plugin;

/* ───────────────────────  add() projection  ─────────────────────────── */

// Naked-parameter helpers so the conditionals distribute over the plugin union.
type AddInputOf<P> = P extends IntegrationPlugin<string, infer I, infer _O> ? I : never;
type AddOutputOf<P> = P extends IntegrationPlugin<string, infer _I, infer O> ? O : never;

/** The union of every registered plugin's add-input, discriminated by `kind`. */
export type AddInput<TPlugins extends readonly AnyIntegrationPlugin[]> = AddInputOf<
  TPlugins[number]
>;

/**
 * The generic `add` projected over a plugin tuple. One method, every kind:
 * accept any registered plugin's add-input, dispatch on `input.kind`, and return
 * that plugin's add-output (persisted, hence an Effect). `Extract<…, { kind }>`
 * selects the matching plugin from the tuple by its discriminant.
 */
export type AddFn<TPlugins extends readonly AnyIntegrationPlugin[]> = <
  TInput extends AddInput<TPlugins>,
>(
  input: TInput,
) => Effect.Effect<
  AddOutputOf<Extract<TPlugins[number], { readonly kind: TInput["kind"] }>>,
  StorageError
>;
