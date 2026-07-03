import { useReducer, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";

import { Button } from "@executor-js/react/components/button";
import {
  AuthMethodListEditor,
  useAuthMethodList,
  type AuthMethodRow,
  type AuthMethodSeed,
} from "@executor-js/react/components/auth-method-list-editor";
import { FloatActions } from "@executor-js/react/components/float-actions";
import {
  integrationDisplayNameFromUrl,
  slugifyNamespace,
  useIntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";
import {
  addIntegrationErrorMessage,
  errorMessageFromExit,
  FormErrorAlert,
  SlugCollisionAlert,
  useSlugAlreadyExists,
} from "@executor-js/react/lib/integration-add";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import type { McpAuthMethodInput } from "../sdk/types";
import { probeMcpEndpoint, addMcpServer } from "./atoms";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import { mcpAuthMethodInputFromEditorValue, mcpWireAuthInput } from "./auth-method-config";
import { mcpPresets, type McpPreset } from "../sdk/presets";

// The remote add flow REGISTERS the server's declared auth methods through the
// shared `AuthMethodListEditor` — accounts (the API key value / OAuth sign-in)
// are added later from the integration's detail hub (P6: add without auth,
// connect later). The probe SEEDS the list (detected OAuth → an OAuth row; a
// 401 without OAuth → a bearer-header row; open server → a no-auth row) and
// the user can add alternate methods (e.g. an API key alongside OAuth, or a
// declared method on a server that advertises none).

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
  requiresAuthentication: boolean;
  requiresOAuth: boolean;
  supportsDynamicRegistration: boolean;
  name: string;
  slug: string;
  toolCount: number | null;
  serverName: string | null;
  instructions: string | null;
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
  basePath: string;
  onComplete: (slug: string) => void;
  onCancel: () => void;
  initialUrl?: string;
  initialPreset?: string;
  initialNamespace?: string;
  initialName?: string;
  initialDescription?: string;
}) {
  const preset = findPreset(props.initialPreset);
  const remoteUrl = preset?.url ?? props.initialUrl ?? "";
  const presetName = props.initialName ?? preset?.name;
  const presetDescription = props.initialDescription ?? preset?.summary;

  const [state, dispatch] = useReducer(
    reducer,
    remoteUrl ? { step: "url" as const, url: remoteUrl } : init,
  );

  const doProbe = useAtomSet(probeMcpEndpoint, { mode: "promiseExit" });
  const doAddServer = useAtomSet(addMcpServer, { mode: "promiseExit" });

  const probe = "probe" in state ? state.probe : null;

  // The probe seeds the method list: detected OAuth → an OAuth row; a 401
  // without OAuth metadata → a bearer-header row; an open server → a no-auth
  // row. The user can edit any row or add alternate methods alongside.
  const authMethodSeeds: readonly AuthMethodSeed[] = useMemo(() => {
    if (!probe) return [];
    if (probe.requiresOAuth) {
      return [
        {
          value: { kind: "oauth", authorizationUrl: "", tokenUrl: "", scopes: [] },
          label: "Detected",
        },
      ];
    }
    if (probe.requiresAuthentication) {
      return [
        {
          value: {
            kind: "apikey",
            placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
          },
          label: "Detected",
        },
      ];
    }
    return [{ value: { kind: "none" }, label: "Detected" }];
  }, [probe]);
  const authMethodList = useAuthMethodList(authMethodSeeds);

  const remoteIdentity = useIntegrationIdentity({
    fallbackName:
      presetName ??
      integrationDisplayNameFromUrl(state.url, "MCP") ??
      probe?.serverName ??
      probe?.name ??
      "",
    fallbackNamespace: props.initialNamespace,
  });
  // Agent-visible description: prefilled from the server's `instructions`
  // until the user types (null = untouched, keep deriving from the probe).
  const [descriptionDraft, setDescriptionDraft] = useState<string | null>(null);
  const resolvedDescription = descriptionDraft ?? presetDescription ?? probe?.instructions ?? "";
  const isProbing = state.step === "probing";
  const isAdding = state.step === "adding";

  // Pre-empt the API's `IntegrationAlreadyExistsError`: adding an integration
  // whose slug already exists clobbers the existing one's connections/policies,
  // so the API blocks it. Surface that here from the tenant-scoped catalog list.
  // A blank derived namespace lets the server assign the slug, so only flag a
  // collision when the user-derived slug is non-empty.
  const remoteSlug = slugifyNamespace(remoteIdentity.namespace);
  const remoteSlugExists = useSlugAlreadyExists(remoteSlug);

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
    dispatch({ type: "probe-ok", probe: exit.value });
  }, [state.url, doProbe]);

  // Keep the latest handleProbe in a ref so the debounced effect can call it
  // without depending on its identity (which changes every render).
  const handleProbeRef = useRef(handleProbe);
  handleProbeRef.current = handleProbe;

  // Auto-probe whenever the URL changes (debounced) while we're on the
  // URL step and not already probing/probed.
  useEffect(() => {
    if (state.step !== "url") return;
    const trimmed = state.url.trim();
    if (!trimmed) return;
    const handle = setTimeout(() => {
      handleProbeRef.current();
    }, 400);
    return () => clearTimeout(handle);
  }, [state.step, state.url]);

  // Register the integration with the declared auth methods, returning the
  // assigned slug (or null on failure — an error is dispatched in that case).
  const registerIntegration = useCallback(
    async (authenticationTemplate: readonly McpAuthMethodInput[]): Promise<string | null> => {
      const displayName = remoteIdentity.name.trim() || probe?.serverName || probe?.name || "MCP";
      const slug = slugifyNamespace(remoteIdentity.namespace) || undefined;
      const exit = await doAddServer({
        payload: {
          transport: "remote" as const,
          name: displayName,
          ...(resolvedDescription.trim().length > 0
            ? { description: resolvedDescription.trim() }
            : {}),
          endpoint: state.url.trim(),
          ...(slug ? { slug } : {}),
          authenticationTemplate,
        },
        reactivityKeys: integrationWriteKeys,
      });
      if (Exit.isFailure(exit)) {
        dispatch({
          type: "add-fail",
          error: addIntegrationErrorMessage(exit, slug ?? displayName, "Failed to add server"),
        });
        return null;
      }
      return exit.value.slug;
    },
    [doAddServer, probe, remoteIdentity, resolvedDescription, state.url],
  );

  const handleAddRemote = useCallback(async () => {
    if (!probe) return;
    dispatch({ type: "add-start" });
    // Every row registers as a declared method (a lone no-auth row registers
    // the open-server method). Slugs are assigned server-side by kind.
    const methods = authMethodList.rows.map((row: AuthMethodRow) =>
      mcpWireAuthInput(mcpAuthMethodInputFromEditorValue(row.value)),
    );
    const slug = await registerIntegration(
      methods.length > 0 ? methods : [{ kind: "none" as const }],
    );
    if (slug === null) return;
    props.onComplete(slug);
  }, [probe, authMethodList.rows, registerIntegration, props]);

  // ---- Render ----

  return (
    <div className="flex flex-1 flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Add MCP Source</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Connect to an MCP server to discover and use its tools.
        </p>
      </div>

      <McpRemoteSourceFields
        url={state.url}
        onUrlChange={(url) => dispatch({ type: "set-url", url })}
        identity={remoteIdentity}
        description={resolvedDescription}
        onDescriptionChange={setDescriptionDraft}
        preview={probe}
        probing={isProbing}
        error={probeError}
        onRetry={handleProbe}
      />

      {/* Authentication — declares the auth methods to register through the
          shared list editor. The credentials themselves (API key value /
          OAuth sign-in) are added from the integration's detail hub after
          adding. */}
      {probe && (
        <AuthMethodListEditor
          list={authMethodList}
          title="How does this server authenticate?"
          oauthMetadata="discovered"
          emptyHint="No methods declared. Add a method, or add the server without auth and connect from the integration page later."
          footerHint="Every method here is registered with the server. Connect an account from the integration page after adding."
        />
      )}

      {/* Error (add server). Probe errors show inline on the field. */}
      {otherError && (
        <div className="space-y-2">
          <FormErrorAlert message={otherError} />
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
        <SlugCollisionAlert basePath={props.basePath} slug={remoteSlug} />
      )}

      <FloatActions>
        <Button type="button" variant="ghost" onClick={() => props.onCancel()} disabled={isAdding}>
          Cancel
        </Button>
        {(probe || isProbing) && (
          <Button type="button" onClick={handleAddRemote} disabled={!canAdd} loading={isAdding}>
            Add source
          </Button>
        )}
      </FloatActions>
    </div>
  );
}
