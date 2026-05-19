import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import {
  connectionsAtom,
  configureSource,
  setSourceCredentialBinding,
  sourceAtom,
  startOAuth,
} from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { HelpTooltip } from "@executor-js/react/components/help-tooltip";
import { Input } from "@executor-js/react/components/input";
import { sourceWriteKeys as openApiWriteKeys } from "@executor-js/react/api/reactivity-keys";
import {
  ConnectionId,
  CredentialBindingRef,
  ScopeId,
  SetSourceCredentialBindingInput,
} from "@executor-js/sdk/shared";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  oauthCallbackUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  CredentialControlField,
  CredentialScopeDropdown,
  CredentialUsageRow,
} from "@executor-js/react/plugins/credential-target-scope";
import {
  effectiveCredentialBindingForScope,
  exactCredentialBindingForScope,
  isConnectionCredentialBindingValue,
  isSecretCredentialBindingValue,
} from "@executor-js/react/plugins/credential-bindings";
import { SecretCredentialSlotBindings } from "@executor-js/react/plugins/credential-slot-bindings";
import {
  useSourceCredentialBindingScopes,
  useSourceCredentialBindingWriter,
} from "@executor-js/react/plugins/source-credential-bindings";
import { CreatableSecretPicker } from "@executor-js/react/plugins/secret-header-auth";

import { openApiSourceAtom, openApiSourceBindingsAtom } from "./atoms";
import { OpenApiSourceDetailsFields } from "./OpenApiSourceDetailsFields";
import {
  OPENAPI_OAUTH_CALLBACK_PATH,
  OPENAPI_OAUTH_POPUP_NAME,
  inferOAuthIssuerUrl,
  resolveOAuthUrl,
} from "./AddOpenApiSource";
import { oauth2ClientSecretSlot } from "../sdk/source-contracts";
import { OAuth2SourceConfig } from "../sdk/types";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

type SlotDef =
  | {
      readonly kind: "secret";
      readonly slot: string;
      readonly label: string;
      readonly hint?: string;
    }
  | {
      readonly kind: "oauth2";
      readonly slot: string;
      readonly label: string;
    };

type OpenApiCredentialBindingRow = CredentialBindingRef;

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const shortHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
};

const openApiOAuthConnectionId = (
  sourceId: string,
  securitySchemeName: string,
  targetScope: ScopeId,
): ConnectionId =>
  ConnectionId.make(
    `openapi-oauth-${slugify(sourceId)}-${slugify(securitySchemeName)}-${shortHash(targetScope)}`,
  );

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

export default function EditOpenApiSource(props: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const displayScope = useScope();
  const userScope = useUserScope();
  const sourceSummaryResult = useAtomValue(sourceAtom(props.sourceId, displayScope));
  const sourceSummary =
    AsyncResult.isSuccess(sourceSummaryResult) && sourceSummaryResult.value
      ? sourceSummaryResult.value
      : null;
  const sourceScopeId = sourceSummary?.scopeId ?? displayScope;
  const sourceScope = ScopeId.make(sourceScopeId);
  const {
    credentialScopes,
    credentialScopeOptions,
    organizationCredentialScope,
    secretBindingScopes,
    scopeRanks,
  } = useSourceCredentialBindingScopes({ sourceScope });

  const sourceResult = useAtomValue(openApiSourceAtom(sourceScope, props.sourceId));
  const bindingsResult = useAtomValue(
    openApiSourceBindingsAtom(displayScope, props.sourceId, sourceScope),
  );
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));
  const secretList = useSecretPickerSecrets();

  const doConfigure = useAtomSet(configureSource, { mode: "promiseExit" });
  const doSetBinding = useAtomSet(setSourceCredentialBinding, {
    mode: "promiseExit",
  });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const oauth = useOAuthPopupFlow<OAuthCompletionPayload>({
    popupName: OPENAPI_OAUTH_POPUP_NAME,
    popupBlockedMessage: "OAuth popup was blocked by the browser",
    startErrorMessage: "Failed to connect OAuth",
  });

  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const bindingRows: readonly OpenApiCredentialBindingRow[] = AsyncResult.isSuccess(bindingsResult)
    ? bindingsResult.value
    : [];
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const oauth2RedirectUrl = oauthCallbackUrl(OPENAPI_OAUTH_CALLBACK_PATH);

  const [name, setName] = useState(source?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(source?.config.baseUrl ?? "");
  const [sourceSaveState, setSourceSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const sourceBindingWriter = useSourceCredentialBindingWriter({
    displayScope,
    source: { id: props.sourceId, scope: sourceScope },
    onError: setError,
    errorMessageFromExit,
  });
  const [pendingOAuthConnection, setPendingOAuthConnection] = useState<{
    readonly scopeId: ScopeId;
    readonly slot: string;
    readonly connectionId: string;
  } | null>(null);
  const [loadedSourceKey, setLoadedSourceKey] = useState<string | null>(null);
  const [selectedOAuthTokenScope, setSelectedOAuthTokenScope] = useState<string>(
    userScope !== sourceScopeId ? userScope : sourceScopeId,
  );
  const [selectedOAuthClientIdScope, setSelectedOAuthClientIdScope] =
    useState<string>(sourceScopeId);
  const [selectedOAuthClientSecretScope, setSelectedOAuthClientSecretScope] =
    useState<string>(sourceScopeId);
  const [oauthEndpointsOpen, setOAuthEndpointsOpen] = useState(false);
  const [oauth2AuthorizationUrl, setOAuth2AuthorizationUrl] = useState(
    source?.config.oauth2?.authorizationUrl ?? "",
  );
  const [oauth2TokenUrl, setOAuth2TokenUrl] = useState(source?.config.oauth2?.tokenUrl ?? "");
  const [oauth2EndpointsSaveState, setOAuth2EndpointsSaveState] = useState<
    "idle" | "saving" | "saved"
  >("idle");
  const editIdentity = useMemo(
    () => ({
      name,
      namespace: props.sourceId,
      setName,
      setNamespace: () => {},
      reset: () => {},
    }),
    [name, props.sourceId],
  );
  const sourceSaveSeq = useRef(0);
  const oauth2EndpointsSaveSeq = useRef(0);

  useEffect(() => {
    setSelectedOAuthTokenScope(userScope !== sourceScopeId ? userScope : sourceScopeId);
    setSelectedOAuthClientIdScope(sourceScopeId);
    setSelectedOAuthClientSecretScope(sourceScopeId);
  }, [sourceScopeId, userScope]);

  useEffect(() => {
    if (!source) return;
    const sourceKey = `${sourceScopeId}:${source.namespace}`;
    if (loadedSourceKey === sourceKey) return;
    setName(source.name);
    setBaseUrl(source.config.baseUrl ?? "");
    setOAuth2AuthorizationUrl(source.config.oauth2?.authorizationUrl ?? "");
    setOAuth2TokenUrl(source.config.oauth2?.tokenUrl ?? "");
    setOAuth2EndpointsSaveState("idle");
    setOAuthEndpointsOpen(false);
    setSourceSaveState("idle");
    setLoadedSourceKey(sourceKey);
  }, [loadedSourceKey, source, sourceScopeId]);

  useEffect(() => {
    if (!source) return;
    const sourceKey = `${sourceScopeId}:${source.namespace}`;
    if (loadedSourceKey !== sourceKey) return;

    const nextName = name.trim();
    const nextBaseUrl = baseUrl.trim();
    const currentName = source.name;
    const currentBaseUrl = source.config.baseUrl ?? "";
    if ((nextName || currentName) === currentName && nextBaseUrl === currentBaseUrl) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const seq = ++sourceSaveSeq.current;
      setSourceSaveState("saving");
      setError(null);
      void (async () => {
        const exit = await doConfigure({
          params: { scopeId: displayScope },
          payload: {
            source: { id: props.sourceId, scope: sourceScope },
            scope: sourceScope,
            type: "openapi",
            config: {
              scope: sourceScope,
              name: nextName || undefined,
              baseUrl: nextBaseUrl || undefined,
            },
          },
          reactivityKeys: openApiWriteKeys,
        });
        if (sourceSaveSeq.current !== seq) return;
        if (Exit.isFailure(exit)) {
          setSourceSaveState("idle");
          setError(errorMessageFromExit(exit, "Failed to save source details"));
          return;
        }
        setSourceSaveState("saved");
        window.setTimeout(() => {
          if (sourceSaveSeq.current === seq) setSourceSaveState("idle");
        }, 1600);
      })();
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [
    baseUrl,
    displayScope,
    doConfigure,
    loadedSourceKey,
    name,
    props.sourceId,
    source,
    sourceScope,
    sourceScopeId,
  ]);

  const secretSlots = useMemo(() => {
    if (!source) return [] as SlotDef[];
    const slots: SlotDef[] = [];
    for (const [headerName, value] of Object.entries(source.config.headers ?? {})) {
      if (typeof value === "string") continue;
      slots.push({
        kind: "secret",
        slot: value.slot,
        label: headerName,
        hint: value.prefix ? `Prefix: ${value.prefix}` : undefined,
      });
    }
    if (source.config.oauth2) {
      const clientSecretSlot = effectiveClientSecretSlot(source.config.oauth2);
      slots.push({
        kind: "secret",
        slot: source.config.oauth2.clientIdSlot,
        label: "Client ID",
      });
      slots.push({
        kind: "secret",
        slot: clientSecretSlot,
        label: "Client Secret",
        hint:
          source.config.oauth2.flow === "authorizationCode"
            ? "Optional for public PKCE clients"
            : undefined,
      });
      slots.push({
        kind: "oauth2",
        slot: source.config.oauth2.connectionSlot,
        label:
          source.config.oauth2.flow === "clientCredentials"
            ? "OAuth Client Credentials"
            : "OAuth Authorization Code",
      });
    }
    return slots;
  }, [source]);

  const activeOAuthTokenScope =
    credentialScopes.find((entry) => entry.scopeId === selectedOAuthTokenScope) ??
    credentialScopes[0]!;
  const activeOAuthTokenScopeId = activeOAuthTokenScope.scopeId;
  const activeOAuthTokenScopeLabel = activeOAuthTokenScope.label;

  if (!source) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }
  const oauthClientSecretSlot = source.config.oauth2
    ? effectiveClientSecretSlot(source.config.oauth2)
    : null;
  const nonOAuthSecretSlots = secretSlots.filter(
    (slot) =>
      slot.kind === "secret" &&
      (!source.config.oauth2 ||
        (slot.slot !== source.config.oauth2.clientIdSlot && slot.slot !== oauthClientSecretSlot)),
  );

  const connectOAuth = async (targetScope: ScopeId) => {
    const oauth2 = source.config.oauth2;
    if (!oauth2) return;
    const clientIdBinding = effectiveCredentialBindingForScope(
      bindingRows,
      oauth2.clientIdSlot,
      targetScope,
      scopeRanks,
    );
    const clientSecretSlot = effectiveClientSecretSlot(oauth2);
    const clientSecretBinding = effectiveCredentialBindingForScope(
      bindingRows,
      clientSecretSlot,
      targetScope,
      scopeRanks,
    );
    if (!clientIdBinding || !isSecretCredentialBindingValue(clientIdBinding.value)) {
      setError("Client ID must be bound before connecting");
      return;
    }
    const clientIdSecretId = clientIdBinding.value.secretId;
    const clientIdSecretScopeId = clientIdBinding.value.secretScopeId ?? clientIdBinding.scopeId;
    if (
      oauth2.flow === "clientCredentials" &&
      (!clientSecretBinding || !isSecretCredentialBindingValue(clientSecretBinding.value))
    ) {
      setError("Client secret must be bound before connecting");
      return;
    }
    const clientSecretValue =
      oauth2.flow === "clientCredentials" &&
      clientSecretBinding &&
      isSecretCredentialBindingValue(clientSecretBinding.value)
        ? clientSecretBinding.value
        : null;
    const clientSecretSecretScopeId =
      clientSecretBinding && isSecretCredentialBindingValue(clientSecretBinding.value)
        ? (clientSecretBinding.value.secretScopeId ?? clientSecretBinding.scopeId)
        : null;

    const existingConnection = exactCredentialBindingForScope(
      bindingRows,
      oauth2.connectionSlot,
      targetScope,
    );
    const connectionId =
      existingConnection && isConnectionCredentialBindingValue(existingConnection.value)
        ? existingConnection.value.connectionId
        : openApiOAuthConnectionId(props.sourceId, oauth2.securitySchemeName, targetScope);

    setBusyKey(`${targetScope}:${oauth2.connectionSlot}:connect`);
    setPendingOAuthConnection({
      scopeId: targetScope,
      slot: oauth2.connectionSlot,
      connectionId: connectionId,
    });
    setError(null);
    const failConnect = (message: string) => {
      setError(message);
      setPendingOAuthConnection(null);
      setBusyKey(null);
    };
    const displayName = source.name;
    const tokenUrl = resolveOAuthUrl(oauth2.tokenUrl, source.config.baseUrl ?? "");
    if (oauth2.flow === "clientCredentials") {
      const startOAuthExit = await doStartOAuth({
        params: { scopeId: targetScope },
        payload: {
          endpoint: tokenUrl,
          redirectUrl: tokenUrl,
          connectionId: connectionId,
          tokenScope: targetScope,
          strategy: {
            kind: "client-credentials",
            tokenEndpoint: tokenUrl,
            clientIdSecretId,
            clientIdSecretScopeId: String(clientIdSecretScopeId),
            clientSecretSecretId: clientSecretValue!.secretId,
            clientSecretSecretScopeId: clientSecretSecretScopeId
              ? String(clientSecretSecretScopeId)
              : null,
            scopes: [...oauth2.scopes],
          },
          pluginId: "openapi",
          identityLabel: `${displayName} OAuth`,
        },
      });
      if (Exit.isFailure(startOAuthExit)) {
        failConnect(errorMessageFromExit(startOAuthExit, "Failed to connect OAuth"));
        return;
      }
      const response = startOAuthExit.value;
      if (!response.completedConnection) {
        failConnect("Unexpected OAuth response");
        return;
      }
      const setBindingExit = await doSetBinding({
        params: { scopeId: displayScope },
        payload: SetSourceCredentialBindingInput.make({
          source: { id: props.sourceId, scope: sourceScope },
          scope: targetScope,
          slotKey: oauth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(response.completedConnection.connectionId),
          },
        }),
        reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
      });
      if (Exit.isFailure(setBindingExit)) {
        failConnect(errorMessageFromExit(setBindingExit, "Failed to connect OAuth"));
        return;
      }
      setPendingOAuthConnection(null);
      setBusyKey(null);
      return;
    }

    const authorizationUrl = resolveOAuthUrl(
      oauth2.authorizationUrl ?? "",
      source.config.baseUrl ?? "",
    );
    const issuerUrl = oauth2.issuerUrl ?? inferOAuthIssuerUrl(authorizationUrl);
    const startOAuthExit = await doStartOAuth({
      params: { scopeId: targetScope },
      payload: {
        endpoint: authorizationUrl,
        connectionId,
        tokenScope: targetScope,
        redirectUrl: oauth2RedirectUrl,
        strategy: {
          kind: "authorization-code",
          authorizationEndpoint: authorizationUrl,
          tokenEndpoint: tokenUrl,
          issuerUrl,
          clientIdSecretId,
          clientIdSecretScopeId: String(clientIdSecretScopeId),
          clientSecretSecretId:
            clientSecretBinding && isSecretCredentialBindingValue(clientSecretBinding.value)
              ? clientSecretBinding.value.secretId
              : null,
          clientSecretSecretScopeId: clientSecretSecretScopeId
            ? String(clientSecretSecretScopeId)
            : null,
          scopes: [...oauth2.scopes],
        },
        pluginId: "openapi",
        identityLabel: `${displayName} OAuth`,
      },
    });
    if (Exit.isFailure(startOAuthExit)) {
      failConnect(errorMessageFromExit(startOAuthExit, "Failed to connect OAuth"));
      return;
    }
    const response = startOAuthExit.value;
    if (response.authorizationUrl === null) {
      failConnect("Unexpected OAuth response");
      return;
    }

    await oauth.openAuthorization({
      tokenScope: targetScope,
      run: async () => ({
        sessionId: response.sessionId,
        authorizationUrl: response.authorizationUrl,
      }),
      onSuccess: async (result) => {
        const setBindingExit = await doSetBinding({
          params: { scopeId: displayScope },
          payload: SetSourceCredentialBindingInput.make({
            source: { id: props.sourceId, scope: sourceScope },
            scope: targetScope,
            slotKey: oauth2.connectionSlot,
            value: {
              kind: "connection",
              connectionId: ConnectionId.make(result.connectionId),
            },
          }),
          reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
        });
        if (Exit.isFailure(setBindingExit)) {
          failConnect(errorMessageFromExit(setBindingExit, "Failed to connect OAuth"));
          return;
        }
        setPendingOAuthConnection(null);
        setBusyKey(null);
      },
      onError: (message) => {
        setError(message);
        setPendingOAuthConnection(null);
        setBusyKey(null);
      },
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">OpenAPI Source</h1>
      </div>

      <OpenApiSourceDetailsFields
        title="Source Details"
        description="Name and base URL save automatically."
        identity={editIdentity}
        baseUrl={baseUrl}
        onBaseUrlChange={setBaseUrl}
        specUrl={source.config.sourceUrl ?? ""}
        onSpecUrlChange={() => {}}
        specUrlDisabled
        namespaceReadOnly
        saveState={sourceSaveState}
        footer={
          source.config.oauth2
            ? `Authentication Template: OAuth2 ${source.config.oauth2.flow}`
            : Object.keys(source.config.headers ?? {}).length > 0
              ? `Authentication Template: ${Object.keys(source.config.headers ?? {}).length} header binding${
                  Object.keys(source.config.headers ?? {}).length === 1 ? "" : "s"
                }`
              : "Authentication Template: None"
        }
      />

      <CardStack>
        <CardStackContent className="border-t-0">
          {nonOAuthSecretSlots.length > 0 && (
            <>
              <CardStackEntry>
                <CardStackEntryContent>
                  <CardStackEntryTitle>Request credentials</CardStackEntryTitle>
                  <CardStackEntryDescription>
                    Headers and query parameters sent with every API request.
                  </CardStackEntryDescription>
                </CardStackEntryContent>
              </CardStackEntry>

              <SecretCredentialSlotBindings
                slots={nonOAuthSecretSlots}
                bindingScopes={secretBindingScopes}
                bindingRows={bindingRows}
                scopeRanks={scopeRanks}
                secrets={secretList}
                sourceId={props.sourceId}
                sourceName={source.name}
                credentialScopeOptions={credentialScopeOptions}
                busyKey={sourceBindingWriter.busyKey}
                onSetSecretBinding={sourceBindingWriter.setSecretBinding}
                onClearBinding={sourceBindingWriter.clearBinding}
              />
            </>
          )}

          {source.config.oauth2 &&
            (() => {
              const oauth2 = source.config.oauth2;
              const trimmedAuthUrl = oauth2AuthorizationUrl.trim();
              const trimmedTokenUrl = oauth2TokenUrl.trim();
              const savedAuthUrl = oauth2.authorizationUrl ?? "";
              const isAuthCode = oauth2.flow === "authorizationCode";
              const endpointsDirty =
                (isAuthCode && trimmedAuthUrl !== savedAuthUrl) ||
                trimmedTokenUrl !== oauth2.tokenUrl;
              const saving = oauth2EndpointsSaveState === "saving";
              const tokenUrlMissing = trimmedTokenUrl.length === 0;
              const authUrlMissing = isAuthCode && trimmedAuthUrl.length === 0;
              const canSave = endpointsDirty && !saving && !tokenUrlMissing && !authUrlMissing;

              const saveOAuth2Endpoints = async () => {
                const seq = ++oauth2EndpointsSaveSeq.current;
                setOAuth2EndpointsSaveState("saving");
                setError(null);
                const exit = await doConfigure({
                  params: { scopeId: displayScope },
                  payload: {
                    source: { id: props.sourceId, scope: sourceScope },
                    scope: sourceScope,
                    type: "openapi",
                    config: {
                      scope: sourceScope,
                      oauth2Source: OAuth2SourceConfig.make({
                        kind: "oauth2",
                        securitySchemeName: oauth2.securitySchemeName,
                        flow: oauth2.flow,
                        tokenUrl: trimmedTokenUrl,
                        authorizationUrl: isAuthCode ? trimmedAuthUrl || null : null,
                        issuerUrl: oauth2.issuerUrl ?? null,
                        clientIdSlot: oauth2.clientIdSlot,
                        clientSecretSlot: oauth2.clientSecretSlot,
                        connectionSlot: oauth2.connectionSlot,
                        scopes: [...oauth2.scopes],
                      }),
                    },
                  },
                  reactivityKeys: openApiWriteKeys,
                });
                if (oauth2EndpointsSaveSeq.current !== seq) return;
                if (Exit.isFailure(exit)) {
                  setOAuth2EndpointsSaveState("idle");
                  setError(errorMessageFromExit(exit, "Failed to save OAuth endpoints"));
                  return;
                }
                setOAuth2EndpointsSaveState("saved");
                window.setTimeout(() => {
                  if (oauth2EndpointsSaveSeq.current === seq) {
                    setOAuth2EndpointsSaveState("idle");
                  }
                }, 1600);
              };

              const exact = exactCredentialBindingForScope(
                bindingRows,
                oauth2.connectionSlot,
                activeOAuthTokenScopeId,
              );
              const binding =
                exact ??
                effectiveCredentialBindingForScope(
                  bindingRows,
                  oauth2.connectionSlot,
                  activeOAuthTokenScopeId,
                  scopeRanks,
                );
              const connectionBinding =
                binding && isConnectionCredentialBindingValue(binding.value) ? binding.value : null;
              const connection = connectionBinding
                ? connections.find((entry) => entry.id === connectionBinding.connectionId)
                : null;
              const bindingScopeId = connectionBinding && binding ? binding.scopeId : null;
              const isConnecting =
                busyKey === `${activeOAuthTokenScopeId}:${oauth2.connectionSlot}:connect`;
              const isPendingOAuthConnection =
                pendingOAuthConnection?.scopeId === activeOAuthTokenScopeId &&
                pendingOAuthConnection !== null &&
                pendingOAuthConnection.slot === oauth2.connectionSlot;
              const isConnected = connection !== null && connection !== undefined;
              const statusText =
                isConnecting || isPendingOAuthConnection
                  ? "Saving OAuth connection..."
                  : connectionBinding && bindingScopeId
                    ? connection
                      ? bindingScopeId === activeOAuthTokenScopeId
                        ? `Connected in ${activeOAuthTokenScopeLabel.toLowerCase()} as ${
                            connection.identityLabel ?? connection.id
                          }`
                        : `Using organization connection ${
                            connection.identityLabel ?? connection.id
                          }`
                      : bindingScopeId === activeOAuthTokenScopeId
                        ? `Saved connection is missing in ${activeOAuthTokenScopeLabel.toLowerCase()}`
                        : "Organization connection is missing"
                    : `No ${activeOAuthTokenScopeLabel.toLowerCase()} connection`;
              const connectDisabled = isConnecting || endpointsDirty || saving;
              const clientSecretSlot = effectiveClientSecretSlot(oauth2);
              const renderAppSecret = (input: {
                readonly slot: string;
                readonly label: string;
                readonly hint?: string;
                readonly scopeId: ScopeId;
                readonly onScopeChange: (scope: ScopeId) => void;
              }) => {
                const activeScope =
                  credentialScopes.find((entry) => entry.scopeId === input.scopeId) ??
                  organizationCredentialScope;
                const exactSecret = exactCredentialBindingForScope(
                  bindingRows,
                  input.slot,
                  activeScope.scopeId,
                );
                const effectiveSecret = effectiveCredentialBindingForScope(
                  bindingRows,
                  input.slot,
                  activeScope.scopeId,
                  scopeRanks,
                );
                const exactSecretId =
                  exactSecret && isSecretCredentialBindingValue(exactSecret.value)
                    ? exactSecret.value.secretId
                    : null;
                const inheritedSecret =
                  !exactSecretId &&
                  effectiveSecret &&
                  effectiveSecret.scopeId !== activeScope.scopeId &&
                  isSecretCredentialBindingValue(effectiveSecret.value)
                    ? effectiveSecret
                    : null;
                const status = exactSecretId
                  ? `${activeScope.label} credential set`
                  : inheritedSecret
                    ? "Using organization credential"
                    : "Not set";
                const inputKey = `${activeScope.scopeId}:${input.slot}`;
                const clearKey = `${activeScope.scopeId}:${input.slot}:clear`;

                return (
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">
                      {input.label}{" "}
                      {input.hint && <span className="text-muted-foreground">· {input.hint}</span>}
                    </FieldLabel>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <FieldLabel className="text-[11px]">Secret</FieldLabel>
                          <HelpTooltip label={`${input.label} secret`}>
                            Select or create the OAuth {input.label.toLowerCase()} secret.
                          </HelpTooltip>
                          <span className="ml-auto truncate text-xs text-muted-foreground">
                            {status}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <CreatableSecretPicker
                              value={exactSecretId}
                              onSelect={(secretId, secretScopeId) =>
                                void sourceBindingWriter.setSecretBinding(
                                  activeScope.scopeId,
                                  input.slot,
                                  secretId,
                                  secretScopeId ?? activeScope.scopeId,
                                )
                              }
                              secrets={secretList}
                              placeholder="Select or create a secret"
                              targetScope={activeScope.scopeId}
                              credentialScopeOptions={credentialScopeOptions}
                              suggestedId={`source-binding-${slugify(props.sourceId)}-${slugify(
                                input.slot,
                              )}-${slugify(activeScope.scopeId)}`}
                              sourceName={source.name}
                              secretLabel={input.label}
                            />
                          </div>
                          {exactSecretId && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void sourceBindingWriter.clearBinding(
                                  activeScope.scopeId,
                                  input.slot,
                                )
                              }
                              disabled={sourceBindingWriter.busyKey === clearKey}
                            >
                              Clear
                            </Button>
                          )}
                          {sourceBindingWriter.busyKey === inputKey && (
                            <span className="text-xs text-muted-foreground">Saving…</span>
                          )}
                        </div>
                      </div>
                      <CredentialScopeDropdown
                        value={activeScope.scopeId}
                        options={credentialScopeOptions}
                        onChange={input.onScopeChange}
                        label="Used by"
                        help={`Choose where this OAuth ${input.label.toLowerCase()} credential lives.`}
                      />
                    </div>
                  </div>
                );
              };

              return (
                <>
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryTitle>OAuth</CardStackEntryTitle>
                      <CardStackEntryDescription>
                        Configure app credentials and connect accounts for this source.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                  </CardStackEntry>
                  <CardStackEntryField label="OAuth app credentials">
                    <div className="space-y-4 rounded-lg border border-border/60 bg-muted/10 p-3">
                      {renderAppSecret({
                        slot: oauth2.clientIdSlot,
                        label: "Client ID",
                        scopeId: ScopeId.make(selectedOAuthClientIdScope),
                        onScopeChange: setSelectedOAuthClientIdScope,
                      })}
                      {renderAppSecret({
                        slot: clientSecretSlot,
                        label: "Client secret",
                        hint:
                          oauth2.flow === "authorizationCode"
                            ? "Optional for public clients with PKCE"
                            : undefined,
                        scopeId: ScopeId.make(selectedOAuthClientSecretScope),
                        onScopeChange: setSelectedOAuthClientSecretScope,
                      })}
                    </div>
                  </CardStackEntryField>
                  <CardStackEntryField label="Account connection">
                    <CredentialUsageRow
                      value={activeOAuthTokenScopeId}
                      options={credentialScopeOptions}
                      onChange={setSelectedOAuthTokenScope}
                      label="Connection saved to"
                      help="Choose where the signed-in OAuth token is saved."
                    >
                      <CredentialControlField
                        label="OAuth connection"
                        help="Start the provider OAuth flow."
                      >
                        <div className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {statusText}
                          </span>
                          <Button
                            size="sm"
                            onClick={() => void connectOAuth(activeOAuthTokenScopeId)}
                            disabled={connectDisabled}
                          >
                            {isConnecting ? "Connecting…" : isConnected ? "Reconnect" : "Connect"}
                          </Button>
                        </div>
                        {endpointsDirty && (
                          <p className="text-xs text-muted-foreground">
                            Save endpoint changes before reconnecting.
                          </p>
                        )}
                      </CredentialControlField>
                    </CredentialUsageRow>
                  </CardStackEntryField>
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryTitle>Advanced endpoints</CardStackEntryTitle>
                      <CardStackEntryDescription>
                        Override provider URLs only when the OpenAPI spec is wrong.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                    <div className="flex items-center gap-2">
                      {oauth2EndpointsSaveState !== "idle" && (
                        <span className="text-xs text-muted-foreground">
                          {saving ? "Saving…" : "Saved"}
                        </span>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setOAuthEndpointsOpen((open) => !open)}
                      >
                        {oauthEndpointsOpen ? "Hide" : endpointsDirty ? "Review" : "Show"}
                      </Button>
                    </div>
                  </CardStackEntry>
                  {oauthEndpointsOpen && (
                    <>
                      {isAuthCode && (
                        <CardStackEntryField label="Authorization URL">
                          <Input
                            value={oauth2AuthorizationUrl}
                            onChange={(e) =>
                              setOAuth2AuthorizationUrl((e.target as HTMLInputElement).value)
                            }
                            className="font-mono text-sm"
                          />
                        </CardStackEntryField>
                      )}
                      <CardStackEntryField label="Token URL">
                        <Input
                          value={oauth2TokenUrl}
                          onChange={(e) => setOAuth2TokenUrl((e.target as HTMLInputElement).value)}
                          className="font-mono text-sm"
                        />
                      </CardStackEntryField>
                      <CardStackEntryField label="Redirect URL">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px]">
                            <span className="truncate flex-1 text-foreground">
                              {oauth2RedirectUrl}
                            </span>
                            <CopyButton value={oauth2RedirectUrl} />
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Add this to your OAuth app&apos;s allowed redirects.
                          </p>
                        </div>
                      </CardStackEntryField>
                      <CardStackEntry>
                        <CardStackEntryContent>
                          <CardStackEntryDescription>
                            Save endpoint changes before reconnecting.
                          </CardStackEntryDescription>
                        </CardStackEntryContent>
                        <Button
                          size="sm"
                          onClick={() => void saveOAuth2Endpoints()}
                          disabled={!canSave}
                        >
                          Save endpoints
                        </Button>
                      </CardStackEntry>
                    </>
                  )}
                </>
              );
            })()}
        </CardStackContent>
      </CardStack>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-start border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Back
        </Button>
      </div>
    </div>
  );
}
