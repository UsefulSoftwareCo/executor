import { useReducer, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { useScope } from "@executor-js/react/api/scope-context";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Spinner } from "@executor-js/react/components/spinner";
import { Textarea } from "@executor-js/react/components/textarea";
import {
  emptyHttpCredentials,
  httpCredentialsValid,
  HttpCredentialsEditor,
  serializeScopedHttpCredentials,
  serializeHttpCredentials,
} from "@executor-js/react/plugins/http-credentials";
import {
  sourceDisplayNameFromUrl,
  slugifyNamespace,
  SourceIdentityFields,
  useSourceIdentity,
} from "@executor-js/react/plugins/source-identity";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  oauthCallbackUrl,
  oauthConnectionId,
  useOAuthPopupFlow,
  type OAuthCompletionPayload,
} from "@executor-js/react/plugins/oauth-sign-in";
import {
  CredentialControlField,
  CredentialUsageRow,
  useCredentialTargetScope,
} from "@executor-js/react/plugins/credential-target-scope";

type RemoteAuthMode = "none" | "oauth2";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { probeMcpEndpoint, addMcpSourceOptimistic } from "./atoms";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import { mcpPresets, type McpPreset } from "../sdk/presets";
import { MCP_OAUTH_CONNECTION_SLOT, type McpCredentialInput } from "../sdk/types";

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

// ---------------------------------------------------------------------------
// Preset lookup
// ---------------------------------------------------------------------------

function findPreset(id: string | undefined): McpPreset | undefined {
  if (!id) return undefined;
  return mcpPresets.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// State machine (remote flow)
// ---------------------------------------------------------------------------

type OAuthTokens = OAuthCompletionPayload;

type ProbeResult = {
  connected: boolean;
  requiresOAuth: boolean;
  supportsDynamicRegistration: boolean;
  name: string;
  namespace: string;
  toolCount: number | null;
  serverName: string | null;
};

type PlainHeader = {
  name: string;
  value: string;
};

type State =
  | { step: "url"; url: string }
  | { step: "probing"; url: string; probe: ProbeResult | null }
  | { step: "probed"; url: string; probe: ProbeResult }
  | { step: "oauth-starting"; url: string; probe: ProbeResult }
  | {
      step: "oauth-waiting";
      url: string;
      probe: ProbeResult;
      sessionId: string;
    }
  | { step: "oauth-done"; url: string; probe: ProbeResult; tokens: OAuthTokens }
  | {
      step: "adding";
      url: string;
      probe: ProbeResult;
      tokens: OAuthTokens | null;
    }
  | {
      step: "error";
      url: string;
      probe: ProbeResult | null;
      tokens: OAuthTokens | null;
      error: string;
    };

type Action =
  | { type: "set-url"; url: string }
  | { type: "probe-start" }
  | { type: "probe-ok"; probe: ProbeResult }
  | { type: "probe-fail"; error: string }
  | { type: "oauth-start" }
  | { type: "oauth-waiting"; sessionId: string }
  | { type: "oauth-ok"; tokens: OAuthTokens }
  | { type: "oauth-fail"; error: string }
  | { type: "oauth-cancelled" }
  | { type: "oauth-reset" }
  | { type: "add-start" }
  | { type: "add-fail"; error: string }
  | { type: "retry" };

const init: State = { step: "url", url: "" };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "set-url":
      return { step: "url", url: action.url };

    case "probe-start":
      return { step: "probing", url: state.url, probe: "probe" in state ? state.probe : null };

    case "probe-ok":
      return { step: "probed", url: state.url, probe: action.probe };

    case "probe-fail":
      return {
        step: "error",
        url: state.url,
        probe: null,
        tokens: null,
        error: action.error,
      };

    case "oauth-start":
      if (state.step !== "probed" && state.step !== "error") return state;
      return {
        step: "oauth-starting",
        url: state.url,
        probe: state.step === "probed" ? state.probe : state.probe!,
      };

    case "oauth-waiting":
      if (state.step !== "oauth-starting") return state;
      return {
        step: "oauth-waiting",
        url: state.url,
        probe: state.probe,
        sessionId: action.sessionId,
      };

    case "oauth-ok":
      if (state.step !== "oauth-waiting") return state;
      return {
        step: "oauth-done",
        url: state.url,
        probe: state.probe,
        tokens: action.tokens,
      };

    case "oauth-fail":
      if (state.step !== "oauth-starting" && state.step !== "oauth-waiting") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: null,
        error: action.error,
      };

    case "oauth-cancelled":
      if (state.step !== "oauth-waiting") return state;
      return { step: "probed", url: state.url, probe: state.probe };

    case "oauth-reset":
      if ("probe" in state && state.probe) {
        return { step: "probed", url: state.url, probe: state.probe };
      }
      return state;

    case "add-start": {
      const tokens =
        state.step === "oauth-done" ? state.tokens : state.step === "probed" ? null : null;
      const probe = "probe" in state ? state.probe : null;
      if (!probe) return state;
      return { step: "adding", url: state.url, probe, tokens };
    }

    case "add-fail":
      if (state.step !== "adding") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: state.tokens,
        error: action.error,
      };

    case "retry": {
      if (state.step !== "error") return state;
      return state.probe
        ? state.tokens
          ? {
              step: "oauth-done",
              url: state.url,
              probe: state.probe,
              tokens: state.tokens,
            }
          : { step: "probed", url: state.url, probe: state.probe }
        : { step: "url", url: state.url };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AddMcpSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  /** Whether the stdio transport is enabled on the server. */
  allowStdio?: boolean;
}) {
  const allowStdio = props.allowStdio ?? false;
  const rawPreset = findPreset(props.initialPreset);
  // Drop stdio presets when stdio is disabled — the caller should have
  // already filtered these out, but defence-in-depth.
  const preset = rawPreset?.transport === "stdio" && !allowStdio ? undefined : rawPreset;
  const isStdioPreset = preset?.transport === "stdio";

  const [transport, setTransport] = useState<"remote" | "stdio">(
    isStdioPreset && allowStdio ? "stdio" : "remote",
  );

  // --- Stdio state ---
  const [stdioCommand, setStdioCommand] = useState(isStdioPreset ? preset.command : "");
  const [stdioArgs, setStdioArgs] = useState(
    isStdioPreset && preset.args ? preset.args.join(" ") : "",
  );
  const [stdioEnv, setStdioEnv] = useState("");
  const stdioIdentity = useSourceIdentity({
    fallbackName: isStdioPreset ? preset.name : stdioCommand,
  });
  const [stdioAdding, setStdioAdding] = useState(false);
  const [stdioError, setStdioError] = useState<string | null>(null);

  // --- Remote state ---
  const remoteUrl =
    !isStdioPreset && preset?.transport === undefined && preset?.url
      ? preset.url
      : (props.initialUrl ?? "");

  const [state, dispatch] = useReducer(
    reducer,
    remoteUrl ? { step: "url" as const, url: remoteUrl } : init,
  );

  const scopeId = useScope();
  const { credentialTargetScope: requestCredentialTargetScope } = useCredentialTargetScope();
  const {
    credentialTargetScope: oauthCredentialTargetScope,
    setCredentialTargetScope: setOAuthCredentialTargetScope,
    credentialScopeOptions,
  } = useCredentialTargetScope();
  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promiseExit" });
  const doAdd = useAtomSet(addMcpSourceOptimistic(scopeId), {
    mode: "promiseExit",
  });
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow<OAuthCompletionPayload>({
    popupName: "mcp-oauth",
    popupBlockedMessage: "OAuth popup was blocked",
    detectPopupClosed: false,
    startErrorMessage: "Failed to start OAuth",
  });

  const [remoteAuthMode, setRemoteAuthMode] = useState<RemoteAuthMode>("none");
  const [remoteHeaders, setRemoteHeaders] = useState<PlainHeader[]>([]);
  const [remoteCredentials, setRemoteCredentials] = useState(() => emptyHttpCredentials());

  const probe = "probe" in state ? state.probe : null;
  const tokens = "tokens" in state ? state.tokens : null;

  const remoteIdentity = useSourceIdentity({
    fallbackName:
      sourceDisplayNameFromUrl(state.url, "MCP") ?? probe?.serverName ?? probe?.name ?? "",
  });
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";
  const isOAuthBusy =
    state.step === "oauth-starting" || state.step === "oauth-waiting" || oauth.busy;
  const canUseNone = probe?.requiresOAuth !== true || probe.supportsDynamicRegistration === false;
  const remoteHeadersComplete = remoteHeaders.every(
    (header) => header.name.trim() && header.value.trim(),
  );
  const remoteCredentialsComplete = httpCredentialsValid(remoteCredentials);
  const authReady = remoteAuthMode === "none" ? canUseNone : tokens !== null;
  const canAdd =
    Boolean(probe) &&
    authReady &&
    remoteHeadersComplete &&
    remoteCredentialsComplete &&
    !isAdding &&
    !isOAuthBusy;
  // Probe failures are shown inline on the URL field; other failures
  // (OAuth start, add source) render in the bottom error block.
  const probeError = state.step === "error" && state.probe === null ? state.error : null;
  const otherError = state.step === "error" && state.probe !== null ? state.error : null;

  // ---- Remote actions ----

  const handleProbe = useCallback(async () => {
    dispatch({ type: "probe-start" });
    const { headers, queryParams } = serializeHttpCredentials(remoteCredentials);
    const exit = await doProbe({
      params: { scopeId },
      payload: {
        endpoint: state.url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
      },
    });
    if (Exit.isFailure(exit)) {
      dispatch({
        type: "probe-fail",
        error: errorMessageFromExit(exit, "Failed to connect"),
      });
      return;
    }
    setRemoteAuthMode(exit.value.requiresOAuth ? "oauth2" : "none");
    dispatch({ type: "probe-ok", probe: exit.value });
  }, [state.url, scopeId, doProbe, remoteCredentials]);

  // Keep the latest handleProbe in a ref so the debounced effect can call it
  // without depending on its identity (which changes every render).
  const handleProbeRef = useRef(handleProbe);
  handleProbeRef.current = handleProbe;

  // Auto-probe whenever the URL changes (debounced) while we're on the
  // remote transport and not already probing/probed.
  useEffect(() => {
    if (transport !== "remote") return;
    if (state.step !== "url") return;
    const trimmed = state.url.trim();
    if (!trimmed) return;
    const handle = setTimeout(() => {
      handleProbeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [transport, state.step, state.url]);

  const handleRemoteCredentialsChange = useCallback((next: typeof remoteCredentials) => {
    setRemoteCredentials(next);
  }, []);

  const handleOAuth = useCallback(async () => {
    dispatch({ type: "oauth-start" });
    const namespaceSlug =
      slugifyNamespace(remoteIdentity.namespace) ||
      slugifyNamespace(probe?.namespace ?? "") ||
      "mcp";
    const { headers, queryParams } = serializeHttpCredentials(remoteCredentials);
    await oauth.start({
      payload: {
        endpoint: state.url.trim(),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(Object.keys(queryParams).length > 0 ? { queryParams } : {}),
        redirectUrl: oauthCallbackUrl(),
        connectionId: oauthConnectionId({
          pluginId: "mcp",
          namespace: namespaceSlug,
        }),
        tokenScope: oauthCredentialTargetScope,
        strategy: { kind: "dynamic-dcr" },
        pluginId: "mcp",
        identityLabel: `${remoteIdentity.name.trim() || probe?.serverName || probe?.name || "MCP"} OAuth`,
      },
      onSuccess: (result) => {
        dispatch({
          type: "oauth-ok",
          tokens: {
            connectionId: result.connectionId,
            expiresAt: result.expiresAt,
            scope: result.scope,
          },
        });
      },
      onAuthorizationStarted: (result) =>
        dispatch({ type: "oauth-waiting", sessionId: result.sessionId }),
      onError: (error) => dispatch({ type: "oauth-fail", error }),
    });
  }, [state.url, remoteIdentity, probe, remoteCredentials, oauth, oauthCredentialTargetScope]);

  const handleCancelOAuth = useCallback(() => {
    oauth.cancel();
    dispatch({ type: "oauth-cancelled" });
  }, [oauth]);

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    const auth =
      remoteAuthMode === "oauth2"
        ? tokens
          ? {
              kind: "oauth2" as const,
              connectionId: tokens.connectionId,
            }
          : {
              kind: "oauth2" as const,
              connectionSlot: MCP_OAUTH_CONNECTION_SLOT,
            }
        : { kind: "none" as const };
    const headers = Object.fromEntries(
      remoteHeaders
        .map((header) => [header.name.trim(), header.value.trim()] as const)
        .filter(([name, value]) => name && value),
    );
    const credentials = serializeScopedHttpCredentials(
      remoteCredentials,
      requestCredentialTargetScope,
    );
    const remoteRequestHeaders: Record<string, McpCredentialInput> = {
      ...headers,
      ...credentials.headers,
    };
    const displayName = remoteIdentity.name.trim() || probe.serverName || probe.name;
    const slugNamespace = slugifyNamespace(remoteIdentity.namespace);
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        targetScope: scopeId,
        transport: "remote" as const,
        name: displayName,
        namespace: slugNamespace || undefined,
        endpoint: state.url.trim(),
        auth,
        credentialTargetScope:
          remoteAuthMode === "oauth2" && tokens
            ? oauthCredentialTargetScope
            : requestCredentialTargetScope,
        ...(Object.keys(remoteRequestHeaders).length > 0 ? { headers: remoteRequestHeaders } : {}),
        ...(Object.keys(credentials.queryParams).length > 0
          ? { queryParams: credentials.queryParams }
          : {}),
      },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      dispatch({
        type: "add-fail",
        error: errorMessageFromExit(exit, "Failed to add source"),
      });
      return;
    }
    props.onComplete();
  }, [
    probe,
    remoteAuthMode,
    remoteHeaders,
    remoteCredentials,
    remoteIdentity,
    tokens,
    state.url,
    doAdd,
    props,
    scopeId,
    requestCredentialTargetScope,
    oauthCredentialTargetScope,
  ]);

  // ---- Stdio actions ----

  const parseStdioArgs = (raw: string): string[] => {
    if (!raw.trim()) return [];
    const args: string[] = [];
    const regex = /[^\s"]+|"([^"]*)"/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      args.push(match[1] ?? match[0]);
    }
    return args;
  };

  const parseStdioEnv = (raw: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  };

  const handleAddStdio = useCallback(async () => {
    const cmd = stdioCommand.trim();
    if (!cmd) return;
    setStdioAdding(true);
    setStdioError(null);
    const displayName = stdioIdentity.name.trim() || cmd;
    const slugNamespace = slugifyNamespace(stdioIdentity.namespace);
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        targetScope: scopeId,
        transport: "stdio" as const,
        name: displayName,
        namespace: slugNamespace || undefined,
        command: cmd,
        args: parseStdioArgs(stdioArgs),
        env: parseStdioEnv(stdioEnv),
      },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setStdioError(errorMessageFromExit(exit, "Failed to add source"));
      setStdioAdding(false);
      return;
    }
    props.onComplete();
  }, [stdioCommand, stdioArgs, stdioEnv, stdioIdentity, doAdd, scopeId, props]);

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add MCP Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect to an MCP server to discover and use its tools.
        </p>
      </div>

      {/* Transport toggle — only shown when stdio is enabled server-side */}
      {allowStdio && (
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setTransport("remote")}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              transport === "remote"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Remote
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => setTransport("stdio")}
            className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              transport === "stdio"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Stdio
          </Button>
        </div>
      )}

      {transport === "remote" ? (
        <>
          <McpRemoteSourceFields
            url={state.url}
            onUrlChange={(url) => dispatch({ type: "set-url", url })}
            identity={remoteIdentity}
            preview={probe}
            probing={isProbing}
            error={probeError}
            onRetry={handleProbe}
          />

          <HttpCredentialsEditor
            credentials={remoteCredentials}
            onChange={handleRemoteCredentialsChange}
            existingSecrets={secretList}
            sourceName={remoteIdentity.name}
            targetScope={requestCredentialTargetScope}
            credentialScopeOptions={credentialScopeOptions}
            bindingScopeOptions={credentialScopeOptions}
            labels={{
              headers: "Request headers",
              queryParams: "Query parameters",
            }}
          />

          {/* Authentication */}
          {probe && (
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Authentication</FieldLabel>
                <FilterTabs<RemoteAuthMode>
                  tabs={
                    probe.requiresOAuth && probe.supportsDynamicRegistration
                      ? [{ value: "oauth2", label: "OAuth" }]
                      : [
                          { value: "none", label: "None" },
                          { value: "oauth2", label: "OAuth" },
                        ]
                  }
                  value={remoteAuthMode}
                  onChange={setRemoteAuthMode}
                />
              </div>

              {remoteAuthMode === "oauth2" && (
                <CredentialUsageRow
                  value={oauthCredentialTargetScope}
                  options={credentialScopeOptions}
                  onChange={(targetScope) => {
                    setOAuthCredentialTargetScope(targetScope);
                    dispatch({ type: "oauth-reset" });
                  }}
                  label="Connection saved to"
                  help="Choose who can use the OAuth connection."
                >
                  <CredentialControlField
                    label="Connect via OAuth"
                    help="Start the provider OAuth flow."
                  >
                    {!tokens &&
                      state.step === "probed" &&
                      (probe.supportsDynamicRegistration ? (
                        <Button
                          type="button"
                          onClick={handleOAuth}
                          variant="outline"
                          className="w-full"
                        >
                          Sign in
                        </Button>
                      ) : (
                        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          This server requires OAuth, but its authorization server does not support
                          dynamic client registration. Use request headers with a bearer token, or
                          save the source and connect a supported OAuth connection later.
                        </div>
                      ))}

                    {!tokens && state.step === "oauth-starting" && (
                      <div className="flex min-h-9 items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                        <Spinner className="size-3.5" />
                        <span className="text-xs text-muted-foreground">
                          Starting authorization...
                        </span>
                      </div>
                    )}

                    {!tokens && state.step === "oauth-waiting" && (
                      <div className="flex min-h-9 items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2">
                        <Spinner className="size-3.5 text-blue-500" />
                        <span className="text-xs text-blue-600 dark:text-blue-400">
                          Waiting for authorization...
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={handleCancelOAuth}
                          className="ml-auto h-7 px-2 text-xs"
                        >
                          Cancel
                        </Button>
                      </div>
                    )}

                    {tokens && (
                      <div className="flex min-h-9 items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
                        <svg viewBox="0 0 16 16" fill="none" className="size-3.5 text-emerald-500">
                          <path
                            d="M3 8.5l3 3 7-7"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          Authenticated
                        </span>
                      </div>
                    )}
                  </CredentialControlField>
                </CredentialUsageRow>
              )}
            </section>
          )}

          {/* Additional headers */}
          {probe && (
            <section className="space-y-2.5">
              <div>
                <Label>Additional headers</Label>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Plaintext headers sent with every request. Use request headers above for
                  secret-backed values.
                </p>
              </div>

              <CardStack>
                <CardStackContent>
                  {remoteHeaders.length === 0 ? (
                    <AddPlainHeaderRow
                      leading={<span>No headers</span>}
                      onClick={() =>
                        setRemoteHeaders((headers) => [...headers, { name: "", value: "" }])
                      }
                    />
                  ) : (
                    <>
                      {remoteHeaders.map((header, index) => (
                        <CardStackEntry key={index} className="flex-col items-stretch gap-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Header
                            </Label>
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setRemoteHeaders((headers) =>
                                  headers.filter((_, headerIndex) => headerIndex !== index),
                                )
                              }
                            >
                              Remove
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Name
                              </Label>
                              <Input
                                value={header.name}
                                onChange={(event) =>
                                  setRemoteHeaders((headers) =>
                                    headers.map((current, headerIndex) =>
                                      headerIndex === index
                                        ? {
                                            ...current,
                                            name: (event.target as HTMLInputElement).value,
                                          }
                                        : current,
                                    ),
                                  )
                                }
                                placeholder="X-Organization-Id"
                                className="h-8 text-xs font-mono"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Value
                              </Label>
                              <Input
                                value={header.value}
                                onChange={(event) =>
                                  setRemoteHeaders((headers) =>
                                    headers.map((current, headerIndex) =>
                                      headerIndex === index
                                        ? {
                                            ...current,
                                            value: (event.target as HTMLInputElement).value,
                                          }
                                        : current,
                                    ),
                                  )
                                }
                                placeholder="workspace-id"
                                className="h-8 text-xs font-mono"
                              />
                            </div>
                          </div>
                        </CardStackEntry>
                      ))}
                      <AddPlainHeaderRow
                        onClick={() =>
                          setRemoteHeaders((headers) => [...headers, { name: "", value: "" }])
                        }
                      />
                    </>
                  )}
                </CardStackContent>
              </CardStack>
            </section>
          )}

          {/* Error (OAuth / add source). Probe errors show inline on the field. */}
          {otherError && (
            <div className="space-y-2">
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[12px] text-destructive">{otherError}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: "retry" })}
                className="text-xs"
              >
                Try again
              </Button>
            </div>
          )}

          <FloatActions>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                oauth.cancel();
                props.onCancel();
              }}
              disabled={isAdding}
            >
              Cancel
            </Button>
            {(probe || isProbing) && (
              <Button type="button" onClick={handleAddRemote} disabled={!canAdd}>
                {isAdding ? (
                  <>
                    <Spinner className="size-3.5" /> Adding…
                  </>
                ) : (
                  "Add source"
                )}
              </Button>
            )}
          </FloatActions>
        </>
      ) : (
        <>
          {/* Stdio form */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField
                label="Command"
                description="- The executable to run (e.g. npx, uvx, node)."
              >
                <Input
                  value={stdioCommand}
                  onChange={(e) => setStdioCommand((e.target as HTMLInputElement).value)}
                  placeholder="npx"
                  className="font-mono text-sm"
                />
              </CardStackEntryField>

              <CardStackEntryField
                label="Arguments"
                description="- Space-separated arguments passed to the command."
              >
                <Input
                  value={stdioArgs}
                  onChange={(e) => setStdioArgs((e.target as HTMLInputElement).value)}
                  placeholder="-y chrome-devtools-mcp@latest"
                  className="font-mono text-sm"
                />
              </CardStackEntryField>

              <CardStackEntryField
                label="Environment variables"
                description="- One per line, KEY=value format."
              >
                <Textarea
                  value={stdioEnv}
                  onChange={(e) => setStdioEnv((e.target as HTMLTextAreaElement).value)}
                  placeholder={"KEY=value\nANOTHER=value"}
                  rows={3}
                  maxRows={10}
                  className="font-mono text-sm"
                />
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <SourceIdentityFields identity={stdioIdentity} namePlaceholder="My MCP Server" />

          {/* Stdio error */}
          {stdioError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{stdioError}</p>
            </div>
          )}

          <FloatActions>
            <Button type="button" variant="ghost" onClick={props.onCancel} disabled={stdioAdding}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAddStdio}
              disabled={!stdioCommand.trim() || stdioAdding}
            >
              {stdioAdding ? (
                <>
                  <Spinner className="size-3.5" /> Adding…
                </>
              ) : (
                "Add source"
              )}
            </Button>
          </FloatActions>
        </>
      )}
    </div>
  );
}

function AddPlainHeaderRow({
  onClick,
  leading,
}: {
  readonly onClick: () => void;
  readonly leading?: ReactNode;
}) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label="Add header"
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1 text-left">{leading}</span>
      <svg aria-hidden viewBox="0 0 16 16" fill="none" className="size-4 shrink-0">
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}
