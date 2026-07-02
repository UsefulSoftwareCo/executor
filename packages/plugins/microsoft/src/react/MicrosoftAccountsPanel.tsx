import { useCallback, useMemo } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AuthTemplateSlug, IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";

import { AccountsSection } from "@executor-js/react/components/accounts-section";
import {
  HealthCheckEditor,
  type HealthCheckLivePreview,
} from "@executor-js/react/components/health-check-editor";
import { useOrganizationId } from "@executor-js/react/api/organization-context";
import { defaultConnectionOwnerForHost } from "@executor-js/react/plugins/connection-owner";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import {
  useCustomMethodActions,
  type AuthMethodsCodec,
  type ConfigureAuthMethods,
} from "@executor-js/react/lib/custom-auth-methods";
import {
  authMethodsFromConfig,
  openApiWireAuthInput,
  templateFromPlacements,
} from "@executor-js/plugin-openapi/react";
import type { Authentication } from "@executor-js/plugin-openapi";

import { microsoftConfigAtom, microsoftConfigure } from "./atoms";

const NO_AUTH_METHOD: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  source: "spec",
  template: AuthTemplateSlug.make("none"),
  placements: [],
};

export default function MicrosoftAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const configResult = useAtomValue(microsoftConfigAtom(slug));
  const doConfigure = useAtomSet(microsoftConfigure, { mode: "promiseExit" });

  const existingTemplate = useMemo<readonly Authentication[]>(() => {
    if (!AsyncResult.isSuccess(configResult) || configResult.value == null) return [];
    return (configResult.value.authenticationTemplate ?? []) as readonly Authentication[];
  }, [configResult]);

  const methods = useMemo<readonly AuthMethod[]>(() => {
    const declared = authMethodsFromConfig(existingTemplate);
    return declared.length > 0 ? declared : [NO_AUTH_METHOD];
  }, [existingTemplate]);

  const configure = useCallback<ConfigureAuthMethods<Authentication>>(
    async (input) => {
      const exit = await doConfigure({
        params: { slug },
        payload: {
          authenticationTemplate: input.authenticationTemplate.map(openApiWireAuthInput),
          ...(input.mode ? { mode: input.mode } : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      return Exit.map(exit, (result) => result.authenticationTemplate as readonly Authentication[]);
    },
    [doConfigure, slug],
  );

  const codec = useMemo<AuthMethodsCodec<Authentication>>(
    () => ({
      toAuthMethods: authMethodsFromConfig,
      templatesFromPlacements: (placements: readonly Placement[]) => [
        templateFromPlacements(placements),
      ],
      slugOf: (template: Authentication) => String(template.slug),
    }),
    [],
  );

  const { createCustomMethod, removeCustomMethod } = useCustomMethodActions({
    existing: existingTemplate,
    codec,
    configure,
  });

  // Live-preview context for the health-check edit sheet (apiKey methods only;
  // OAuth methods can't be previewed with a pasted key).
  const organizationId = useOrganizationId();
  const livePreview = useMemo<HealthCheckLivePreview | undefined>(() => {
    const templates = methods
      .filter((m) => m.kind === "apikey")
      .map((m) => ({ template: m.template, label: m.label }));
    if (templates.length === 0) return undefined;
    return { owner: defaultConnectionOwnerForHost(organizationId), templates };
  }, [methods, organizationId]);

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <AccountsSection
        integration={slug}
        integrationName={integrationName}
        methods={methods}
        accountHandoff={accountHandoff}
        createCustomMethod={createCustomMethod}
        removeCustomMethod={removeCustomMethod}
      />
      {/* Graph auto-configures the /me identity probe at add time; this is
          where an admin sees, adjusts, or clears it. */}
      <HealthCheckEditor integration={slug} livePreview={livePreview} />
    </div>
  );
}
