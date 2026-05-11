import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk/core";
import { startOAuth } from "@executor-js/react/api/atoms";
import { useScope, useScopeStack } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";

// `addSpec` with an oauth2 payload persists a source row AND (for
// clientCredentials) a freshly-minted Connection + owned secrets,
// because the inline token exchange happens during `startOAuth`.
// Invalidate both so the source-detail page opens into its connected
// state without a refresh.
const addSpecWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;
const bindingWriteKeys = [...sourceWriteKeys, ...connectionWriteKeys] as const;
import { HeadersList } from "@executor-js/react/plugins/headers-list";
import {
  HttpCredentialsEditor,
  emptyHttpCredentials,
  serializeHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  oauthCallbackUrl,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  CreatableSecretPicker,
  matchPresetKey,
  type HeaderState,
} from "@executor-js/react/plugins/secret-header-auth";
import { CredentialScopeDropdown } from "@executor-js/react/plugins/credential-target-scope";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor-js/react/components/button";
import { CopyButton } from "@executor-js/react/components/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { HelpTooltip } from "@executor-js/react/components/help-tooltip";
import { Label } from "@executor-js/react/components/label";
import { Textarea } from "@executor-js/react/components/textarea";
import { Checkbox } from "@executor-js/react/components/checkbox";
import { RadioGroup, RadioGroupItem } from "@executor-js/react/components/radio-group";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import { addOpenApiSpecOptimistic, previewOpenApiSpec, setOpenApiSourceBinding } from "./atoms";
import { OpenApiSourceDetailsFields } from "./OpenApiSourceDetailsFields";
import type { SpecPreview, HeaderPreset, OAuth2Preset } from "../sdk/preview";
import {
  headerBindingSlot,
  oauth2ClientIdSlot,
  oauth2ClientSecretSlot,
  oauth2ConnectionSlot,
  queryParamBindingSlot,
} from "../sdk/store";
import {
  ConfiguredHeaderBinding,
  OAuth2SourceConfig,
  OpenApiSourceBindingInput,
  type ServerInfo,
} from "../sdk/types";
import { expandServerUrlOptions } from "../sdk/openapi-utils";

export const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";
export const OPENAPI_OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

export const openApiOAuthConnectionId = (
  namespaceSlug: string,
  flow: OAuth2Preset["flow"],
): string =>
  flow === "clientCredentials"
    ? `openapi-oauth2-app-${namespaceSlug || "default"}`
    : `openapi-oauth2-user-${namespaceSlug || "default"}`;

/**
 * OpenAPI 3.x requires OAuth2 tokenUrl/authorizationUrl to be absolute,
 * but some specs ship relative paths like `/api/rest/v1/oauth/token`.
 * Resolve them against the source's chosen baseUrl so the backend can
 * fetch them directly and the absolute URL is what gets persisted on
 * OAuth2SourceConfig.
 */
export function resolveOAuthUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes provider metadata URLs
  try {
    new URL(url);
    return url;
  } catch {
    if (!baseUrl) return url;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor resolves relative provider metadata URLs
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }
}

export function inferOAuthIssuerUrl(authorizationUrl: string): string | null {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: URL constructor normalizes provider metadata URLs
  try {
    return new URL(authorizationUrl).origin;
  } catch {
    return null;
  }
}

type StrategySelection =
  | { readonly kind: "none" }
  | { readonly kind: "custom" }
  | { readonly kind: "header"; readonly presetIndex: number }
  | { readonly kind: "oauth2"; readonly presetIndex: number };

const serializeStrategy = (s: StrategySelection): string =>
  Match.value(s).pipe(
    Match.when({ kind: "none" }, () => "none"),
    Match.when({ kind: "custom" }, () => "custom"),
    Match.when({ kind: "header" }, (sel) => `header:${sel.presetIndex}`),
    Match.when({ kind: "oauth2" }, (sel) => `oauth2:${sel.presetIndex}`),
    Match.exhaustive,
  );

const parseStrategy = (value: string): StrategySelection => {
  if (value === "none") return { kind: "none" };
  if (value === "custom") return { kind: "custom" };
  if (value.startsWith("header:")) {
    return {
      kind: "header",
      presetIndex: Number(value.slice("header:".length)),
    };
  }
  if (value.startsWith("oauth2:")) {
    return {
      kind: "oauth2",
      presetIndex: Number(value.slice("oauth2:".length)),
    };
  }
  return { kind: "none" };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prefixForHeader(preset: HeaderPreset, headerName: string): string | undefined {
  const label = preset.label.toLowerCase();
  if (headerName.toLowerCase() === "authorization") {
    if (label.includes("bearer")) return "Bearer ";
    if (label.includes("basic")) return "Basic ";
  }
  return undefined;
}

function entriesFromSpecPreset(preset: HeaderPreset): HeaderState[] {
  return preset.secretHeaders.map((headerName) => {
    const prefix = prefixForHeader(preset, headerName);
    return {
      name: headerName,
      secretId: null,
      prefix,
      presetKey: matchPresetKey(headerName, prefix),
      fromPreset: true,
    };
  });
}

const secretStorageDescription = (label: string): string =>
  label === "Personal"
    ? "Only you can use this secret."
    : "Everyone in the organization can use this secret.";

// ---------------------------------------------------------------------------
// Main component — single progressive form
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
  initialNamespace?: string;
}) {
  // Spec input
  const [specUrl, setSpecUrl] = useState(props.initialUrl ?? "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // After analysis
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const identity = useSourceIdentity({
    fallbackName: preview ? Option.getOrElse(preview.title, () => "") : "",
    fallbackNamespace: props.initialNamespace,
  });

  // Auth
  const [strategy, setStrategy] = useState<StrategySelection>({ kind: "none" });
  const [customHeaders, setCustomHeaders] = useState<HeaderState[]>([]);
  const [specFetchCredentials, setSpecFetchCredentials] = useState<HttpCredentialsState>(() =>
    emptyHttpCredentials(),
  );
  const [specFetchCredentialsOpen, setSpecFetchCredentialsOpen] = useState(false);
  const [runtimeCredentials, setRuntimeCredentials] = useState<HttpCredentialsState>(() =>
    emptyHttpCredentials(),
  );

  // OAuth2 state (only populated while an oauth2 preset is selected)
  const [oauth2ClientIdSecretId, setOauth2ClientIdSecretId] = useState<string | null>(null);
  const [oauth2ClientSecretSecretId, setOauth2ClientSecretSecretId] = useState<string | null>(null);
  const [oauth2ClientIdScope, setOauth2ClientIdScope] = useState<ScopeId | null>(null);
  const [oauth2ClientSecretScope, setOauth2ClientSecretScope] = useState<ScopeId | null>(null);
  const [oauth2SelectedScopes, setOauth2SelectedScopes] = useState<Set<string>>(new Set());
  const [oauth2AuthState, setOauth2AuthState] = useState<{
    readonly fingerprint: string;
    readonly auth: { readonly connectionId: string };
  } | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const scopeStack = useScopeStack();
  const credentialScopeOptions = useMemo(
    () =>
      scopeStack.map((entry, index) => ({
        scopeId: entry.id,
        label: index === 0 ? "Personal" : entry.name || "Organization",
        description: secretStorageDescription(
          index === 0 ? "Personal" : entry.name || "Organization",
        ),
      })),
    [scopeStack],
  );
  const defaultCredentialTargetScope =
    credentialScopeOptions[credentialScopeOptions.length - 1]?.scopeId ?? scopeId;
  const defaultOAuthTokenTargetScope = credentialScopeOptions[0]?.scopeId ?? scopeId;
  const [credentialTargetScope, setCredentialTargetScope] = useState<ScopeId>(
    defaultCredentialTargetScope,
  );
  const [oauthTokenTargetScope, setOAuthTokenTargetScope] = useState<ScopeId>(
    defaultOAuthTokenTargetScope,
  );
  const bindingScopeOptions = useMemo(
    () => credentialScopeOptions.map((option) => ({ ...option })),
    [credentialScopeOptions],
  );
  useEffect(() => {
    if (!credentialScopeOptions.some((option) => option.scopeId === credentialTargetScope)) {
      setCredentialTargetScope(defaultCredentialTargetScope);
    }
  }, [credentialScopeOptions, credentialTargetScope, defaultCredentialTargetScope]);
  useEffect(() => {
    if (!credentialScopeOptions.some((option) => option.scopeId === oauthTokenTargetScope)) {
      setOAuthTokenTargetScope(defaultOAuthTokenTargetScope);
    }
  }, [credentialScopeOptions, defaultOAuthTokenTargetScope, oauthTokenTargetScope]);
  const initialCredentialScopeOption =
    credentialScopeOptions.find((option) => option.scopeId === credentialTargetScope) ??
    credentialScopeOptions[0];
  const initialCredentialScopeOptions = initialCredentialScopeOption
    ? [initialCredentialScopeOption]
    : [];
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
  const doAdd = useAtomSet(addOpenApiSpecOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doSetBinding = useAtomSet(setOpenApiSourceBinding, {
    mode: "promiseExit",
  });
  const secretList = useSecretPickerSecrets();
  const initialCredentialSecrets = useMemo(
    () => secretList.filter((secret) => secret.scopeId === String(credentialTargetScope)),
    [credentialTargetScope, secretList],
  );
  const oauth = useOAuthPopupFlow<OAuthCompletionPayload>({
    popupName: OPENAPI_OAUTH_POPUP_NAME,
    popupBlockedMessage: "OAuth popup was blocked by the browser",
    popupClosedMessage: "OAuth cancelled - popup was closed before completing the flow.",
    startErrorMessage: "Failed to start OAuth",
  });

  // Keep the latest handleAnalyze in a ref so the debounced effect doesn't
  // need it as a dependency (it closes over fresh state).
  const handleAnalyzeRef = useRef<() => void>(() => {});

  // Auto-analyze whenever the spec input changes, with a short debounce so
  // typing/pasting doesn't fire a request on every keystroke.
  useEffect(() => {
    const trimmed = specUrl.trim();
    if (!trimmed) return;
    if (preview) return;
    const handle = setTimeout(() => {
      handleAnalyzeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [specUrl, preview]);

  // ---- Derived state ----

  const expandServerOptions = (server: ServerInfo) => {
    return expandServerUrlOptions(server).map((value) => ({
      value,
      label: value,
    }));
  };

  const servers: readonly ServerInfo[] = preview?.servers ?? [];
  const baseUrlOptions = Array.from(
    new Map(servers.flatMap(expandServerOptions).map((option) => [option.value, option])).values(),
  );

  const resolvedBaseUrl = baseUrl.trim();

  const configuredHeaders: Record<string, ConfiguredHeaderBinding> = {};
  const headerBindings: Array<{
    slot: string;
    secretId: string;
    scope: ScopeId;
    secretScope: ScopeId;
  }> = [];
  const configuredQueryParams: Record<string, string | ConfiguredHeaderBinding> = {};
  const queryParamBindings: Array<{
    slot: string;
    secretId: string;
    scope: ScopeId;
    secretScope: ScopeId;
  }> = [];
  for (const ch of customHeaders) {
    if (!ch.name.trim()) continue;
    const slot = headerBindingSlot(ch.name.trim());
    configuredHeaders[ch.name.trim()] = new ConfiguredHeaderBinding({
      kind: "binding",
      slot,
      prefix: ch.prefix,
    });
    if (ch.secretId) {
      headerBindings.push({
        slot,
        secretId: ch.secretId,
        scope: ch.targetScope ?? credentialTargetScope,
        secretScope: ch.secretScope ?? ch.targetScope ?? credentialTargetScope,
      });
    }
  }
  for (const param of runtimeCredentials.queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      const slot = queryParamBindingSlot(name);
      configuredQueryParams[name] = new ConfiguredHeaderBinding({
        kind: "binding",
        slot,
        prefix: param.prefix,
      });
      queryParamBindings.push({
        slot,
        secretId: param.secretId,
        scope: param.targetScope ?? credentialTargetScope,
        secretScope: param.secretScope ?? param.targetScope ?? credentialTargetScope,
      });
      continue;
    }
    if (param.literalValue?.trim()) {
      configuredQueryParams[name] = param.literalValue.trim();
    }
  }

  const oauth2Presets: readonly OAuth2Preset[] = preview?.oauth2Presets ?? [];
  const oauth2RedirectUrl = oauthCallbackUrl(OPENAPI_OAUTH_CALLBACK_PATH);
  // Stable source id derivation. Matches the value `handleAdd` sends as
  // `namespace`, and is also the default credential key when the user
  // does not provide a more explicit shared connection id.
  const resolvedSourceId =
    slugifyNamespace(identity.namespace) ||
    (preview ? Option.getOrElse(preview.title, () => "openapi") : "openapi");
  const selectedOAuth2Preset: OAuth2Preset | null =
    strategy.kind === "oauth2" ? (oauth2Presets[strategy.presetIndex] ?? null) : null;
  const selectedOAuth2Fingerprint = selectedOAuth2Preset
    ? [
        resolvedSourceId,
        resolvedBaseUrl,
        selectedOAuth2Preset.securitySchemeName,
        selectedOAuth2Preset.flow,
        selectedOAuth2Preset.tokenUrl,
        Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
      ].join("\n")
    : "";
  const oauth2Auth =
    oauth2AuthState?.fingerprint === selectedOAuth2Fingerprint ? oauth2AuthState.auth : null;

  const configuredOAuth2 =
    strategy.kind === "oauth2" && selectedOAuth2Preset
      ? new OAuth2SourceConfig({
          kind: "oauth2",
          securitySchemeName: selectedOAuth2Preset.securitySchemeName,
          flow: selectedOAuth2Preset.flow,
          tokenUrl: resolveOAuthUrl(selectedOAuth2Preset.tokenUrl, resolvedBaseUrl),
          authorizationUrl:
            selectedOAuth2Preset.flow === "authorizationCode"
              ? resolveOAuthUrl(
                  Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
                  resolvedBaseUrl,
                ) || null
              : null,
          clientIdSlot: oauth2ClientIdSlot(selectedOAuth2Preset.securitySchemeName),
          // Authorization-code specs can still be confidential clients
          // (Spotify is one example). Persist the slot even when the value is
          // deferred so the edit screen can collect the secret later.
          clientSecretSlot: oauth2ClientSecretSlot(selectedOAuth2Preset.securitySchemeName),
          connectionSlot: oauth2ConnectionSlot(selectedOAuth2Preset.securitySchemeName),
          scopes: [...oauth2SelectedScopes],
        })
      : null;
  const hasHeaders = Object.keys(configuredHeaders).length > 0;
  const oauth2Busy = startingOAuth || oauth.busy;
  const canConnectOAuth2 = Boolean(oauth2ClientIdSecretId) && resolvedBaseUrl.length > 0;
  const hasIncompleteHeaderCredentials =
    strategy.kind !== "none" &&
    strategy.kind !== "oauth2" &&
    customHeaders.some((header) => header.name.trim() && !header.secretId);
  const hasIncompleteQueryCredentials = runtimeCredentials.queryParams.some(
    (param) => param.name.trim() && !param.secretId && !param.literalValue?.trim(),
  );
  const willAddWithoutInitialCredentials =
    Boolean(selectedOAuth2Preset && !oauth2Auth) ||
    hasIncompleteHeaderCredentials ||
    hasIncompleteQueryCredentials;

  const canAdd = preview !== null && resolvedBaseUrl.length > 0;

  // ---- Handlers ----

  const handleAnalyze = async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setAddError(null);
    const credentials = serializeHttpCredentials(specFetchCredentials);
    const exit = await doPreview({
      params: { scopeId },
      payload: {
        spec: specUrl,
        specFetchCredentials: credentials,
      },
    });
    if (Exit.isFailure(exit)) {
      setAnalyzeError(errorMessageFromExit(exit, "Failed to parse spec"));
      setAnalyzing(false);
      return;
    }
    const result = exit.value;
    setPreview(result);

    const firstServer = result.servers[0];
    setBaseUrl(firstServer ? (expandServerOptions(firstServer)[0]?.value ?? "") : "");

    const firstPreset = result.headerPresets[0];
    if (firstPreset) {
      setStrategy({ kind: "header", presetIndex: 0 });
      setCustomHeaders(entriesFromSpecPreset(firstPreset));
    } else if (result.oauth2Presets[0]) {
      setStrategy({ kind: "oauth2", presetIndex: 0 });
      setCustomHeaders([]);
      setOauth2SelectedScopes(new Set(Object.keys(result.oauth2Presets[0].scopes)));
    } else {
      // No header presets — default to "custom" so the headers editor is
      // visible immediately. Specs with no `security` block (e.g. Microsoft
      // Graph) would otherwise leave the user staring at just the
      // Authentication heading with no way to add headers.
      setStrategy({ kind: "custom" });
      setCustomHeaders([]);
    }
    setAnalyzing(false);
  };

  handleAnalyzeRef.current = handleAnalyze;

  const selectStrategy = (next: StrategySelection) => {
    setStrategy(next);
    // Clear any stale OAuth grant whenever the strategy changes away from oauth2.
    if (next.kind !== "oauth2") {
      setOauth2AuthState(null);
      setOauth2Error(null);
    }
    Match.value(next).pipe(
      Match.when({ kind: "none" }, () => {
        setCustomHeaders([]);
      }),
      Match.when({ kind: "custom" }, () => {
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders(userHeaders.length > 0 ? userHeaders : []);
      }),
      Match.when({ kind: "header" }, (n) => {
        const preset = preview?.headerPresets[n.presetIndex];
        if (!preset) return;
        const userHeaders = customHeaders.filter((h) => !h.fromPreset);
        setCustomHeaders([...entriesFromSpecPreset(preset), ...userHeaders]);
      }),
      Match.when({ kind: "oauth2" }, (n) => {
        setCustomHeaders([]);
        const preset = preview?.oauth2Presets[n.presetIndex];
        if (preset) {
          setOauth2SelectedScopes(new Set(Object.keys(preset.scopes)));
        }
      }),
      Match.exhaustive,
    );
  };

  const handleHeadersChange = (next: HeaderState[]) => {
    setCustomHeaders(next);
    if (strategy.kind === "header" && next.every((h) => !h.fromPreset)) {
      setStrategy(next.length === 0 ? { kind: "none" } : { kind: "custom" });
    }
  };

  const setInitialCredentialScope = (targetScope: ScopeId) => {
    setCredentialTargetScope(targetScope);
    setCustomHeaders((headers) =>
      headers.map((header) => ({
        ...header,
        targetScope,
        ...(header.secretScope && header.secretScope !== targetScope
          ? { secretId: null, secretScope: undefined }
          : {}),
      })),
    );
    setOauth2ClientIdSecretId(null);
    setOauth2ClientSecretSecretId(null);
    setOauth2ClientIdScope(null);
    setOauth2ClientSecretScope(null);
    setOauth2AuthState(null);
  };

  const toggleOAuth2Scope = (scope: string) => {
    setOauth2SelectedScopes((prev) => {
      const copy = new Set(prev);
      if (copy.has(scope)) copy.delete(scope);
      else copy.add(scope);
      return copy;
    });
    // Changing scopes invalidates any previously-granted token.
    setOauth2AuthState(null);
  };

  const handleConnectOAuth2 = useCallback(async () => {
    if (!selectedOAuth2Preset || !oauth2ClientIdSecretId || !preview) return;
    oauth.cancel();
    setOauth2Error(null);
    const displayName = identity.name.trim() || selectedOAuth2Preset.securitySchemeName;

    const tokenUrl = resolveOAuthUrl(selectedOAuth2Preset.tokenUrl, resolvedBaseUrl);

    if (selectedOAuth2Preset.flow === "clientCredentials") {
      // RFC 6749 §4.4: no user-interactive consent step. The client_secret
      // is mandatory; the backend exchanges tokens inline and returns a
      // completed Connection we bind to the source's connection slot.
      if (!oauth2ClientSecretSecretId) {
        setOauth2Error("client_credentials requires a client secret");
        return;
      }
      setStartingOAuth(true);
      const connectionId = openApiOAuthConnectionId(resolvedSourceId, selectedOAuth2Preset.flow);
      const exit = await doStartOAuth({
        params: { scopeId: oauthTokenTargetScope },
        payload: {
          endpoint: tokenUrl,
          redirectUrl: tokenUrl,
          connectionId,
          tokenScope: oauthTokenTargetScope,
          strategy: {
            kind: "client-credentials",
            tokenEndpoint: tokenUrl,
            clientIdSecretId: oauth2ClientIdSecretId,
            clientSecretSecretId: oauth2ClientSecretSecretId,
            scopes: [...oauth2SelectedScopes],
          },
          pluginId: "openapi",
          identityLabel: `${displayName} OAuth`,
        },
      });
      setStartingOAuth(false);
      if (Exit.isFailure(exit)) {
        setOauth2Error(errorMessageFromExit(exit, "Failed to start OAuth"));
        return;
      }
      const response = exit.value;
      if (!response.completedConnection) {
        setOauth2Error("client_credentials flow did not mint a connection");
        return;
      }
      setOauth2AuthState({
        fingerprint: selectedOAuth2Fingerprint,
        auth: { connectionId: response.completedConnection.connectionId },
      });
      setOauth2Error(null);
      return;
    }

    const authorizationUrl = resolveOAuthUrl(
      Option.getOrElse(selectedOAuth2Preset.authorizationUrl, () => ""),
      resolvedBaseUrl,
    );
    const issuerUrl = inferOAuthIssuerUrl(authorizationUrl);

    await oauth.openAuthorization({
      tokenScope: oauthTokenTargetScope,
      run: async () => {
        const exit = await doStartOAuth({
          params: { scopeId: oauthTokenTargetScope },
          payload: {
            endpoint: authorizationUrl,
            connectionId: openApiOAuthConnectionId(resolvedSourceId, selectedOAuth2Preset.flow),
            tokenScope: oauthTokenTargetScope,
            redirectUrl: oauth2RedirectUrl,
            strategy: {
              kind: "authorization-code",
              authorizationEndpoint: authorizationUrl,
              tokenEndpoint: tokenUrl,
              issuerUrl,
              clientIdSecretId: oauth2ClientIdSecretId,
              clientSecretSecretId: oauth2ClientSecretSecretId ?? null,
              scopes: [...oauth2SelectedScopes],
            },
            pluginId: "openapi",
            identityLabel: `${displayName} OAuth`,
          },
        });
        if (Exit.isFailure(exit)) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: OAuth popup API represents start failure by rejecting run()
          throw new Error(errorMessageFromExit(exit, "Failed to start OAuth"));
        }
        const response = exit.value;
        if (response.authorizationUrl === null) {
          // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: OAuth popup API represents start failure by rejecting run()
          throw new Error("Unexpected response flow from server");
        }
        return {
          sessionId: response.sessionId,
          authorizationUrl: response.authorizationUrl,
        };
      },
      onSuccess: (result) => {
        setOauth2AuthState({
          fingerprint: selectedOAuth2Fingerprint,
          auth: { connectionId: result.connectionId },
        });
        setOauth2Error(null);
      },
      onError: (message) => {
        setStartingOAuth(false);
        setOauth2Error(message);
      },
    });
  }, [
    selectedOAuth2Preset,
    oauth2ClientIdSecretId,
    oauth2ClientSecretSecretId,
    oauth2SelectedScopes,
    oauth2RedirectUrl,
    resolvedBaseUrl,
    preview,
    doStartOAuth,
    identity.name,
    resolvedSourceId,
    selectedOAuth2Fingerprint,
    oauth,
    oauthTokenTargetScope,
  ]);

  const handleCancelOAuth2 = useCallback(() => {
    oauth.cancel();
    setStartingOAuth(false);
    setOauth2Error(null);
  }, [oauth]);

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    const namespace = resolvedSourceId;
    const displayName =
      identity.name.trim() ||
      (preview ? Option.getOrElse(preview.title, () => namespace) : namespace);
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        targetScope: scopeId,
        credentialTargetScope,
        spec: specUrl,
        specFetchCredentials: serializeHttpCredentials(specFetchCredentials),
        name: displayName,
        namespace,
        baseUrl: resolvedBaseUrl || undefined,
        ...(hasHeaders ? { headers: configuredHeaders } : {}),
        ...(Object.keys(configuredQueryParams).length > 0
          ? { queryParams: configuredQueryParams }
          : {}),
        ...(configuredOAuth2 ? { oauth2: configuredOAuth2 } : {}),
      },
      reactivityKeys: addSpecWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setAddError(errorMessageFromExit(exit, "Failed to add source"));
      setAdding(false);
      return;
    }

    const sourceId = exit.value.namespace;
    const sourceScope = ScopeId.make(scopeId);
    const bindingScope = ScopeId.make(credentialTargetScope);
    const oauthTokenBindingScope = ScopeId.make(oauthTokenTargetScope);
    const clientIdSecretScope = oauth2ClientIdScope ?? bindingScope;
    const clientSecretSecretScope = oauth2ClientSecretScope ?? bindingScope;

    for (const binding of headerBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: new OpenApiSourceBindingInput({
          sourceId,
          sourceScope,
          scope: binding.scope,
          slot: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
            secretScopeId: binding.secretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    for (const binding of queryParamBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: new OpenApiSourceBindingInput({
          sourceId,
          sourceScope,
          scope: binding.scope,
          slot: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
            secretScopeId: binding.secretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2 && oauth2ClientIdSecretId) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: new OpenApiSourceBindingInput({
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: configuredOAuth2.clientIdSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientIdSecretId),
            secretScopeId: clientIdSecretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2?.clientSecretSlot && oauth2ClientSecretSecretId) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: new OpenApiSourceBindingInput({
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: configuredOAuth2.clientSecretSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientSecretSecretId),
            secretScopeId: clientSecretSecretScope,
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    if (configuredOAuth2 && oauth2Auth) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: new OpenApiSourceBindingInput({
          sourceId,
          sourceScope,
          scope: oauthTokenBindingScope,
          slot: configuredOAuth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(oauth2Auth.connectionId),
          },
        }),
        reactivityKeys: bindingWriteKeys,
      });
      if (Exit.isFailure(bindingExit)) {
        setAddError(errorMessageFromExit(bindingExit, "Failed to add source"));
        setAdding(false);
        return;
      }
    }

    props.onComplete();
  };

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>
      </div>

      {!preview && (
        <>
          {/* ── Spec input ── */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField
                label="OpenAPI Spec"
                hint="Paste a URL or raw JSON/YAML content."
              >
                <div className="relative">
                  <Textarea
                    value={specUrl}
                    onChange={(e) => {
                      setSpecUrl((e.target as HTMLTextAreaElement).value);
                    }}
                    placeholder="https://api.example.com/openapi.json"
                    rows={3}
                    maxRows={10}
                    className="font-mono text-sm"
                  />
                  {analyzing && (
                    <div className="pointer-events-none absolute right-2 top-2">
                      <IOSSpinner className="size-4" />
                    </div>
                  )}
                </div>
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <Collapsible
            open={specFetchCredentialsOpen}
            onOpenChange={setSpecFetchCredentialsOpen}
            className="space-y-3"
          >
            <CollapsibleTrigger asChild>
              <Button variant="outline" size="sm" className="self-start">
                {specFetchCredentialsOpen ? "Hide spec credentials" : "Add spec credentials"}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <HttpCredentialsEditor
                credentials={specFetchCredentials}
                onChange={setSpecFetchCredentials}
                existingSecrets={secretList}
                sourceName={identity.name}
                targetScope={credentialTargetScope}
                labels={{
                  headers: "Spec fetch headers",
                  queryParams: "Spec fetch query parameters",
                }}
              />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {/* ── Source information card (shown after analysis) ── */}
      {preview ? (
        <OpenApiSourceDetailsFields
          title={Option.getOrElse(preview.title, () => "API")}
          description={`${Option.getOrElse(preview.version, () => "")}${
            Option.isSome(preview.version) ? " · " : ""
          }${preview.operationCount} operation${preview.operationCount !== 1 ? "s" : ""}${
            preview.tags.length > 0
              ? ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`
              : ""
          }`}
          identity={identity}
          baseUrl={resolvedBaseUrl}
          onBaseUrlChange={setBaseUrl}
          baseUrlOptions={baseUrlOptions}
          specUrl={specUrl}
          onSpecUrlChange={(value) => {
            setSpecUrl(value);
            setPreview(null);
            setBaseUrl("");
            setCustomHeaders([]);
            setStrategy({ kind: "none" });
            setOauth2AuthState(null);
            setOauth2Error(null);
          }}
          faviconUrl={resolvedBaseUrl}
          baseUrlMissingMessage="A base URL is required to make requests."
        />
      ) : null}

      {analyzeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{analyzeError}</p>
        </div>
      )}

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
          <section className="space-y-2.5">
            <FieldLabel>Authentication method</FieldLabel>
            {/* RadioGroup always renders so the static Custom + None radios
                stay visible for specs with no security schemes (e.g. MS Graph).
                The preset .map() blocks below render nothing when their arrays
                are empty. */}
            <RadioGroup
              value={serializeStrategy(strategy)}
              onValueChange={(value) => selectStrategy(parseStrategy(value))}
              className="gap-1.5"
            >
              {preview.headerPresets.map((preset, i) => {
                const selected = strategy.kind === "header" && strategy.presetIndex === i;
                return (
                  <Label
                    key={`header-${i}`}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      selected
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={`header:${i}`} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{preset.label}</div>
                      {preset.secretHeaders.length > 0 && (
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {preset.secretHeaders.join(" · ")}
                        </div>
                      )}
                    </div>
                  </Label>
                );
              })}
              {oauth2Presets.map((preset, i) => {
                const selected = strategy.kind === "oauth2" && strategy.presetIndex === i;
                const scopeCount = Object.keys(preset.scopes).length;
                return (
                  <Label
                    key={`oauth2-${i}`}
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      selected
                        ? "border-primary/50 bg-primary/[0.03]"
                        : "border-border hover:bg-accent/50"
                    }`}
                  >
                    <RadioGroupItem value={`oauth2:${i}`} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-foreground">{preset.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {scopeCount} scope{scopeCount === 1 ? "" : "s"}
                      </div>
                    </div>
                  </Label>
                );
              })}
              <Label
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  strategy.kind === "custom"
                    ? "border-primary/50 bg-primary/[0.03]"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <RadioGroupItem value="custom" />
                <span className="text-xs font-medium text-foreground">Custom</span>
              </Label>
              <Label
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  strategy.kind === "none"
                    ? "border-primary/50 bg-primary/[0.03]"
                    : "border-border hover:bg-accent/50"
                }`}
              >
                <RadioGroupItem value="none" />
                <span className="text-xs font-medium text-foreground">None</span>
              </Label>
            </RadioGroup>

            {/* Header-based auth input */}
            {strategy.kind !== "none" && strategy.kind !== "oauth2" && (
              <div className="space-y-3">
                <HeadersList
                  headers={customHeaders}
                  onHeadersChange={handleHeadersChange}
                  existingSecrets={secretList}
                  sourceName={identity.name}
                  targetScope={credentialTargetScope}
                  credentialScopeOptions={initialCredentialScopeOptions}
                  bindingScopeOptions={bindingScopeOptions}
                  restrictSecretsToTargetScope
                  emptyLabel="No credentials yet. Add the header value this method should use."
                />
              </div>
            )}

            <HttpCredentialsEditor
              credentials={runtimeCredentials}
              onChange={setRuntimeCredentials}
              existingSecrets={secretList}
              sourceName={identity.name}
              targetScope={credentialTargetScope}
              credentialScopeOptions={initialCredentialScopeOptions}
              bindingScopeOptions={bindingScopeOptions}
              restrictSecretsToTargetScope
              sections={{ headers: false, queryParams: true }}
              labels={{ queryParams: "Runtime query parameters" }}
            />

            {/* OAuth2 configuration */}
            {selectedOAuth2Preset && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">
                      Redirect URL{" "}
                      <span className="text-muted-foreground">
                        · add this to your OAuth app's allowed redirects
                      </span>
                    </FieldLabel>
                    <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px]">
                      <span className="truncate flex-1 text-foreground">{oauth2RedirectUrl}</span>
                      <CopyButton value={oauth2RedirectUrl} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">Client ID secret</FieldLabel>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <FieldLabel className="text-[11px]">Secret</FieldLabel>
                          <HelpTooltip label="Client ID secret">
                            Select or create the OAuth client ID secret.
                          </HelpTooltip>
                        </div>
                        <CreatableSecretPicker
                          value={oauth2ClientIdSecretId}
                          onSelect={(id: string, secretScopeId?: ScopeId) => {
                            setOauth2ClientIdSecretId(id);
                            setOauth2ClientIdScope(secretScopeId ?? credentialTargetScope);
                            setOauth2AuthState(null);
                          }}
                          secrets={initialCredentialSecrets}
                          sourceName={identity.name}
                          secretLabel="Client ID"
                          targetScope={oauth2ClientIdScope ?? credentialTargetScope}
                          credentialScopeOptions={initialCredentialScopeOptions}
                          onCreatedScope={setOauth2ClientIdScope}
                        />
                      </div>
                      <CredentialScopeDropdown
                        value={credentialTargetScope}
                        options={bindingScopeOptions}
                        onChange={setInitialCredentialScope}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">
                      Client secret{" "}
                      <span className="text-muted-foreground">
                        · optional for public clients with PKCE
                      </span>
                    </FieldLabel>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <FieldLabel className="text-[11px]">Secret</FieldLabel>
                          <HelpTooltip label="Client secret">
                            Select or create the OAuth client secret.
                          </HelpTooltip>
                        </div>
                        <CreatableSecretPicker
                          value={oauth2ClientSecretSecretId}
                          onSelect={(id: string, secretScopeId?: ScopeId) => {
                            setOauth2ClientSecretSecretId(id);
                            setOauth2ClientSecretScope(secretScopeId ?? credentialTargetScope);
                            setOauth2AuthState(null);
                          }}
                          secrets={initialCredentialSecrets}
                          sourceName={identity.name}
                          secretLabel="Client Secret"
                          targetScope={oauth2ClientSecretScope ?? credentialTargetScope}
                          credentialScopeOptions={initialCredentialScopeOptions}
                          onCreatedScope={setOauth2ClientSecretScope}
                        />
                      </div>
                      <CredentialScopeDropdown
                        value={credentialTargetScope}
                        options={bindingScopeOptions}
                        onChange={setInitialCredentialScope}
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <FieldLabel className="text-[11px]">Scopes</FieldLabel>
                    <div className="space-y-1 rounded-md border border-border/50 bg-background/50 p-2">
                      {Object.keys(selectedOAuth2Preset.scopes).length === 0 ? (
                        <div className="text-[11px] italic text-muted-foreground">
                          No scopes declared by the spec.
                        </div>
                      ) : (
                        Object.entries(selectedOAuth2Preset.scopes).map(([scope, description]) => (
                          <Label key={scope} className="flex items-start gap-2 cursor-pointer py-1">
                            <Checkbox
                              checked={oauth2SelectedScopes.has(scope)}
                              onCheckedChange={() => toggleOAuth2Scope(scope)}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-mono text-[11px] text-foreground">{scope}</div>
                              {description && (
                                <div className="text-[10px] text-muted-foreground">
                                  {description}
                                </div>
                              )}
                            </div>
                          </Label>
                        ))
                      )}
                    </div>
                  </div>

                  {oauth2Auth ? (
                    <div className="flex items-center justify-between rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2">
                      <div className="text-[11px] text-green-700 dark:text-green-400">
                        Connected · {oauth2SelectedScopes.size} scope
                        {oauth2SelectedScopes.size === 1 ? "" : "s"} granted
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setOauth2AuthState(null)}>
                        Disconnect
                      </Button>
                    </div>
                  ) : oauth2Busy ? (
                    <div className="flex items-center gap-2">
                      <div className="flex flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
                        <Spinner className="size-3.5" />
                        Waiting for OAuth… complete the flow in the popup, or cancel to retry.
                      </div>
                      <Button variant="ghost" size="sm" onClick={handleCancelOAuth2}>
                        Cancel
                      </Button>
                      <Button variant="secondary" size="sm" onClick={handleConnectOAuth2}>
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <div className="grid gap-2 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <FieldLabel className="text-[11px]">OAuth sign-in</FieldLabel>
                            <HelpTooltip label="OAuth sign-in">
                              Start the provider OAuth flow.
                            </HelpTooltip>
                          </div>
                          <Button
                            variant="secondary"
                            onClick={handleConnectOAuth2}
                            disabled={!canConnectOAuth2}
                            className={
                              canConnectOAuth2
                                ? "w-full border border-green-500/30 bg-green-600 text-white hover:bg-green-700 focus-visible:ring-green-500/30 dark:bg-green-500 dark:text-white dark:hover:bg-green-600"
                                : "w-full"
                            }
                          >
                            Connect via OAuth
                          </Button>
                        </div>
                        <CredentialScopeDropdown
                          value={oauthTokenTargetScope}
                          options={credentialScopeOptions}
                          onChange={(targetScope) => {
                            setOAuthTokenTargetScope(targetScope);
                            setOauth2AuthState(null);
                          }}
                          label="Token saved to"
                          help="Choose who can use the signed-in OAuth token."
                        />
                      </div>
                    </div>
                  )}

                  {oauth2Error && (
                    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <p className="text-[11px] text-destructive">{oauth2Error}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          {/* Add error */}
          {addError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{addError}</p>
            </div>
          )}
        </>
      )}

      <FloatActions>
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        {preview && (
          <Button onClick={handleAdd} disabled={!canAdd || adding}>
            {adding && <Spinner className="size-3.5" />}
            {adding
              ? "Adding…"
              : willAddWithoutInitialCredentials
                ? "Add without credentials"
                : "Add source"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
