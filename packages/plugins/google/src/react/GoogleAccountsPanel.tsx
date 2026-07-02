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

import { googleConfigAtom, googleConfigure } from "./atoms";
import { googleAudienceWarningsForUrls } from "../sdk/presets";

const GOOGLE_AUDIENCE_WARNING: Readonly<Record<string, string>> = {
  "workspace-admin":
    "This connection includes Google Workspace admin APIs. Connecting requires a Workspace admin account; personal Gmail accounts cannot grant these scopes.",
  "unsupported-user":
    "This connection includes APIs that Google does not grant through standard user OAuth consent. Those tools may fail to authorize.",
};

const NO_AUTH_METHOD: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  source: "spec",
  template: AuthTemplateSlug.make("none"),
  placements: [],
};

export default function GoogleAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const configResult = useAtomValue(googleConfigAtom(slug));
  const doConfigure = useAtomSet(googleConfigure, { mode: "promiseExit" });

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
