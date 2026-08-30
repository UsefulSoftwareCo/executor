import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@executor-js/react/lib/utils";
import { Shell } from "./shell";
import { IntegrationsPage } from "./screens/integrations-page";
import { ConnectDialog } from "./screens/connect-dialog";
import { AddOpenApiPage } from "./screens/add-openapi-page";
import { IntegrationDetailPage } from "./screens/integration-detail";
import { AddAccountModal } from "./screens/add-account-modal";
import { flowSteps, type StepId } from "./flow";
import { stepState, type AccountModal, type ScreenView } from "./step-state";
import { NextFlow } from "./next-flow";
import {
  gmailAuthMethods,
  gmailIntegration,
  posthogAuthMethods,
  posthogIntegration,
  seededIntegrations,
  type DemoIntegration,
  type DemoPreset,
} from "./fixtures";

const posthogPreset: DemoPreset = {
  id: "posthog",
  name: "PostHog",
  summary: "Product analytics, events, feature flags, and insights.",
  icon: "https://integrations.sh/logo/posthog.com",
  url: "https://raw.githubusercontent.com/PostHog/posthog/master/openapi/openapi.json",
  pluginKey: "openapi",
  pluginLabel: "OpenAPI",
};

const stepFromHash = (): StepId => {
  const hash = globalThis.location?.hash.replace(/^#/, "") ?? "";
  return flowSteps.some((step) => step.id === hash) ? (hash as StepId) : "integrations-empty";
};

function CurrentFlowApp() {
  // Each screen is addressable as `#<step-id>`, so a specific screen can be
  // linked to directly rather than clicked toward. `[` and `]` step through.
  const [stepId, setStepId] = useState<StepId>(stepFromHash);
  const [overrides, setOverrides] = useState<{
    readonly integrations?: readonly DemoIntegration[];
    readonly connectOpen?: boolean;
    readonly accountModal?: AccountModal;
    readonly view?: ScreenView;
  }>({});

  const base = useMemo(() => stepState[stepId], [stepId]);
  const state = { ...base, ...overrides };

  const goToStep = useCallback((id: StepId) => {
    setStepId(id);
    setOverrides({});
    if (globalThis.location) globalThis.location.hash = id;
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setStepId(stepFromHash());
      setOverrides({});
    };
    globalThis.addEventListener("hashchange", onHashChange);
    return () => globalThis.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" && event.key !== "]") return;
      const index = flowSteps.findIndex((candidate) => candidate.id === stepId);
      const next = event.key === "]" ? index + 1 : index - 1;
      const target = flowSteps[next];
      if (target) goToStep(target.id);
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [stepId, goToStep]);

  const integrations = state.integrations ?? seededIntegrations;

  return (
    <>
      <Shell integrations={integrations}>
        {state.view === "integrations" && (
          <IntegrationsPage
            integrations={integrations}
            onConnect={() => setOverrides((prev) => ({ ...prev, connectOpen: true }))}
            onOpenIntegration={() => setOverrides((prev) => ({ ...prev, view: "detail" }))}
          />
        )}

        {state.view === "add" && (
          <AddOpenApiPage
            preset={posthogPreset}
            onCancel={() => goToStep("integrations-empty")}
            onComplete={() => goToStep("detail-accounts")}
          />
        )}

        {state.view === "detail" && (
          <IntegrationDetailPage
            integration={
              state.accountModal === "oauth-stuck" ? gmailIntegration : posthogIntegration
            }
            onAddConnection={() =>
              setOverrides((prev) => ({ ...prev, accountModal: "credential" }))
            }
          />
        )}
      </Shell>

      <ConnectDialog
        open={state.connectOpen === true}
        onOpenChange={(open) => setOverrides((prev) => ({ ...prev, connectOpen: open }))}
        onPickPreset={() => goToStep("add-openapi")}
        onPickPlugin={() => goToStep("add-openapi")}
        onPickCatalogEntry={() => goToStep("add-openapi")}
      />

      {state.accountModal !== "none" && (
        <AddAccountModal
          // Remount per variant: a modal that stays mounted across a step
          // change keeps the previous step's wizard position.
          key={state.accountModal}
          open
          onOpenChange={(open) =>
            setOverrides((prev) => ({ ...prev, accountModal: open ? prev.accountModal : "none" }))
          }
          integrationName={state.accountModal === "oauth-stuck" ? "Gmail" : "PostHog"}
          methods={state.accountModal === "oauth-stuck" ? gmailAuthMethods : posthogAuthMethods}
          initialStep={state.accountModal === "place" ? "place" : "validate"}
          stuckConnecting={state.accountModal === "oauth-stuck"}
          onAdded={() => goToStep("integrations-populated")}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mode switch
//
// Both flows run in the same console chrome, so the comparison is about the
// flow rather than the styling. The switch is a small floating control rather
// than a panel: it is scaffolding for looking at the prototype, and it should
// not take width away from the thing being looked at.
// ---------------------------------------------------------------------------

type Mode = "current" | "next";

function ModeSwitch(props: { readonly mode: Mode; readonly onChange: (mode: Mode) => void }) {
  const option = (mode: Mode, label: string) => (
    // oxlint-disable-next-line react/forbid-elements
    <button
      key={mode}
      type="button"
      onClick={() => props.onChange(mode)}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
        props.mode === mode
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-full border border-border bg-card/95 p-1 shadow-lg backdrop-blur-sm">
      {option("current", "Current")}
      {option("next", "Reworked")}
    </div>
  );
}

const modeFromHash = (): Mode => {
  const hash = globalThis.location?.hash ?? "";
  return hash.startsWith("#reworked") || hash.startsWith("#next") ? "next" : "current";
};

export function App() {
  const [mode, setMode] = useState<Mode>(modeFromHash);

  useEffect(() => {
    const onHashChange = () => setMode(modeFromHash());
    globalThis.addEventListener("hashchange", onHashChange);
    return () => globalThis.removeEventListener("hashchange", onHashChange);
  }, []);

  const changeMode = (next: Mode) => {
    setMode(next);
    if (globalThis.location) {
      globalThis.location.hash = next === "next" ? "reworked" : "integrations-empty";
    }
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {mode === "next" ? <NextFlow /> : <CurrentFlowApp />}
      <ModeSwitch mode={mode} onChange={changeMode} />
    </div>
  );
}
