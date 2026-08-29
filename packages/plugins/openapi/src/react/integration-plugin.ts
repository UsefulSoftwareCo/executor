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
import { placementFromHeaderPattern, type Placement } from "@executor-js/react/lib/auth-placements";
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

/** The spec inputs a quick add must hold CONSISTENT between preview and add:
 *  deriving auth from a document other than the one being added is how a
 *  preset's scope overrides got silently dropped. Preset overrides win over
 *  the registry's, mirroring the full add page. */
export const quickAddSpecPlan = (
  preset: IntegrationPreset | undefined,
  registryOverrides: ReturnType<typeof decodeOpenApiSpecOverrides>,
): {
  readonly specFormat?: string;
  readonly specOverrides?: NonNullable<ReturnType<typeof decodeOpenApiSpecOverrides>>;
} => {
  const presetOverrides = preset?.specOverrides
    ? decodeOpenApiSpecOverrides(preset.specOverrides)
    : undefined;
  // PRESENCE-based, mirroring the full page's `presetOverrides ??
  // registryOverrides`: a preset declaring an explicitly EMPTY override list
  // is a decision — suppress the registry's patches — not an absence.
  const effective = presetOverrides !== undefined ? presetOverrides : registryOverrides;
  return {
    ...(preset?.specFormat ? { specFormat: preset.specFormat } : {}),
    ...(effective && effective.length > 0 ? { specOverrides: effective } : {}),
  };
};

/** The preview and add requests built from ONE plan, so they cannot diverge:
 *  deriving auth from a different effective document than the one stored is
 *  the bug this module has now had twice. The add payload takes further
 *  fields (family, health check, auth template) AFTER this base. */
export const quickAddRequestPayloads = (
  input: { readonly url: string; readonly name: string; readonly domain?: string },
  slug: string,
  specPlan: ReturnType<typeof quickAddSpecPlan>,
): {
  readonly preview: { readonly spec: string } & ReturnType<typeof quickAddSpecPlan>;
  readonly add: {
    readonly spec: { readonly kind: "url"; readonly url: string };
    readonly slug: string;
    readonly name: string;
    readonly displayDomain?: string;
  } & ReturnType<typeof quickAddSpecPlan>;
} => ({
  preview: { spec: input.url, ...specPlan },
  add: {
    spec: { kind: "url", url: input.url },
    slug,
    name: input.name,
    ...(input.domain ? { displayDomain: input.domain } : {}),
    ...specPlan,
  },
});

/** The full add page's method policy as one pure step: preset OAuth wins
 *  outright; else every preview-detected method is preserved and the
 *  registry's key placement is appended only when the detected set has no
 *  key method (GitHub declares no security at all). `preview` MUST be the
 *  summary of the same effective document the add will store. */
export const composeQuickAddAuth = (
  presetMethods: readonly ReturnType<typeof openApiWireAuthInput>[],
  registryPlacement: Placement | null,
  preview: {
    readonly headerPresets: Parameters<typeof detectedAuthenticationTemplates>[0];
    readonly oauth2Presets: Parameters<typeof detectedAuthenticationTemplates>[1];
    readonly servers: readonly { readonly url: string }[];
  } | null,
): readonly ReturnType<typeof openApiWireAuthInput>[] => {
  if (presetMethods.length > 0) {
    return registryPlacement
      ? [...presetMethods, openApiWireAuthInput(templateFromPlacements([registryPlacement]))]
      : presetMethods;
  }
  if (!registryPlacement || preview === null) return presetMethods;
  const detected = detectedAuthenticationTemplates(
    preview.headerPresets,
    preview.oauth2Presets,
    preview.servers[0]?.url ?? "",
  );
  const detectedHasApiKey = detected.some((template) => template.kind === "apikey");
  return [
    ...detected.map(openApiWireAuthInput),
    ...(detectedHasApiKey
      ? []
      : [openApiWireAuthInput(templateFromPlacements([registryPlacement]))]),
  ];
};

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
        // ONE spec plan for both preview and add: deriving auth from a
        // different effective document than the one stored is how a preset's
        // scope overrides got silently dropped.
        const specPlan = quickAddSpecPlan(preset, specOverrides);
        const requests = quickAddRequestPayloads(
          { url: input.url, name: input.name, ...(input.domain ? { domain: input.domain } : {}) },
          slug,
          specPlan,
        );
        let preview: Parameters<typeof composeQuickAddAuth>[2] = null;
        if (presetMethods.length === 0 && registryPlacement) {
          // Composing with spec knowledge needs the spec: one preview call,
          // only on this path (a plain registry row with no auth facts still
          // adds with zero extra round trips).
          const previewExit = await doPreview({ payload: requests.preview });
          if (Exit.isFailure(previewExit)) return { ok: false, reason: "preview failed" };
          preview = previewExit.value;
        }
        const authenticationTemplate = composeQuickAddAuth(
          presetMethods,
          registryPlacement,
          preview,
        );
        const exit = await doAdd({
          payload: {
            ...requests.add,
            ...(preset?.family ? { family: preset.family } : {}),
            ...(preset?.healthCheck ? { healthCheck: preset.healthCheck } : {}),
            ...(authenticationTemplate.length > 0
              ? { authenticationTemplate: [...authenticationTemplate] }
              : {}),
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
