import { useCallback, useMemo } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AuthTemplateSlug, IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";

import { TriangleAlert } from "lucide-react";

import { AccountsSection } from "@executor-js/react/components/accounts-section";
import { Alert, AlertDescription, AlertTitle } from "@executor-js/react/components/alert";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import type { CreateCustomMethod } from "@executor-js/react/components/add-custom-method-modal";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";

import { openApiConfigAtom, openapiConfigure } from "./atoms";
import { authMethodsFromConfig, templateFromPlacements } from "./auth-method-config";
import { googleAudienceWarningsForUrls } from "../sdk/google-presets";
import type { Authentication } from "../sdk/types";

const GOOGLE_AUDIENCE_WARNING: Readonly<Record<string, string>> = {
  "workspace-admin":
    "This connection includes Google Workspace admin APIs (Chat, Admin Directory, Admin Reports). Connecting requires a Workspace admin account — personal Gmail accounts cannot grant these scopes.",
  "unsupported-user":
    "This connection includes APIs (e.g. Google Keep) that Google does not grant through standard user OAuth consent. Those tools may fail to authorize.",
};

const NO_AUTH_METHOD: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  source: "spec",
  template: AuthTemplateSlug.make("none"),
  placements: [],
};

// ---------------------------------------------------------------------------
// OpenAPI Accounts hub — fills the generic detail page's `accounts` slot.
//
// Reads the integration's real `authenticationTemplate` (via `getConfig`),
// converts it to generic `AuthMethod[]`, and composes the generic
// `AccountsSection` — whose Add-account offers those methods plus a "+ Custom
// method" row (apiKey-only). The custom-method create is INJECTED here
// (`createCustomMethod`): generic placements → an `APIKeyAuthentication`
// (`templateFromPlacements`, slug omitted → backend `custom_<id>`) merge-
// appended onto the existing template and persisted via `configure`. Stays
// plugin-side because it touches the OpenAPI sdk `Authentication` types.
// ---------------------------------------------------------------------------

export default function OpenApiAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const configResult = useAtomValue(openApiConfigAtom(slug));
  const doConfigure = useAtomSet(openapiConfigure, { mode: "promiseExit" });

  // The wire `getConfig` template is structurally an `Authentication[]` (the
  // `slug` is an unbranded string on the wire); treat it as such for the
  // plugin-side converters that brand the slug back.
  const existingTemplate = useMemo<readonly Authentication[]>(() => {
    if (!AsyncResult.isSuccess(configResult) || configResult.value == null) return [];
    return (configResult.value.authenticationTemplate ?? []) as readonly Authentication[];
  }, [configResult]);

  const methods = useMemo<readonly AuthMethod[]>(() => {
    const declared = authMethodsFromConfig(existingTemplate);
    return declared.length > 0 ? declared : [NO_AUTH_METHOD];
  }, [existingTemplate]);

  // Add a custom apiKey method: build an `APIKeyAuthentication` from the generic
  // placements (slug omitted → backend backfills `custom_<id>`), merge-append it
  // onto the existing template, and persist. Returns the created `AuthMethod`
  // (derived from the same template) so Add-account can select it immediately.
  const createCustomMethod = useCallback<CreateCustomMethod>(
    async (input: { readonly label: string; readonly placements: readonly Placement[] }) => {
      const method = templateFromPlacements(input.placements);
      const exit = await doConfigure({
        params: { slug },
        payload: { authenticationTemplate: [...existingTemplate, method] },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) return null;
      const before = new Set(existingTemplate.map((template) => String(template.slug)));
      const created = authMethodsFromConfig(
        exit.value.authenticationTemplate as readonly Authentication[],
      ).find((candidate: AuthMethod) => !before.has(String(candidate.template)));
      return created ?? null;
    },
    [doConfigure, slug, existingTemplate],
  );

  const removeCustomMethod = useCallback(
    async (method: AuthMethod): Promise<boolean> => {
      if (method.source !== "custom") return false;
      const next = existingTemplate.filter(
        (template: Authentication) => String(template.slug) !== String(method.template),
      );
      const exit = await doConfigure({
        params: { slug },
        payload: { authenticationTemplate: next, mode: "replace" },
        reactivityKeys: integrationWriteKeys,
      });
      return Exit.isSuccess(exit);
    },
    [doConfigure, existingTemplate, slug],
  );

  // For a bundled `google` integration, surface a caution when any selected API
  // needs a privileged or unsupported OAuth consent the user should know about
  // BEFORE connecting an account. Derived from the stored Discovery URLs.
  const audienceWarnings = useMemo<readonly string[]>(() => {
    if (!AsyncResult.isSuccess(configResult) || configResult.value == null) return [];
    const urls = configResult.value.googleDiscoveryUrls ?? [];
    return googleAudienceWarningsForUrls(urls).flatMap((audience: string) => {
      const message = GOOGLE_AUDIENCE_WARNING[audience];
      return message ? [message] : [];
    });
  }, [configResult]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      {audienceWarnings.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Some Google APIs need special consent</AlertTitle>
          <AlertDescription>
            {audienceWarnings.map((message: string) => (
              <p key={message}>{message}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}
      <AccountsSection
        integration={slug}
        integrationName={integrationName}
        methods={methods}
        accountHandoff={accountHandoff}
        createCustomMethod={createCustomMethod}
        removeCustomMethod={removeCustomMethod}
      />
    </div>
  );
}
