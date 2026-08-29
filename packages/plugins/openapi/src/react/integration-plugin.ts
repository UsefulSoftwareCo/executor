import { lazy, useCallback } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type {
  IntegrationPlugin,
  IntegrationPreset,
  IntegrationQuickAddInput,
  IntegrationQuickAddResult,
} from "@executor-js/sdk/client";
import { slugifyNamespace } from "@executor-js/react/plugins/integration-identity";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { openApiPresets } from "../sdk/presets";
import { addOpenApiSpec } from "./atoms";
import { decodeOpenApiSpecOverrides } from "../sdk/spec-overrides";

/** One-click add for a registry OpenAPI row. The spec itself is the
 *  configuration: omitting `authenticationTemplate` and `baseUrl` tells the
 *  server to derive both from the document, exactly what the add page's
 *  untouched defaults submit. Registry spec overrides ride along. */
function useOpenApiQuickAdd(): (
  input: IntegrationQuickAddInput,
) => Promise<IntegrationQuickAddResult> {
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promiseExit" });
  return useCallback(
    async (input) => {
      const slug = slugifyNamespace(input.slug ?? input.name);
      if (!slug) return { ok: false, reason: "no derivable slug" };
      // Registry overrides arrive as untyped JSON; a malformed patch goes to
      // the configuration screen (its editor renders the parse error) rather
      // than being silently dropped from a "successful" quick add.
      const specOverrides = input.specOverrides
        ? decodeOpenApiSpecOverrides(input.specOverrides)
        : undefined;
      if (input.specOverrides && input.specOverrides.length > 0 && specOverrides === undefined) {
        return { ok: false, reason: "unparseable spec overrides" };
      }
      const exit = await doAdd({
        payload: {
          spec: { kind: "url" as const, url: input.url },
          slug,
          name: input.name,
          ...(specOverrides && specOverrides.length > 0 ? { specOverrides } : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) return { ok: false, reason: "add failed" };
      return { ok: true, slug: String(exit.value.slug) };
    },
    [doAdd],
  );
}

const importAdd = () => import("./AddOpenApiIntegration");
const importEditSheet = () => import("./UpdateSpecSection");
const importAccounts = () => import("./OpenApiAccountsPanel");

export interface OpenApiClientConfig {
  readonly presets?: readonly IntegrationPreset[];
}

export const createOpenApiIntegrationPlugin = (
  config?: OpenApiClientConfig,
): IntegrationPlugin => ({
  key: "openapi",
  label: "OpenAPI",
  add: lazy(importAdd),
  editSheet: lazy(importEditSheet),
  accounts: lazy(importAccounts),
  presets: [...openApiPresets, ...(config?.presets ?? [])],
  preload: () => {
    void importAdd();
    void importEditSheet();
    void importAccounts();
  },
  useQuickAdd: useOpenApiQuickAdd,
});

export const openApiIntegrationPlugin: IntegrationPlugin = createOpenApiIntegrationPlugin();
