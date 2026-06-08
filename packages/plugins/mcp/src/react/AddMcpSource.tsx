import { useReducer, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { integrationsOptimisticAtom } from "@executor-js/react/api/atoms";
import { Button } from "@executor-js/react/components/button";
import {
  AuthTemplateEditor,
  type AuthTemplateEditorKind,
  type AuthTemplateEditorValue,
} from "@executor-js/react/components/auth-template-editor";
import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "@executor-js/react/components/card-stack";
import { FieldLabel } from "@executor-js/react/components/field";
import { FloatActions } from "@executor-js/react/components/float-actions";
import { Input } from "@executor-js/react/components/input";
import { Spinner } from "@executor-js/react/components/spinner";
import { Textarea } from "@executor-js/react/components/textarea";
import {
  integrationDisplayNameFromUrl,
  slugifyNamespace,
  IntegrationIdentityFields,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { probeMcpEndpoint, addMcpServer } from "./atoms";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import { mcpAuthTemplateFromEditorValue } from "./auth-method-config";
import { mcpPresets, type McpPreset } from "../sdk/presets";

// Post-redesign the remote add flow only REGISTERS the auth template through the
// shared `AuthTemplateEditor` — accounts (the API key value / OAuth sign-in) are
// added later from the integration's detail hub (P6: add without auth, connect
// later). An OAuth-only server (DCR-capable) is constrained to the OAuth tab.

const ErrorMessage = Schema.Struct({ message: Schema.String });
const decodeErrorMessage = Schema.decodeUnknownOption(ErrorMessage);
const STDIO_ENV_ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "\\": "\\",
  n: "\n",
  r: "\r",
  t: "\t",
  '"': '"',
};

const errorMessageFromExit = (exit: Exit.Exit<unknown, unknown>, fallback: string): string =>
  Option.match(Option.flatMap(Exit.findErrorOption(exit), decodeErrorMessage), {
    onNone: () => fallback,
    onSome: ({ message }) => message,
  });

const isIntegrationAlreadyExistsExit = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Option.match(Exit.findErrorOption(exit), {
    onNone: () => false,
    onSome: Predicate.isTagged("IntegrationAlreadyExistsError"),
  });

const integrationExistsMessage = (slug: string): string =>
  `An integration named "${slug}" already exists. To add more authentication, update your existing integration.`;

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

type ProbeResult = {
  connected: boolean;
  requiresOAuth: boolean;
  supportsDynamicRegistration: boolean;
  name: string;
  slug: string;
  toolCount: number | null;
  serverName: string | null;
};

type State =
  | { step: "url"; url: string }
  | { step: "probing"; url: string; probe: ProbeResult | null }
  | { step: "probed"; url: string; probe: ProbeResult }
  | { step: "adding"; url: string; probe: ProbeResult }
  | {
      step: "error";
      url: string;
      probe: ProbeResult | null;
      error: string;
    };

type Action =
  | { type: "set-url"; url: string }
  | { type: "probe-start" }
  | { type: "probe-ok"; probe: ProbeResult }
  | { type: "probe-fail"; error: string }
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
        error: a.error,
      }),
    ),
    Match.discriminator("type")("add-start", (): State => {
      const probe = "probe" in state ? state.probe : null;
      if (!probe) return state;
      return { step: "adding", url: state.url, probe };
    }),
    Match.discriminator("type")("add-fail", (a): State => {
      if (state.step !== "adding") return state;
      return {
        step: "error",
        url: state.url,
        probe: state.probe,
        error: a.error,
      };
    }),
    Match.discriminator("type")("retry", (): State => {
      if (state.step !== "error") return state;
      return state.probe
        ? { step: "probed", url: state.url, probe: state.probe }
        : { step: "url", url: state.url };
    }),
    Match.exhaustive,
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AddMcpSource(props: {
  onComplete: (slug?: string) => void;
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
  const stdioIdentity = useIntegrationIdentity({
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

  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promiseExit" });
  const doAddServer = useAtomSet(addMcpServer, { mode: "promiseExit" });

  const [authValue, setAuthValue] = useState<AuthTemplateEditorValue>({ kind: "none" });

  const probe = "probe" in state ? state.probe : null;

  // OAuth-only servers (DCR-capable) constrain the editor to the OAuth tab; all
  // other servers offer none / API key / OAuth (matching the prior tab set).
  const allowedAuthKinds: readonly AuthTemplateEditorKind[] =
    probe?.requiresOAuth && probe.supportsDynamicRegistration
      ? ["oauth"]
      : ["none", "apikey", "oauth"];

  const remoteIdentity = useIntegrationIdentity({
    fallbackName:
      integrationDisplayNameFromUrl(state.url, "MCP") ?? probe?.serverName ?? probe?.name ?? "",
  });
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";

  // Pre-empt the API's `IntegrationAlreadyExistsError`: adding an integration
  // whose slug already exists clobbers the existing one's connections/policies,
  // so the API blocks it. Surface that here from the tenant-scoped catalog list.
  // A blank derived namespace lets the server assign the slug, so only flag a
  // collision when the user-derived slug is non-empty.
  const integrationsResult = useAtomValue(integrationsOptimisticAtom);
  const existingSlugs = useMemo(
    () =>
      AsyncResult.isSuccess(integrationsResult)
        ? integrationsResult.value.map((integration) => String(integration.slug))
        : [],
    [integrationsResult],
  );
  const remoteSlug = slugifyNamespace(remoteIdentity.namespace);
  const stdioSlug = slugifyNamespace(stdioIdentity.namespace);
  const remoteSlugExists = remoteSlug.length > 0 && existingSlugs.includes(remoteSlug);
  const stdioSlugExists = stdioSlug.length > 0 && existingSlugs.includes(stdioSlug);

  const canAdd = Boolean(probe) && !isAdding && !remoteSlugExists;
  // Probe failures are shown inline on the URL field; other failures
  // (add server) render in the bottom error block.
  const probeError = state.step === "error" && state.probe === null ? state.error : null;
  const otherError = state.step === "error" && state.probe !== null ? state.error : null;

  // ---- Remote actions ----

  const handleProbe = useCallback(async () => {
    dispatch({ type: "probe-start" });
    const exit = await doProbe({
      payload: { endpoint: state.url.trim() },
    });
    if (Exit.isFailure(exit)) {
      dispatch({
        type: "probe-fail",
        error: errorMessageFromExit(exit, "Failed to connect"),
      });
      return;
    }
    setAuthValue(
      exit.value.requiresOAuth
        ? { kind: "oauth", authorizationUrl: "", tokenUrl: "", scopes: [] }
        : { kind: "none" },
    );
    dispatch({ type: "probe-ok", probe: exit.value });
  }, [state.url, doProbe]);

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

  // Register the integration with the chosen auth template, returning the
  // assigned slug (or null on failure — an error is dispatched in that case).
  const registerIntegration = useCallback(
    async (
      auth:
        | { kind: "none" }
        | { kind: "header"; headerName: string; prefix?: string }
        | { kind: "oauth2" },
    ): Promise<string | null> => {
      const displayName = remoteIdentity.name.trim() || probe?.serverName || probe?.name || "MCP";
      const slug = slugifyNamespace(remoteIdentity.namespace) || undefined;
      const exit = await doAddServer({
        payload: {
          transport: "remote" as const,
          name: displayName,
          endpoint: state.url.trim(),
          ...(slug ? { slug } : {}),
          auth,
        },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        dispatch({
          type: "add-fail",
          error: isIntegrationAlreadyExistsExit(exit)
            ? integrationExistsMessage(slug ?? displayName)
            : errorMessageFromExit(exit, "Failed to add server"),
        });
        return null;
      }
      return exit.value.slug;
    },
    [doAddServer, probe, remoteIdentity, state.url],
  );

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    const slug = await registerIntegration(mcpAuthTemplateFromEditorValue(authValue));
    if (slug === null) return;
    props.onComplete(slug);
  }, [probe, authValue, registerIntegration, props]);

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

  const parseStdioEnvValue = (raw: string): string => {
    const value = raw.trim();
    if (value.length < 2) return value;

    const quote = value[0];
    if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) {
      return value;
    }

    const inner = value.slice(1, -1);
    if (quote === "'") return inner;

    return inner.replace(
      /\\([\\nrt"])/g,
      (_, escaped: string) => STDIO_ENV_ESCAPE_REPLACEMENTS[escaped] ?? escaped,
    );
  };

  const parseStdioEnv = (raw: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = parseStdioEnvValue(line.slice(eq + 1));
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
    const slug = slugifyNamespace(stdioIdentity.namespace) || undefined;
    const exit = await doAddServer({
      payload: {
        transport: "stdio" as const,
        name: displayName,
        ...(slug ? { slug } : {}),
        command: cmd,
        args: parseStdioArgs(stdioArgs),
        env: parseStdioEnv(stdioEnv),
      },
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setStdioError(
        isIntegrationAlreadyExistsExit(exit)
          ? integrationExistsMessage(slug ?? displayName)
          : errorMessageFromExit(exit, "Failed to add server"),
      );
      setStdioAdding(false);
      return;
    }
    props.onComplete(exit.value.slug);
  }, [stdioCommand, stdioArgs, stdioEnv, stdioIdentity, doAddServer, props]);

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

          {/* Authentication — declares the auth template to register through the
              shared editor. The credential itself (API key value / OAuth sign-in)
              is added from the integration's detail hub after adding. */}
          {probe && (
            <section className="space-y-2.5">
              <FieldLabel>How does this server authenticate?</FieldLabel>
              <AuthTemplateEditor
                value={authValue}
                onChange={setAuthValue}
                allowedKinds={allowedAuthKinds}
              />
            </section>
          )}

          {/* Error (add server). Probe errors show inline on the field. */}
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

          {remoteSlugExists && !isAdding && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">
                An integration named &quot;{remoteSlug}&quot; already exists. To add more
                authentication, update your existing integration.{" "}
                <Link
                  to="/integrations/$namespace"
                  params={{ namespace: remoteSlug }}
                  className="font-medium underline underline-offset-2"
                >
                  Open it
                </Link>
              </p>
            </div>
          )}

          <FloatActions>
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onCancel()}
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

          <IntegrationIdentityFields identity={stdioIdentity} namePlaceholder="My MCP Server" />

          {/* Stdio error */}
          {stdioError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">{stdioError}</p>
            </div>
          )}

          {stdioSlugExists && !stdioAdding && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[12px] text-destructive">
                An integration named &quot;{stdioSlug}&quot; already exists. To add more
                authentication, update your existing integration.{" "}
                <Link
                  to="/integrations/$namespace"
                  params={{ namespace: stdioSlug }}
                  className="font-medium underline underline-offset-2"
                >
                  Open it
                </Link>
              </p>
            </div>
          )}

          <FloatActions>
            <Button
              type="button"
              variant="ghost"
              onClick={() => props.onCancel()}
              disabled={stdioAdding}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleAddStdio}
              disabled={!stdioCommand.trim() || stdioAdding || stdioSlugExists}
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
