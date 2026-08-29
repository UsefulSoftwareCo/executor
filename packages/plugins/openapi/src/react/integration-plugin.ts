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
import { openApiPresets } from "../sdk/presets";
import { detectedAuthenticationTemplates } from "../sdk/derive-auth";
import { addOpenApiSpec, previewOpenApiSpec } from "./atoms";
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
 *  whose URL is a preset's URL gets that knowledge pulled across. Matches the
 *  plugin's COMPLETE preset list, so a deployment's custom presets
 *  contribute too, not just the built-ins. */
const presetForSpecUrl = (
  presets: readonly IntegrationPreset[],
  url: string,
): IntegrationPreset | undefined => {
  const target = normalizedSpecUrl(url);
  return presets.find(
    (preset) => preset.url !== undefined && normalizedSpecUrl(preset.url) === target,
  );
};

/** One-click add for a registry OpenAPI row. The spec itself is the
 *  configuration: omitting `authenticationTemplate` and `baseUrl` tells the
 *  server to derive both from the document, exactly what the add page's
 *  untouched defaults submit. Registry spec overrides ride along. */
function makeUseQuickAdd(presets: readonly IntegrationPreset[]) {
  return function useOpenApiQuickAdd(): (
    input: IntegrationQuickAddInput,
  ) => Promise<IntegrationQuickAddResult> {
    const doAdd = useAtomSet(addOpenApiSpec, { mode: "promiseExit" });
    const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
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
        const preset = presetForSpecUrl(presets, input.url);
        // The FULL add page's method policy, replicated exactly: a preset's
        // OAuth template wins outright; otherwise EVERY spec-detected method is
        // preserved (an explicit template suppresses server-side derivation, so
        // sending only the registry header would erase a spec's declared OAuth
        // and key schemes); the registry's header pattern is appended only when
        // the detected set has no API-key method (GitHub declares no security
        // at all, and a PAT header is how most calls actually authenticate).
        const registryPlacement = input.authHeader
          ? placementFromHeaderPattern(input.authHeader)
          : null;
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
        let authenticationTemplate = presetMethods;
        if (presetMethods.length === 0 && registryPlacement) {
          // Composing with spec knowledge needs the spec: one preview call,
          // only on this path (a plain registry row with no auth facts still
          // adds with zero extra round trips).
          const previewExit = await doPreview({ payload: { spec: input.url } });
          if (Exit.isFailure(previewExit)) return { ok: false, reason: "preview failed" };
          const previewSummary = previewExit.value;
          const detected = detectedAuthenticationTemplates(
            previewSummary.headerPresets,
            previewSummary.oauth2Presets,
            previewSummary.servers[0]?.url ?? "",
          );
          const detectedHasApiKey = detected.some((template) => template.kind === "apikey");
          authenticationTemplate = [
            ...detected.map(openApiWireAuthInput),
            ...(detectedHasApiKey
              ? []
              : [openApiWireAuthInput(templateFromPlacements([registryPlacement]))]),
          ];
        } else if (presetMethods.length > 0 && registryPlacement) {
          authenticationTemplate = [
            ...presetMethods,
            openApiWireAuthInput(templateFromPlacements([registryPlacement])),
          ];
        }
        // Preset overrides arrive as the same untyped JSON shape the registry
        // sends; decode both through the one boundary.
        const presetOverrides =
          specOverrides && specOverrides.length > 0
            ? specOverrides
            : preset?.specOverrides
              ? decodeOpenApiSpecOverrides(preset.specOverrides)
              : undefined;
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
      [doAdd, doPreview],
    );
  };
}

const importAdd = () => import("./AddOpenApiIntegration");
const importEditSheet = () => import("./UpdateSpecSection");
const importAccounts = () => import("./OpenApiAccountsPanel");

export interface OpenApiClientConfig {
  readonly presets?: readonly IntegrationPreset[];
}

export const createOpenApiIntegrationPlugin = (config?: OpenApiClientConfig): IntegrationPlugin => {
  // Built-ins are registry-listed (the picker shows the registry's card);
  // a deployment's custom presets are not, and keep their own cards.
  const presets: readonly IntegrationPreset[] = [
    ...openApiPresets.map((preset) => ({ ...preset, registryListed: true })),
    ...(config?.presets ?? []),
  ];
  return {
    key: "openapi",
    label: "OpenAPI",
    add: lazy(importAdd),
    editSheet: lazy(importEditSheet),
    accounts: lazy(importAccounts),
    presets,
    preload: () => {
      void importAdd();
      void importEditSheet();
      void importAccounts();
    },
    useQuickAdd: makeUseQuickAdd(presets),
  };
};

export const openApiIntegrationPlugin: IntegrationPlugin = createOpenApiIntegrationPlugin();
