import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { EditSheetApplyResult, EditSheetSectionProps } from "@executor-js/sdk/client";
import { apiKeyMethodLabel, type AuthPlacement } from "@executor-js/sdk/http-auth";
import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  AuthMethodListEditor,
  useAuthMethodList,
  type AuthMethodRow,
  type AuthMethodSeed,
} from "@executor-js/react/components/auth-method-list-editor";
import { Badge } from "@executor-js/react/components/badge";
import { Label } from "@executor-js/react/components/label";
import { Switch } from "@executor-js/react/components/switch";
import { useEnterpriseIdentityProviderDescriptor } from "@executor-js/react/components/enterprise-idp-section";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";

import { configureMcpAuth, mcpServerAtom } from "./atoms";
import type {
  McpAuthMethod,
  McpCanonicalAuthMethodInput,
  McpEnterpriseIdentityProvider,
  McpIntegrationConfig,
} from "../sdk/types";
import {
  editorValueFromMcpAuthMethod,
  mcpAuthMethodInputFromEditorValue,
  mcpOAuthMethodInput,
  mcpWireAuthInput,
  sameEnterpriseIdentityProvider,
} from "./auth-method-config";

type McpServer = {
  readonly slug: IntegrationSlug;
  readonly description: string;
  readonly kind: string;
  readonly canRemove: boolean;
  readonly canRefresh: boolean;
  readonly config: McpIntegrationConfig;
};

type McpRemoteConfig = Extract<McpIntegrationConfig, { transport: "remote" }>;

const methodSeedLabel = (method: McpAuthMethod): string => {
  if (method.kind === "oauth2") return "OAuth";
  if (method.kind === "apikey") return apiKeyMethodLabel(method);
  return "No authentication";
};

const samePlacements = (
  a: readonly AuthPlacement[] | undefined,
  b: readonly AuthPlacement[] | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((placement: AuthPlacement, index: number) => {
    const other = right[index];
    return (
      other !== undefined &&
      placement.carrier === other.carrier &&
      placement.name === other.name &&
      (placement.prefix ?? "") === (other.prefix ?? "") &&
      (placement.variable ?? "") === (other.variable ?? "") &&
      (placement.literal ?? null) === (other.literal ?? null)
    );
  });
};

// ---------------------------------------------------------------------------
// Remote edit — v2: the integration's endpoint is part of its identity
// (opaque-to-core config); the editable surface is the declared auth-method
// LIST, through the same shared editor as the add flow. Accounts (credentials)
// are managed from the integration page's accounts hub. Rendered inside the
// integration Edit sheet (plugin `editSheet` slot).
// ---------------------------------------------------------------------------

function RemoteEdit(props: {
  server: McpServer & { config: McpRemoteConfig };
  onPendingChange?: EditSheetSectionProps["onPendingChange"];
}) {
  const { server } = props;
  const doConfigureAuth = useAtomSet(configureMcpAuth, { mode: "promiseExit" });

  const seeds = useMemo<readonly AuthMethodSeed[]>(
    () =>
      server.config.authenticationTemplate.map(
        (method: McpAuthMethod): AuthMethodSeed => ({
          value: editorValueFromMcpAuthMethod(method),
          slug: method.slug,
          label: methodSeedLabel(method),
        }),
      ),
    [server.config.authenticationTemplate],
  );
  const list = useAuthMethodList(seeds);

  const [error, setError] = useState<string | null>(null);

  // Whether this server is declared enterprise-managed, and by which
  // registration. Read off the stored oauth2 method rather than kept as a
  // parallel flag: the declaration IS the state, and the toggle below only
  // decides whether the organization's registration is attached to it.
  const declaredProvider = useMemo<McpEnterpriseIdentityProvider | undefined>(() => {
    for (const method of server.config.authenticationTemplate) {
      if (method.kind === "oauth2" && method.enterpriseIdentityProvider !== undefined) {
        return method.enterpriseIdentityProvider;
      }
    }
    return undefined;
  }, [server.config.authenticationTemplate]);

  const organizationProvider = useEnterpriseIdentityProviderDescriptor() ?? undefined;
  const [managed, setManaged] = useState(declaredProvider !== undefined);
  // The declaration this save would write: the organization's registration
  // while the toggle is on, and — when the organization has since removed its
  // registration — whatever the server already names, so an unrelated edit
  // cannot quietly un-manage a live server.
  const nextProvider: McpEnterpriseIdentityProvider | undefined = managed
    ? (organizationProvider ?? declaredProvider)
    : undefined;

  // The edited methods, slugs preserved for seeded rows so existing
  // connections (bound by template slug) stay attached. New rows omit the
  // slug — the backend assigns kind-based ones. Each row is reconciled against
  // the method it was seeded from, because `configureMcpAuth` runs in `replace`
  // mode here: anything the credential editor cannot express — the
  // enterprise-managed declaration above all — has to be carried forward
  // deliberately or it is erased by an unrelated edit.
  const editedMethods = useMemo<readonly McpCanonicalAuthMethodInput[]>(
    () =>
      list.rows.map((row: AuthMethodRow): McpCanonicalAuthMethodInput => {
        const edited = mcpAuthMethodInputFromEditorValue(row.value);
        const declared = edited.kind === "oauth2" ? mcpOAuthMethodInput(nextProvider) : edited;
        return row.seedSlug !== undefined ? { ...declared, slug: row.seedSlug } : declared;
      }),
    [list.rows, nextProvider],
  );

  const methodsChanged = useMemo(() => {
    const stored = server.config.authenticationTemplate;
    if (editedMethods.length !== stored.length) return true;
    return editedMethods.some((method: McpCanonicalAuthMethodInput, index: number) => {
      const current = stored[index];
      if (!current) return true;
      if ((method.slug ?? "") !== current.slug) return true;
      if (method.kind !== current.kind) return true;
      if (method.kind === "apikey" && current.kind === "apikey") {
        return !samePlacements(method.placements, current.placements);
      }
      if (method.kind === "oauth2" && current.kind === "oauth2") {
        return !sameEnterpriseIdentityProvider(
          method.enterpriseIdentityProvider,
          current.enterpriseIdentityProvider,
        );
      }
      return false;
    });
  }, [editedMethods, server.config.authenticationTemplate]);

  const hasOAuthMethod = server.config.authenticationTemplate.some(
    (method: McpAuthMethod) => method.kind === "oauth2",
  );
  // Offered only where it can mean something: this server authenticates with
  // OAuth, and either the organization has registered an identity provider or
  // this server is already managed by one (so it can still be turned off).
  const canDeclareManaged =
    hasOAuthMethod && (organizationProvider !== undefined || declaredProvider !== undefined);

  // Staged apply, run by the sheet's Save when the method list changed.
  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    setError(null);
    const exit = await doConfigureAuth({
      params: { slug: server.slug },
      payload: {
        authenticationTemplate:
          editedMethods.length > 0
            ? editedMethods.map(mcpWireAuthInput)
            : [{ kind: "none" as const }],
        mode: "replace",
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to update authentication methods");
      return { ok: false };
    }
    return { ok: true, summary: "Authentication methods updated." };
  }, [doConfigureAuth, editedMethods, server.slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  useEffect(() => {
    onPendingChangeRef.current?.(methodsChanged ? applyStaged : null);
    return () => onPendingChangeRef.current?.(null);
  }, [methodsChanged, applyStaged]);

  return (
    <div className="space-y-4 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Authentication methods</p>
        <p className="text-xs text-muted-foreground">
          Changes apply when you save. The endpoint (
          <span className="font-mono">{server.config.endpoint}</span>) is part of the server's
          identity — remove and re-add to change it.
        </p>
      </div>

      <AuthMethodListEditor
        list={list}
        oauthMetadata="discovered"
        emptyHint="No methods declared. Add one, or save to mark this server as open (no authentication)."
        footerHint="Connections pick one of these methods. Removing a method detaches connections created against it."
      />

      {/* Enterprise-Managed Authorization, per server. The organization's
          identity provider is registered once (Organization settings); this is
          where an administrator says WHICH servers authorize through it.
          Declaring it can never take an ordinary server off the interactive
          flow — the connect path still requires the server to advertise the
          grant profile — so the copy promises a route, not an outcome. */}
      {canDeclareManaged ? (
        <div className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-3">
          <Switch
            id="ema-managed-server"
            checked={managed}
            onCheckedChange={setManaged}
            className="mt-0.5"
          />
          <div className="min-w-0 space-y-1">
            <Label htmlFor="ema-managed-server" className="text-sm font-medium text-foreground">
              Managed by your organization
            </Label>
            <p className="text-xs text-muted-foreground">
              Members connect with their work identity instead of consenting to this server. Your
              identity provider decides who gets access, and revokes it.
            </p>
            {organizationProvider === undefined ? (
              <p className="text-xs text-muted-foreground">
                Your organization no longer has an identity provider registered. This server keeps
                the one it already names until you turn this off.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {error && <FormErrorAlert message={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stdio read-only view
// ---------------------------------------------------------------------------

function StdioReadOnly(props: {
  server: McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> };
}) {
  const { command, args } = props.server.config;
  return (
    <div className="space-y-3 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Server command</p>
        <p className="text-xs text-muted-foreground">
          Stdio MCP integrations cannot be edited. Remove and recreate the integration with the
          updated command.
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {command} {(args ?? []).join(" ")}
        </p>
        <Badge variant="secondary" className="text-xs">
          stdio
        </Badge>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — the mcp plugin's section of the integration Edit sheet.
// `integrationId` is the integration slug (v2).
// ---------------------------------------------------------------------------

export default function EditMcpIntegration({
  integrationId,
  onPendingChange,
}: EditSheetSectionProps) {
  const slug = IntegrationSlug.make(integrationId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;

  if (!AsyncResult.isSuccess(serverResult) || server === null) return null;

  if (server.config.transport === "stdio") {
    return (
      <StdioReadOnly
        server={
          server as McpServer & { config: Extract<McpIntegrationConfig, { transport: "stdio" }> }
        }
      />
    );
  }

  return (
    <RemoteEdit
      server={server as McpServer & { config: McpRemoteConfig }}
      {...(onPendingChange ? { onPendingChange } : {})}
    />
  );
}
