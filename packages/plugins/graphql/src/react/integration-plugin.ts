import { lazy, useCallback } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type {
  IntegrationPlugin,
  IntegrationQuickAddInput,
  IntegrationQuickAddResult,
} from "@executor-js/sdk/client";
import { placementFromHeaderPattern } from "@executor-js/react/lib/auth-placements";
import { slugifyNamespace } from "@executor-js/react/plugins/integration-identity";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { graphqlPresets } from "../sdk/presets";
import { createGraphqlIntegrationOptimistic } from "./atoms";
import { graphqlAuthMethodInputsFromPlacements } from "./auth-method-config";

/** One-click add for a registry GraphQL row. A GraphQL endpoint cannot
 *  describe its own auth, so the registry's declared header pattern is the
 *  only carrier of facts like Linear's no-Bearer key — it becomes the
 *  declared method, exactly as the add page would seed it. */
function useGraphqlQuickAdd(): (
  input: IntegrationQuickAddInput,
) => Promise<IntegrationQuickAddResult> {
  const doAdd = useAtomSet(createGraphqlIntegrationOptimistic, { mode: "promiseExit" });
  return useCallback(
    async (input) => {
      const slug = slugifyNamespace(input.slug ?? input.name);
      if (!slug) return { ok: false, reason: "no derivable slug" };
      const placement = input.authHeader ? placementFromHeaderPattern(input.authHeader) : null;
      const authenticationTemplate = placement
        ? graphqlAuthMethodInputsFromPlacements([placement])
        : [];
      const exit = await doAdd({
        payload: {
          endpoint: input.url,
          slug,
          name: input.name,
          ...(authenticationTemplate.length > 0 ? { authenticationTemplate } : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) return { ok: false, reason: "add failed" };
      return { ok: true, slug: String(exit.value.slug) };
    },
    [doAdd],
  );
}

const importAdd = () => import("./AddGraphqlIntegration");
const importAccounts = () => import("./GraphqlAccountsPanel");

// No `editSheet`: GraphQL has no plugin-specific configuration beyond auth
// methods, which the Accounts hub already owns ("+ Custom method").
export const graphqlIntegrationPlugin: IntegrationPlugin = {
  key: "graphql",
  label: "GraphQL",
  add: lazy(importAdd),
  accounts: lazy(importAccounts),
  presets: graphqlPresets.map((preset) => ({ ...preset, registryListed: true })),
  preload: () => {
    void importAdd();
    void importAccounts();
  },
  useQuickAdd: useGraphqlQuickAdd,
};
