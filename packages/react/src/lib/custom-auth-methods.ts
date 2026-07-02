// ---------------------------------------------------------------------------
// Custom auth-method actions — the shared create/remove skeleton behind every
// accounts panel's "+ Custom method" flow. The shape is identical across
// plugins (openapi, graphql, mcp): convert the generic placements into the
// plugin's wire templates, merge-append via the plugin's configureAuth
// endpoint, then diff the response against the prior slugs to find the created
// method. Remove filters the set by slug and replaces.
//
// The plugin contributes only a small CODEC (wire-template ↔ generic
// `AuthMethod`) and its configure mutation; everything else lives here.
// ---------------------------------------------------------------------------

import { useCallback } from "react";
import * as Exit from "effect/Exit";

import type { AuthMethod, Placement } from "./auth-placements";
import type { CreateCustomMethod } from "../components/add-custom-method-modal";

/** The plugin-specific edges of the custom-method flow. `T` is the plugin's
 *  wire auth-template type (an object carrying a `slug`). */
export interface AuthMethodsCodec<T> {
  /** Project wire templates into the generic `AuthMethod[]` the hub renders. */
  readonly toAuthMethods: (templates: readonly T[]) => readonly AuthMethod[];
  /** Build the wire templates for a custom method from its generic placements.
   *  Empty result ⇒ the placements declare nothing persistable. Slugs are
   *  omitted/blank — the backend backfills `custom_<id>`. */
  readonly templatesFromPlacements: (placements: readonly Placement[]) => readonly T[];
  readonly slugOf: (template: T) => string;
}

/** The plugin's configureAuth mutation, normalized: merge-append by default,
 *  `replace` swaps the whole declared set. Resolves to the resulting template
 *  array via an Exit (the atom mutation's `promiseExit`). */
export type ConfigureAuthMethods<T> = (input: {
  readonly authenticationTemplate: readonly T[];
  readonly mode?: "merge" | "replace";
}) => Promise<Exit.Exit<readonly T[], unknown>>;

export interface CustomMethodActions {
  readonly createCustomMethod: CreateCustomMethod;
  readonly removeCustomMethod: (method: AuthMethod) => Promise<boolean>;
}

export function useCustomMethodActions<T>(options: {
  readonly existing: readonly T[];
  readonly codec: AuthMethodsCodec<T>;
  readonly configure: ConfigureAuthMethods<T>;
}): CustomMethodActions {
  const { existing, codec, configure } = options;

  const createCustomMethod = useCallback<CreateCustomMethod>(
    async (input: { readonly label: string; readonly placements: readonly Placement[] }) => {
      const templates = codec.templatesFromPlacements(input.placements);
      if (templates.length === 0) return null;
      const exit = await configure({ authenticationTemplate: templates });
      if (Exit.isFailure(exit)) return null;
      const before = new Set(existing.map((template: T) => codec.slugOf(template)));
      const created = codec
        .toAuthMethods(exit.value)
        .find((candidate: AuthMethod) => !before.has(String(candidate.template)));
      return created ?? null;
    },
    [codec, configure, existing],
  );

  const removeCustomMethod = useCallback(
    async (method: AuthMethod): Promise<boolean> => {
      if (method.source !== "custom") return false;
      const next = existing.filter(
        (template: T) => codec.slugOf(template) !== String(method.template),
      );
      const exit = await configure({ authenticationTemplate: next, mode: "replace" });
      return Exit.isSuccess(exit);
    },
    [codec, configure, existing],
  );

  return { createCustomMethod, removeCustomMethod };
}
