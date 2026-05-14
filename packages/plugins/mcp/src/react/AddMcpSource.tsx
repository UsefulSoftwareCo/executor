import { useReducer, useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { useScope } from "@executor-js/react/api/scope-context";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Spinner } from "@executor-js/react/components/spinner";
import { Textarea } from "@executor-js/react/components/textarea";
import {
  emptyHttpCredentials,
  HttpCredentials,
  httpCredentialsValid,
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
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import { OAuthConnectionControl } from "@executor-js/react/plugins/source-oauth-connection";

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
  return Match.value(action).pipe(
    Match.discriminator("type")("set-url", (a): State => ({ step: "url", url: a.url })),
    Match.discriminator("type")(
      "probe-start",
      (): State => ({
        step: "probing",
        url: state.url,
        probe: "probe" in state ? state.probe : null,
      }),
    ),
    Match.discriminator("type")(
      "probe-ok",
      (a): State => ({ step: "probed", url: state.url, probe: a.probe }),
    ),
    Match.discriminator("type")(
      "probe-fail",
      (a): State => ({
        step: "error",
        url: state.url,
        probe: null,
        tokens: null,
        error: a.error,
      }),
    ),
    Match.discriminator("type")("oauth-start", (): State => {
      if (state.step !== "probed" && state.step !== "error") return state;
      return {
        step: "oauth-starting",
        url: state.url,
        probe: state.step === "probed" ? state.probe : state.probe!,
      };
    }),
    Match.discriminator("type")("oauth-waiting", (a): State => {
      if (state.step !== "oauth-starting") return state;
      return {
        step: "oauth-waiting",
        url: state.url,
        probe: state.probe,
        sessionId: a.sessionId,
      };
    }),
    Match.discriminator("type")("oauth-ok", (a): State => {
      if (state.step !== "oauth-waiting") return state;
      return {
        step: "oauth-done",
        url: state.url,
        probe: state.probe,
        tokens: a.tokens,
      };
    }),
    Match.discriminator("type")("oauth-fail", (a): State => {
      if (state.step !== "oauth-starting" && state.step !== "oauth-waiting") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: null,
        error: a.error,
      };
    }),
    Match.discriminator("type")("oauth-cancelled", (): State => {
      if (state.step !== "oauth-waiting") return state;
      return { step: "probed", url: state.url, probe: state.probe };
    }),
    Match.discriminator("type")("oauth-reset", (): State => {
      if ("probe" in state && state.probe) {
        return { step: "probed", url: state.url, probe: state.probe };
      }
      return state;
    }),
    Match.discriminator("type")("add-start", (): State => {
      const tokens =
        state.step === "oauth-done" ? state.tokens : state.step === "probed" ? null : null;
      const probe = "probe" in state ? state.probe : null;
      if (!probe) return state;
      return { step: "adding", url: state.url, probe, tokens };
    }),
    Match.discriminator("type")("add-fail", (a): State => {
      if (state.step !== "adding") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        tokens: state.tokens,
        error: a.error,
      };
    }),
    Match.discriminator("type")("retry", (): State => {
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
    }),
    Match.exhaustive,
  );
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
  const remoteCredentialsComplete = httpCredentialsValid(remoteCredentials);
  const authReady = remoteAuthMode === "none" ? canUseNone : tokens !== null;
  const canAdd =
    Boolean(probe) && authReady && remoteCredentialsComplete && !isAdding && !isOAuthBusy;
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
    const credentials = serializeScopedHttpCredentials(
      remoteCredentials,
      requestCredentialTargetScope,
    );
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
        ...(Object.keys(credentials.headers).length > 0
          ? { headers: credentials.headers as Record<string, McpCredentialInput> }
          : {}),
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

          <HttpCredentials.Root
            credentials={remoteCredentials}
            onChange={handleRemoteCredentialsChange}
            existingSecrets={secretList}
            sourceName={remoteIdentity.name}
            targetScope={requestCredentialTargetScope}
            credentialScopeOptions={credentialScopeOptions}
            bindingScopeOptions={credentialScopeOptions}
          >
            <HttpCredentials.Headers label="Request headers" />
            <HttpCredentials.QueryParams label="Query parameters" />
          </HttpCredentials.Root>

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
                <OAuthConnectionControl
                  tokenScope={oauthCredentialTargetScope}
                  credentialScopeOptions={credentialScopeOptions}
                  onTokenScopeChange={(targetScope) => {
                    setOAuthCredentialTargetScope(targetScope);
                    dispatch({ type: "oauth-reset" });
                  }}
                  label="Connect via OAuth"
                  status={
                    tokens
                      ? { kind: "connected", label: "Authenticated" }
                      : state.step === "oauth-starting"
                        ? { kind: "busy", label: "Starting authorization..." }
                        : state.step === "oauth-waiting"
                          ? { kind: "busy", label: "Waiting for authorization..." }
                          : state.step === "probed" && !probe.supportsDynamicRegistration
                            ? {
                                kind: "blocked",
                                label:
                                  "This server requires OAuth, but its authorization server does not support dynamic client registration. Use request headers with a bearer token, or save the source and connect a supported OAuth connection later.",
                              }
                            : { kind: "idle" }
                  }
                >
                  {!tokens && state.step === "probed" && probe.supportsDynamicRegistration && (
                    <Button type="button" onClick={handleOAuth} variant="outline" size="sm">
                      Sign in
                    </Button>
                  )}
                  {!tokens && state.step === "oauth-waiting" && (
                    <Button type="button" variant="ghost" size="sm" onClick={handleCancelOAuth}>
                      Cancel
                    </Button>
                  )}
                </OAuthConnectionControl>
              )}
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
