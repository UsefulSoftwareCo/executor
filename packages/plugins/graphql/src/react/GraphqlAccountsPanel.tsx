import { useCallback, useMemo } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";

import { AccountsSection } from "@executor-js/react/components/accounts-section";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import {
  useCustomMethodActions,
  type AuthMethodsCodec,
  type ConfigureAuthMethods,
} from "@executor-js/react/lib/custom-auth-methods";

import { graphqlConfigAtom, graphqlConfigure } from "./atoms";
import {
  authMethodsFromConfig,
  graphqlAuthMethodInputsFromPlacements,
  graphqlWireAuthInput,
} from "./auth-method-config";
import type { GraphqlAuthMethod } from "../sdk/types";

// ---------------------------------------------------------------------------
// GraphQL Accounts hub — fills the generic detail page's `accounts` slot.
//
// Reads the integration's real `authenticationTemplate` (via `getConfig`),
// converts it to generic `AuthMethod[]`, and composes the generic
// `AccountsSection` — whose Add-account offers those methods plus a "+ Custom
// method" row (apikey-only). The custom-method create is INJECTED here
// (`createCustomMethod`): generic placements → ONE apikey method
// (`graphqlAuthMethodInputsFromPlacements`, slug omitted → backend
// `custom_<id>`) merge-appended via `configure`. Stays plugin-side because it
// touches the graphql sdk method types.
// ---------------------------------------------------------------------------

export default function GraphqlAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const configResult = useAtomValue(graphqlConfigAtom(slug));
  const doConfigure = useAtomSet(graphqlConfigure, { mode: "promiseExit" });

  const existingTemplate = useMemo<readonly GraphqlAuthMethod[]>(() => {
    if (!AsyncResult.isSuccess(configResult) || configResult.value == null) return [];
    return configResult.value.authenticationTemplate ?? [];
  }, [configResult]);

  const methods = useMemo<readonly AuthMethod[]>(
    () => authMethodsFromConfig(existingTemplate),
    [existingTemplate],
  );

  // Custom-method create/remove: the shared skeleton (merge-append → diff out
  // the created method; filter → replace) parameterized by the GraphQL codec.
  // Stays plugin-side only where it touches the graphql method types.
  const configure = useCallback<ConfigureAuthMethods<GraphqlAuthMethod>>(
    async (input) => {
      const exit = await doConfigure({
        params: { slug: String(slug) },
        payload: {
          authenticationTemplate: input.authenticationTemplate.map(graphqlWireAuthInput),
          ...(input.mode ? { mode: input.mode } : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      return Exit.map(exit, (result) => result.authenticationTemplate);
    },
    [doConfigure, slug],
  );

  const codec = useMemo<AuthMethodsCodec<GraphqlAuthMethod>>(
    () => ({
      toAuthMethods: authMethodsFromConfig,
      // Inputs omit slugs — the backend merge backfills `custom_<id>`.
      templatesFromPlacements: (placements: readonly Placement[]) =>
        graphqlAuthMethodInputsFromPlacements(placements) as readonly GraphqlAuthMethod[],
      slugOf: (template: GraphqlAuthMethod) => template.slug,
    }),
    [],
  );

  const { createCustomMethod, removeCustomMethod } = useCustomMethodActions({
    existing: existingTemplate,
    codec,
    configure,
  });

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
    </div>
  );
}
