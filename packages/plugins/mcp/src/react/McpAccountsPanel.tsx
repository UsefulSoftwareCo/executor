import { useCallback, useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { AccountsSection } from "@executor-js/react/components/accounts-section";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import {
  useCustomMethodActions,
  type AuthMethodsCodec,
  type ConfigureAuthMethods,
} from "@executor-js/react/lib/custom-auth-methods";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";

import { configureMcpAuth, mcpServerAtom } from "./atoms";
import {
  authMethodsFromConfig,
  mcpAuthMethodInputsFromPlacements,
  mcpWireAuthInput,
} from "./auth-method-config";
import type { McpAuthMethod } from "../sdk/types";

// ---------------------------------------------------------------------------
// MCP Accounts hub — fills the generic detail page's `accounts` slot.
//
// Reads the integration's declared `authenticationTemplate` (via `getServer`),
// converts it to generic `AuthMethod[]`, and composes the generic
// `AccountsSection` — whose Add-account offers those methods plus a "+ Custom
// method" row. The custom-method create/remove is the shared skeleton
// (`useCustomMethodActions`) parameterized by the MCP codec and the
// merge-append `configureAuth` endpoint, so adding an API key method never
// displaces a declared OAuth method. Stdio servers have no remote credential
// to configure — no methods, no custom-method affordance.
// ---------------------------------------------------------------------------

export default function McpAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const doConfigureAuth = useAtomSet(configureMcpAuth, { mode: "promiseExit" });

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  const config = server?.config ?? null;
  const remote = config !== null && config.transport === "remote" ? config : null;

  const existingTemplate = useMemo<readonly McpAuthMethod[]>(
    () => config?.authenticationTemplate ?? [],
    [config],
  );

  // Stdio servers declare a `stdio_env` / `none` method too, so their
  // auto-created connection and its env credentials surface here. The endpoint
  // only feeds remote oauth methods' probe URL; stdio has none.
  const methods = useMemo<readonly AuthMethod[]>(
    () => (config ? authMethodsFromConfig(existingTemplate, remote?.endpoint ?? "") : []),
    [existingTemplate, config, remote],
  );

  const configure = useCallback<ConfigureAuthMethods<McpAuthMethod>>(
    async (input) => {
      const exit = await doConfigureAuth({
        params: { slug },
        payload: {
          authenticationTemplate: input.authenticationTemplate.map(mcpWireAuthInput),
          ...(input.mode ? { mode: input.mode } : {}),
        },
        reactivityKeys: integrationWriteKeys,
      });
      return Exit.map(exit, (result) => result.authenticationTemplate);
    },
    [doConfigureAuth, slug],
  );

  const codec = useMemo<AuthMethodsCodec<McpAuthMethod>>(
    () => ({
      toAuthMethods: (templates: readonly McpAuthMethod[]) =>
        authMethodsFromConfig(templates, remote?.endpoint ?? ""),
      // MCP custom methods are header credentials; the inputs omit slugs and
      // the backend merge backfills `custom_<id>`.
      templatesFromPlacements: (placements: readonly Placement[]) =>
        mcpAuthMethodInputsFromPlacements(placements) as readonly McpAuthMethod[],
      slugOf: (template: McpAuthMethod) => template.slug,
    }),
    [remote?.endpoint],
  );

  const { createCustomMethod, removeCustomMethod } = useCustomMethodActions({
    existing: existingTemplate,
    codec,
    configure,
  });

  const canConfigureAuth = remote !== null;

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
      <AccountsSection
        integration={slug}
        integrationName={integrationName}
        methods={methods}
        accountHandoff={accountHandoff}
        createCustomMethod={canConfigureAuth ? createCustomMethod : undefined}
        removeCustomMethod={canConfigureAuth ? removeCustomMethod : undefined}
      />
    </div>
  );
}
