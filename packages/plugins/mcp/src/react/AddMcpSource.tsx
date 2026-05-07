import { useReducer, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryMedia,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import { FieldError, FieldLabel } from "@executor-js/react/components/field";
import { FilterTabs } from "@executor-js/react/components/filter-tabs";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";
import { Badge } from "@executor-js/react/components/badge";
import { Skeleton } from "@executor-js/react/components/skeleton";
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import { IOSSpinner, Spinner } from "@executor-js/react/components/spinner";
import { Textarea } from "@executor-js/react/components/textarea";
import { HeadersList } from "@executor-js/react/plugins/headers-list";
import {
  emptyHttpCredentials,
  httpCredentialsValid,
  HttpCredentialsEditor,
  serializeHttpCredentials,
  type SecretBackedValue,
} from "@executor-js/react/plugins/http-credentials";
import { type HeaderState } from "@executor-js/react/plugins/secret-header-auth";
import {
  displayNameFromUrl,
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

type RemoteAuthMode = "none" | "header" | "oauth2";
import { sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { probeMcpEndpoint, addMcpSourceOptimistic } from "./atoms";
import { mcpPresets, type McpPreset } from "../sdk/presets";

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
  | { step: "probing"; url: string }
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
  | { type: "add-start" }
  | { type: "add-fail"; error: string }
  | { type: "retry" };

const init: State = { step: "url", url: "" };

function reducer(state: State, action: Action): State {
  return Match.value(action).pipe(
    Match.discriminator("type")("set-url", (a): State => ({ step: "url", url: a.url })),
    Match.discriminator("type")("probe-start", (): State => ({ step: "probing", url: state.url })),
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
  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promiseExit" });
  const doAdd = useAtomSet(addMcpSourceOptimistic(scopeId), { mode: "promiseExit" });
  const secretList = useSecretPickerSecrets();
  const oauth = useOAuthPopupFlow<OAuthCompletionPayload>({
    popupName: "mcp-oauth",
    popupBlockedMessage: "OAuth popup was blocked",
    startErrorMessage: "Failed to start OAuth",
  });

  const [remoteAuthMode, setRemoteAuthMode] = useState<RemoteAuthMode>("none");
  const [remoteAuthHeaders, setRemoteAuthHeaders] = useState<HeaderState[]>([
    {
      name: "Authorization",
      prefix: "Bearer ",
      presetKey: "bearer",
      secretId: null,
    },
  ]);
  const [remoteHeaders, setRemoteHeaders] = useState<PlainHeader[]>([]);
  const [remoteCredentials, setRemoteCredentials] = useState(() => emptyHttpCredentials());

  const probe = "probe" in state ? state.probe : null;
  const tokens = "tokens" in state ? state.tokens : null;

  const remoteIdentity = useSourceIdentity({
    fallbackName: probe?.serverName ?? probe?.name ?? displayNameFromUrl(state.url) ?? "",
  });
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";
  const isOAuthBusy =
    state.step === "oauth-starting" || state.step === "oauth-waiting" || oauth.busy;
  const canUseNone = probe?.requiresOAuth !== true;
  const remoteAuthHeader = remoteAuthHeaders[0];
  const headerAuthComplete = Boolean(remoteAuthHeader?.name.trim() && remoteAuthHeader?.secretId);
  const remoteHeadersComplete = remoteHeaders.every(
    (header) => header.name.trim() && header.value.trim(),
  );
  const remoteCredentialsComplete = httpCredentialsValid(remoteCredentials);
  // OAuth is "ready to save" even without tokens — the source is stored
  // with a stable connectionId pointer, and each user completes their
  // own sign-in via McpSignInButton on the source detail page (per-user
  // scope shadowing means each user's tokens land at their own scope).
  const authReady =
    remoteAuthMode === "none"
      ? canUseNone
      : remoteAuthMode === "header"
        ? headerAuthComplete
        : true;
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
  }, [transport, state.step, state.url, remoteCredentials]);

  const handleRemoteCredentialsChange = useCallback(
    (next: typeof remoteCredentials) => {
      setRemoteCredentials(next);
      if (state.step === "error" || state.step === "probed" || state.step === "oauth-done") {
        dispatch({ type: "set-url", url: state.url });
      }
    },
    [state],
  );

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
  }, [state.url, remoteIdentity, probe, remoteCredentials, oauth]);

  const handleCancelOAuth = useCallback(() => {
    oauth.cancel();
    dispatch({ type: "oauth-cancelled" });
  }, [oauth]);

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    const headerAuth = remoteAuthHeaders[0];
    // For oauth2 sources saved without completing the flow, use the
    // same stable connectionId the handleOAuth path would have used.
    // This pins the source's auth pointer, so when a per-user sign-in
    // runs later (via McpSignInButton) it mints the connection at the
    // user scope against the same id — innermost-wins shadowing then
    // resolves tokens per-user at invoke time.
    const deferredOAuthConnectionId = oauthConnectionId({
      pluginId: "mcp",
      namespace:
        slugifyNamespace(remoteIdentity.namespace) ||
        slugifyNamespace(probe.namespace ?? "") ||
        "mcp",
    });
    const auth =
      remoteAuthMode === "header" && headerAuth?.secretId
        ? {
            kind: "header" as const,
            headerName: headerAuth.name.trim(),
            secretId: headerAuth.secretId,
            ...(headerAuth.prefix ? { prefix: headerAuth.prefix } : {}),
          }
        : remoteAuthMode === "oauth2"
          ? {
              kind: "oauth2" as const,
              connectionId: tokens?.connectionId ?? deferredOAuthConnectionId,
            }
          : { kind: "none" as const };
    const headers = Object.fromEntries(
      remoteHeaders
        .map((header) => [header.name.trim(), header.value.trim()] as const)
        .filter(([name, value]) => name && value),
    );
    const credentials = serializeHttpCredentials(remoteCredentials);
    const remoteRequestHeaders: Record<string, SecretBackedValue> = {
      ...headers,
      ...credentials.headers,
    };
    const displayName = remoteIdentity.name.trim() || probe.serverName || probe.name;
    const slugNamespace = slugifyNamespace(remoteIdentity.namespace);
    const exit = await doAdd({
      params: { scopeId },
      payload: {
        transport: "remote" as const,
        name: displayName,
        namespace: slugNamespace || undefined,
        endpoint: state.url.trim(),
        auth,
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
    remoteAuthHeaders,
    remoteHeaders,
    remoteCredentials,
    remoteIdentity,
    tokens,
    state.url,
    doAdd,
    props,
    scopeId,
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
          {/* Server info card (shown above URL input after probing) */}
          {probe ? (
            <CardStack>
              <CardStackContent className="border-t-0">
                <CardStackEntry>
                  <CardStackEntryMedia>
                    <SourceFavicon url={state.url} size={32} />
                  </CardStackEntryMedia>
                  <CardStackEntryContent>
                    <CardStackEntryTitle>{probe.serverName ?? probe.name}</CardStackEntryTitle>
                    <CardStackEntryDescription>
                      {probe.connected
                        ? `${probe.toolCount} tool${probe.toolCount !== 1 ? "s" : ""} available`
                        : "OAuth required to discover tools"}
                    </CardStackEntryDescription>
                  </CardStackEntryContent>
                  <CardStackEntryActions>
                    {probe.connected ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                      >
                        Connected
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-amber-500/20 bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400"
                      >
                        OAuth required
                      </Badge>
                    )}
                  </CardStackEntryActions>
                </CardStackEntry>
              </CardStackContent>
            </CardStack>
          ) : isProbing ? (
            <CardStack>
              <CardStackContent className="border-t-0">
                <CardStackEntry>
                  <CardStackEntryMedia>
                    <Skeleton className="size-4 rounded" />
                  </CardStackEntryMedia>
                  <CardStackEntryContent>
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-1 h-3 w-32" />
                  </CardStackEntryContent>
                  <CardStackEntryActions>
                    <Skeleton className="h-4 w-20 rounded-full" />
                  </CardStackEntryActions>
                </CardStackEntry>
              </CardStackContent>
            </CardStack>
          ) : null}

          {/* URL input */}
          <CardStack>
            <CardStackContent className="border-t-0">
              <CardStackEntryField
                label="Server URL"
                hint={probeError ? undefined : "Supports Streamable HTTP and SSE transports."}
              >
                <div className="relative">
                  <Input
                    value={state.url}
                    onChange={(e) =>
                      dispatch({
                        type: "set-url",
                        url: (e.target as HTMLInputElement).value,
                      })
                    }
                    placeholder="https://mcp.example.com"
                    className="w-full pr-9 font-mono text-sm"
                    aria-invalid={probeError ? true : undefined}
                  />
                  {isProbing && (
                    <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                      <IOSSpinner className="size-4" />
                    </div>
                  )}
                </div>
                {probeError && (
                  <div className="mt-2 space-y-2">
                    <FieldError>{probeError}</FieldError>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleProbe}
                      className="h-7 px-2 text-xs"
                    >
                      Try again
                    </Button>
                  </div>
                )}
              </CardStackEntryField>
            </CardStackContent>
          </CardStack>

          <HttpCredentialsEditor
            credentials={remoteCredentials}
            onChange={handleRemoteCredentialsChange}
            existingSecrets={secretList}
            sourceName={remoteIdentity.name}
            targetScope={scopeId}
            labels={{
              headers: "Request headers",
              queryParams: "Query parameters",
            }}
          />

          {probe && (
            <SourceIdentityFields identity={remoteIdentity} namePlaceholder="e.g. Linear" />
          )}

          {/* Authentication */}
          {probe && (
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <FieldLabel>Authentication</FieldLabel>
                <FilterTabs<RemoteAuthMode>
                  tabs={
                    probe.requiresOAuth
                      ? [
                          { value: "header", label: "Header" },
                          { value: "oauth2", label: "OAuth" },
                        ]
                      : [
                          { value: "none", label: "None" },
                          { value: "header", label: "Header" },
                        ]
                  }
                  value={remoteAuthMode}
                  onChange={setRemoteAuthMode}
                />
              </div>

              {remoteAuthMode === "header" && (
                <HeadersList
                  headers={remoteAuthHeaders}
                  onHeadersChange={setRemoteAuthHeaders}
                  existingSecrets={secretList}
                  singleHeader
                  sourceName={remoteIdentity.name}
                />
              )}

              {remoteAuthMode === "oauth2" && (
                <>
                  {!tokens && state.step === "probed" && (
                    <div className="flex flex-col gap-2">
                      <Button onClick={handleOAuth} variant="outline">
                        Sign in
                      </Button>
                      <p className="text-[11px] text-muted-foreground">
                        Optional — you can save the source now and each user can sign in from the
                        source detail page later.
                      </p>
                    </div>
                  )}

                  {!tokens && state.step === "oauth-starting" && (
                    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5">
                      <Spinner className="size-3.5" />
                      <span className="text-xs text-muted-foreground">Starting authorization…</span>
                    </div>
                  )}

                  {!tokens && state.step === "oauth-waiting" && (
                    <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2.5">
                      <Spinner className="size-3.5 text-blue-500" />
                      <span className="text-xs text-blue-600 dark:text-blue-400">
                        Waiting for authorization in popup…
                      </span>
                      <Button
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
                    <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5">
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
                </>
              )}
            </section>
          )}

          {/* Additional headers */}
          {probe && (
            <section className="space-y-2.5">
              <div>
                <Label>Additional headers</Label>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  Plaintext headers sent with every request. Use authentication for secret-backed
                  auth headers.
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
              <Button onClick={handleAddRemote} disabled={!canAdd}>
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
            <Button variant="ghost" onClick={props.onCancel} disabled={stdioAdding}>
              Cancel
            </Button>
            <Button onClick={handleAddStdio} disabled={!stdioCommand.trim() || stdioAdding}>
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
