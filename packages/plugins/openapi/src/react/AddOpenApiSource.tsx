import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConnectionId, ScopeId, SecretId } from "@executor-js/sdk/core";
import { startOAuth } from "@executor-js/react/api/atoms";
import { useScope, useUserScope } from "@executor-js/react/api/scope-context";
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
import {
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
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
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { NativeSelect, NativeSelectOption } from "@executor-js/react/components/native-select";
import { Textarea } from "@executor-js/react/components/textarea";
import { Checkbox } from "@executor-js/react/components/checkbox";
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import { RadioGroup, RadioGroupItem } from "@executor-js/react/components/radio-group";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import { addOpenApiSpecOptimistic, previewOpenApiSpec, setOpenApiSourceBinding } from "./atoms";
import type { SpecPreview, HeaderPreset, OAuth2Preset } from "../sdk/preview";
import {
  headerBindingSlot,
  oauth2ClientIdSlot,
  oauth2ClientSecretSlot,
  oauth2ConnectionSlot,
} from "../sdk/store";
import {
  ConfiguredHeaderBinding,
  OAuth2Auth,
  OAuth2SourceConfig,
  type ServerInfo,
  type ServerVariable,
} from "../sdk/types";

export const OPENAPI_OAUTH_POPUP_NAME = "openapi-oauth";
export const OPENAPI_OAUTH_CALLBACK_PATH = "/api/oauth/callback";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

const substituteUrlVariables = (url: string, values: Record<string, string>): string => {
  let out = url;
  for (const [name, value] of Object.entries(values)) {
    out = out.replaceAll(`{${name}}`, value);
  }
  return out;
};

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
 * OAuth2Auth.
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
    return { kind: "header", presetIndex: Number(value.slice("header:".length)) };
  }
  if (value.startsWith("oauth2:")) {
    return { kind: "oauth2", presetIndex: Number(value.slice("oauth2:".length)) };
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
  // -1 means the user is entering a fully custom base URL (no server selected).
  const [selectedServerIndex, setSelectedServerIndex] = useState<number>(-1);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  // Variable selections for the currently selected server, keyed by variable name.
  const [variableSelections, setVariableSelections] = useState<Record<string, string>>({});
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
  const [oauth2SelectedScopes, setOauth2SelectedScopes] = useState<Set<string>>(new Set());
  const [oauth2AuthState, setOauth2AuthState] = useState<{
    readonly fingerprint: string;
    readonly auth: OAuth2Auth;
  } | null>(null);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [oauth2Error, setOauth2Error] = useState<string | null>(null);

  // Submit
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const userScope = useUserScope();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promiseExit" });
  const doAdd = useAtomSet(addOpenApiSpecOptimistic(scopeId), { mode: "promiseExit" });
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promiseExit" });
  const doSetBinding = useAtomSet(setOpenApiSourceBinding, { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();
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

  const servers: readonly ServerInfo[] = preview?.servers ?? [];
  const selectedServer: ServerInfo | null =
    selectedServerIndex >= 0 ? (servers[selectedServerIndex] ?? null) : null;

  const serverVariables: Record<string, ServerVariable> = selectedServer
    ? Option.getOrElse(selectedServer.variables, () => ({}) as Record<string, ServerVariable>)
    : {};
  const serverVariableEntries: Array<[string, ServerVariable]> = Object.entries(serverVariables);

  const resolvedBaseUrl =
    selectedServer !== null
      ? substituteUrlVariables(selectedServer.url, variableSelections)
      : customBaseUrl.trim();

  // Helper used by analyze + server selection: build a default selection map
  // from a server's variable defaults.
  const defaultSelectionsFor = (server: ServerInfo): Record<string, string> => {
    const vars: Record<string, ServerVariable> = Option.getOrElse(
      server.variables,
      () => ({}) as Record<string, ServerVariable>,
    );
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(vars)) out[name] = v.default;
    return out;
  };

  const configuredHeaders: Record<string, ConfiguredHeaderBinding> = {};
  const headerBindings: Array<{ slot: string; secretId: string }> = [];
  for (const ch of customHeaders) {
    if (!ch.name.trim()) continue;
    const slot = headerBindingSlot(ch.name.trim());
    configuredHeaders[ch.name.trim()] = new ConfiguredHeaderBinding({
      kind: "binding",
      slot,
      prefix: ch.prefix,
    });
    if (ch.secretId) {
      headerBindings.push({ slot, secretId: ch.secretId });
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
    if (firstServer) {
      setSelectedServerIndex(0);
      setVariableSelections(defaultSelectionsFor(firstServer));
      setCustomBaseUrl("");
    } else {
      setSelectedServerIndex(-1);
      setVariableSelections({});
      setCustomBaseUrl("");
    }

    const firstPreset = result.headerPresets[0];
    if (firstPreset) {
      setStrategy({ kind: "header", presetIndex: 0 });
      setCustomHeaders(entriesFromSpecPreset(firstPreset));
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
      // completed OAuth2Auth we can attach to the source directly.
      if (!oauth2ClientSecretSecretId) {
        setOauth2Error("client_credentials requires a client secret");
        return;
      }
      setStartingOAuth(true);
      const connectionId = openApiOAuthConnectionId(resolvedSourceId, selectedOAuth2Preset.flow);
      const exit = await doStartOAuth({
        params: { scopeId },
        payload: {
          endpoint: tokenUrl,
          redirectUrl: tokenUrl,
          connectionId,
          tokenScope: scopeId,
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
        auth: new OAuth2Auth({
          kind: "oauth2",
          connectionId: response.completedConnection.connectionId,
          securitySchemeName: selectedOAuth2Preset.securitySchemeName,
          flow: "clientCredentials",
          tokenUrl,
          authorizationUrl: null,
          clientIdSecretId: oauth2ClientIdSecretId,
          clientSecretSecretId: oauth2ClientSecretSecretId,
          scopes: [...oauth2SelectedScopes],
        }),
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
      run: async () => {
        const exit = await doStartOAuth({
          params: { scopeId },
          payload: {
            endpoint: authorizationUrl,
            connectionId: openApiOAuthConnectionId(resolvedSourceId, selectedOAuth2Preset.flow),
            tokenScope: scopeId,
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
          auth: new OAuth2Auth({
            kind: "oauth2",
            connectionId: result.connectionId,
            securitySchemeName: selectedOAuth2Preset.securitySchemeName,
            flow: "authorizationCode",
            tokenUrl,
            authorizationUrl,
            issuerUrl,
            clientIdSecretId: oauth2ClientIdSecretId,
            clientSecretSecretId: oauth2ClientSecretSecretId,
            scopes: [...oauth2SelectedScopes],
          }),
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
    scopeId,
    identity.name,
    resolvedSourceId,
    selectedOAuth2Fingerprint,
    oauth,
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
        spec: specUrl,
        specFetchCredentials: serializeHttpCredentials(specFetchCredentials),
        name: displayName,
        namespace,
        baseUrl: resolvedBaseUrl || undefined,
        ...(hasHeaders ? { headers: configuredHeaders } : {}),
        ...(Object.keys(serializeHttpCredentials(runtimeCredentials).queryParams).length > 0
          ? { queryParams: serializeHttpCredentials(runtimeCredentials).queryParams }
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
    const bindingScope = ScopeId.make(userScope);

    for (const binding of headerBindings) {
      const bindingExit = await doSetBinding({
        params: { scopeId },
        payload: {
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: binding.slot,
          value: {
            kind: "secret",
            secretId: SecretId.make(binding.secretId),
          },
        },
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
        payload: {
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: configuredOAuth2.clientIdSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientIdSecretId),
          },
        },
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
        payload: {
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: configuredOAuth2.clientSecretSlot,
          value: {
            kind: "secret",
            secretId: SecretId.make(oauth2ClientSecretSecretId),
          },
        },
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
        payload: {
          sourceId,
          sourceScope,
          scope: bindingScope,
          slot: configuredOAuth2.connectionSlot,
          value: {
            kind: "connection",
            connectionId: ConnectionId.make(oauth2Auth.connectionId),
          },
        },
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
      <h1 className="text-xl font-semibold text-foreground">Add OpenAPI Source</h1>

      {/* ── Spec input ── */}
      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntryField
            label="OpenAPI Spec"
            hint={!preview ? "Paste a URL or raw JSON/YAML content." : undefined}
          >
            <div className="relative">
              <Textarea
                value={specUrl}
                onChange={(e) => {
                  setSpecUrl((e.target as HTMLTextAreaElement).value);
                  if (preview) {
                    setPreview(null);
                    setSelectedServerIndex(-1);
                    setCustomBaseUrl("");
                    setVariableSelections({});
                    setCustomHeaders([]);
                    setStrategy({ kind: "none" });
                    setOauth2AuthState(null);
                    setOauth2Error(null);
                  }
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
            labels={{
              headers: "Spec fetch headers",
              queryParams: "Spec fetch query parameters",
            }}
          />
        </CollapsibleContent>
      </Collapsible>

      {/* ── Title card (shown below spec input after analysis) ── */}
      {preview ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              {resolvedBaseUrl && <SourceFavicon url={resolvedBaseUrl} size={16} />}
              <CardStackEntryContent>
                <CardStackEntryTitle>
                  {Option.getOrElse(preview.title, () => "API")}
                </CardStackEntryTitle>
                <CardStackEntryDescription>
                  {Option.getOrElse(preview.version, () => "")}
                  {Option.isSome(preview.version) && " · "}
                  {preview.operationCount} operation
                  {preview.operationCount !== 1 ? "s" : ""}
                  {preview.tags.length > 0 &&
                    ` · ${preview.tags.length} tag${preview.tags.length !== 1 ? "s" : ""}`}
                </CardStackEntryDescription>
              </CardStackEntryContent>
            </CardStackEntry>
          </CardStackContent>
        </CardStack>
      ) : analyzing ? (
        <CardStack>
          <CardStackContent className="border-t-0">
            <CardStackEntry>
              <Skeleton className="size-4 shrink-0 rounded" />
              <CardStackEntryContent>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1 h-3 w-56" />
              </CardStackEntryContent>
            </CardStackEntry>
          </CardStackContent>
        </CardStack>
      ) : null}

      {analyzeError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{analyzeError}</p>
        </div>
      )}

      {/* ── Everything below appears after analysis ── */}
      {preview && (
        <>
          <SourceIdentityFields identity={identity} />

          {/* Base URL */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField label="Base URL">
                {servers.length >= 1 && (
                  <RadioGroup
                    value={String(selectedServerIndex)}
                    onValueChange={(value) => {
                      const idx = Number(value);
                      setSelectedServerIndex(idx);
                      if (idx >= 0) {
                        const s = servers[idx];
                        if (s) setVariableSelections(defaultSelectionsFor(s));
                      } else {
                        setVariableSelections({});
                      }
                    }}
                    className="gap-1.5"
                  >
                    {servers.map((s, i) => (
                      <Label
                        key={i}
                        className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                          selectedServerIndex === i
                            ? "border-primary/50 bg-primary/[0.03]"
                            : "border-border hover:bg-accent/50"
                        }`}
                      >
                        <RadioGroupItem value={String(i)} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs text-foreground truncate">{s.url}</div>
                          {Option.isSome(s.description) && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {s.description.value}
                            </div>
                          )}
                        </div>
                      </Label>
                    ))}
                    <Label
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                        selectedServerIndex === -1
                          ? "border-primary/50 bg-primary/[0.03]"
                          : "border-border hover:bg-accent/50"
                      }`}
                    >
                      <RadioGroupItem value="-1" />
                      <span className="text-xs font-medium text-foreground">Custom</span>
                    </Label>
                  </RadioGroup>
                )}

                {/* Per-variable pickers for the selected server */}
                {selectedServer && serverVariableEntries.length > 0 && (
                  <div className="mt-2 space-y-2 rounded-lg border border-border/60 bg-muted/20 p-2.5">
                    {serverVariableEntries.map(([name, variable]) => {
                      const enumValues: readonly string[] = Option.getOrElse(
                        variable.enum,
                        () => [] as readonly string[],
                      );
                      const current = variableSelections[name] ?? variable.default;
                      return (
                        <div key={name} className="space-y-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <Label className="font-mono text-[11px] text-foreground">
                              {`{${name}}`}
                            </Label>
                            {Option.isSome(variable.description) && (
                              <span className="text-[10px] text-muted-foreground truncate">
                                {variable.description.value}
                              </span>
                            )}
                          </div>
                          {enumValues.length > 0 ? (
                            <NativeSelect
                              value={current}
                              onChange={(e) =>
                                setVariableSelections((prev) => ({
                                  ...prev,
                                  [name]: (e.target as HTMLSelectElement).value,
                                }))
                              }
                            >
                              {enumValues.map((v) => (
                                <NativeSelectOption key={v} value={v}>
                                  {v}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          ) : (
                            <Input
                              value={current}
                              onChange={(e) =>
                                setVariableSelections((prev) => ({
                                  ...prev,
                                  [name]: (e.target as HTMLInputElement).value,
                                }))
                              }
                              className="font-mono text-xs"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedServerIndex === -1 ? (
                  <Input
                    value={customBaseUrl}
                    onChange={(e) => setCustomBaseUrl((e.target as HTMLInputElement).value)}
                    placeholder="https://api.example.com"
                    className="font-mono text-sm"
                  />
                ) : (
                  <div className="rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {resolvedBaseUrl || "\u00A0"}
                  </div>
                )}

                {!resolvedBaseUrl && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    A base URL is required to make requests.
                  </p>
                )}
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <section className="space-y-2.5">
            <FieldLabel>Authentication</FieldLabel>
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
              <HeadersList
                headers={customHeaders}
                onHeadersChange={handleHeadersChange}
                existingSecrets={secretList}
                sourceName={identity.name}
                writeScope={userScope}
              />
            )}

            <HttpCredentialsEditor
              credentials={runtimeCredentials}
              onChange={setRuntimeCredentials}
              existingSecrets={secretList}
              sourceName={identity.name}
              writeScope={userScope}
              sections={{ headers: false, queryParams: true }}
              labels={{ queryParams: "Runtime query parameters" }}
            />

            {/* OAuth2 configuration */}
            {selectedOAuth2Preset && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
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
                  <CreatableSecretPicker
                    value={oauth2ClientIdSecretId}
                    onSelect={(id: string) => {
                      setOauth2ClientIdSecretId(id);
                      setOauth2AuthState(null);
                    }}
                    secrets={secretList}
                    sourceName={identity.name}
                    secretLabel="Client ID"
                    writeScope={userScope}
                  />
                </div>
                <div className="space-y-1.5">
                  <FieldLabel className="text-[11px]">
                    Client secret{" "}
                    <span className="text-muted-foreground">
                      · optional for public clients with PKCE
                    </span>
                  </FieldLabel>
                  <CreatableSecretPicker
                    value={oauth2ClientSecretSecretId}
                    onSelect={(id: string) => {
                      setOauth2ClientSecretSecretId(id);
                      setOauth2AuthState(null);
                    }}
                    secrets={secretList}
                    sourceName={identity.name}
                    secretLabel="Client Secret"
                    writeScope={userScope}
                  />
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
                              <div className="text-[10px] text-muted-foreground">{description}</div>
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
                    <Button
                      variant="secondary"
                      onClick={handleConnectOAuth2}
                      disabled={!oauth2ClientIdSecretId || resolvedBaseUrl.length === 0}
                      className="w-full"
                    >
                      Connect via OAuth
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Optional — you can save the source now and each user can sign in from the
                      source detail page later.
                    </p>
                  </div>
                )}

                {oauth2Error && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="text-[11px] text-destructive">{oauth2Error}</p>
                  </div>
                )}
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
            {adding ? "Adding…" : "Add source"}
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
