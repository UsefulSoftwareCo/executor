import { lazy, useCallback } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import type {
  IntegrationPlugin,
  IntegrationPreset,
  IntegrationQuickAddInput,
  IntegrationQuickAddResult,
} from "@executor-js/sdk/client";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import { slugifyNamespace } from "@executor-js/react/plugins/integration-identity";
import { placementFromHeaderPattern } from "@executor-js/react/lib/auth-placements";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { openApiPresets, type OpenApiPreset } from "../sdk/presets";
import { addOpenApiSpec } from "./atoms";
import { openApiWireAuthInput, templateFromPlacements } from "./auth-method-config";
import { decodeOpenApiSpecOverrides } from "../sdk/spec-overrides";

const normalizedSpecUrl = (url: string): string => {
  if (!URL.canParse(url)) return url.trim().replace(/\/$/, "");
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString().replace(/\/$/, "");
};

/** The preset table still knows things no spec can say — GitHub's OAuth
 *  endpoints against a spec that declares NO security at all. A registry row
 *  whose URL is a preset's URL gets that knowledge pulled across. */
const presetForSpecUrl = (url: string): OpenApiPreset | undefined => {
  const target = normalizedSpecUrl(url);
  return openApiPresets.find(
    (preset) => preset.url !== undefined && normalizedSpecUrl(preset.url) === target,
  );
};

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
      const preset = presetForSpecUrl(input.url);
      // Declared methods travel from BOTH knowledge sources: the preset's
      // OAuth template (endpoints a spec cannot carry) and the registry's
      // header pattern (GitHub's spec declares no security at all, but the
      // registry knows a PAT goes in the Authorization header). When neither
      // knows anything, omitting the field lets the spec's own schemes derive.
      const presetMethods = (preset?.authTemplate ?? []).flatMap((template) =>
        template.kind === "oauth2"
          ? [
              openApiWireAuthInput({
                ...template,
                slug: AuthTemplateSlug.make(template.slug),
                resource: template.resource ?? undefined,
              }),
            ]
          : [],
      );
      const registryPlacement = input.authHeader
        ? placementFromHeaderPattern(input.authHeader)
        : null;
      const authenticationTemplate = [
        ...presetMethods,
        ...(registryPlacement
          ? [openApiWireAuthInput(templateFromPlacements([registryPlacement]))]
          : []),
      ];
      const presetOverrides =
        specOverrides && specOverrides.length > 0 ? specOverrides : preset?.specOverrides;
      const exit = await doAdd({
        payload: {
          spec: { kind: "url" as const, url: input.url },
          slug,
          name: input.name,
          ...(input.domain ? { displayDomain: input.domain } : {}),
          ...(preset?.specFormat ? { specFormat: preset.specFormat } : {}),
          ...(preset?.family ? { family: preset.family } : {}),
          ...(preset?.healthCheck ? { healthCheck: preset.healthCheck } : {}),
          ...(presetOverrides && presetOverrides.length > 0
            ? { specOverrides: presetOverrides }
            : {}),
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
