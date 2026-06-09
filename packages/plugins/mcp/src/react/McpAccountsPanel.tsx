import { useCallback, useMemo } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { AuthTemplateSlug, IntegrationSlug } from "@executor-js/sdk/shared";
import type { IntegrationAccountHandoff } from "@executor-js/sdk/client";
import { AccountsSection } from "@executor-js/react/components/accounts-section";
import type { CreateCustomMethod } from "@executor-js/react/components/add-custom-method-modal";
import type { AuthMethod, Placement } from "@executor-js/react/lib/auth-placements";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";

import { configureMcpServer, mcpServerAtom } from "./atoms";
import type { McpIntegrationConfig } from "../sdk/types";

const NONE_TEMPLATE = AuthTemplateSlug.make("none");
const HEADER_TEMPLATE = AuthTemplateSlug.make("header");
const OAUTH_TEMPLATE = AuthTemplateSlug.make("oauth2");

const NO_AUTH_METHOD: AuthMethod = {
  id: "none",
  label: "No authentication",
  kind: "none",
  source: "spec",
  template: NONE_TEMPLATE,
  placements: [],
};

const authMethodFromConfig = (config: McpIntegrationConfig): AuthMethod | null => {
  if (config.transport === "stdio") return null;
  const auth = config.auth;
  if (auth.kind === "none") return NO_AUTH_METHOD;
  if (auth.kind === "oauth2") {
    return {
      id: "oauth2",
      label: "OAuth2",
      kind: "oauth",
      source: "spec",
      template: OAUTH_TEMPLATE,
      placements: [],
      oauth: { discoveryUrl: config.endpoint, supportsDynamicRegistration: true },
    };
  }
  return {
    id: "header",
    label: `API key (${auth.headerName})`,
    kind: "apikey",
    source: "custom",
    template: HEADER_TEMPLATE,
    placements: [
      {
        carrier: "header",
        name: auth.headerName,
        prefix: auth.prefix ?? "",
      },
    ],
  };
};

const headerAuthFromPlacements = (
  placements: readonly Placement[],
): { readonly headerName: string; readonly prefix?: string } | null => {
  const header = placements.find(
    (placement: Placement) => placement.carrier === "header" && placement.name.trim().length > 0,
  );
  if (!header) return null;
  return {
    headerName: header.name.trim(),
    ...(header.prefix ? { prefix: header.prefix } : {}),
  };
};

export default function McpAccountsPanel(props: {
  readonly sourceId: string;
  readonly integrationName: string;
  readonly accountHandoff?: IntegrationAccountHandoff | null;
}) {
  const { sourceId, integrationName, accountHandoff } = props;
  const slug = IntegrationSlug.make(sourceId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const doConfigure = useAtomSet(configureMcpServer, { mode: "promiseExit" });

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  const config = server?.config ?? null;
  const method = config ? authMethodFromConfig(config) : null;
  const methods = method ? [method] : [];

  const createCustomMethod = useCallback<CreateCustomMethod>(
    async (input: { readonly label: string; readonly placements: readonly Placement[] }) => {
      if (config === null || config.transport !== "remote") return null;
      const header = headerAuthFromPlacements(input.placements);
      if (header === null) return null;
      const nextConfig: McpIntegrationConfig = {
        ...config,
        auth: { kind: "header", ...header },
      };
      const exit = await doConfigure({
        params: { slug },
        payload: { config: nextConfig },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) return null;
      return authMethodFromConfig(exit.value.config);
    },
    [config, doConfigure, slug],
  );

  const removeCustomMethod = useCallback(
    async (methodToRemove: AuthMethod): Promise<boolean> => {
      if (
        config === null ||
        config.transport !== "remote" ||
        methodToRemove.template !== HEADER_TEMPLATE
      ) {
        return false;
      }
      const nextConfig: McpIntegrationConfig = {
        ...config,
        auth: { kind: "none" },
      };
      const exit = await doConfigure({
        params: { slug },
        payload: { config: nextConfig },
        reactivityKeys: integrationWriteKeys,
      });
      return Exit.isSuccess(exit);
    },
    [config, doConfigure, slug],
  );

  const canConfigureAuth = useMemo(
    () => config !== null && config.transport === "remote",
    [config],
  );

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
