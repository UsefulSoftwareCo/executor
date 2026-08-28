import { useCallback, useEffect, useMemo, useState } from "react";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { cn } from "@executor-js/react/lib/utils";
import { Shell } from "./shell";
import { IntegrationsPage } from "./screens/integrations-page";
import { ConnectDialog } from "./screens/connect-dialog";
import { AddOpenApiPage } from "./screens/add-openapi-page";
import { IntegrationDetailPage } from "./screens/integration-detail";
import { AddAccountModal } from "./screens/add-account-modal";
import { flowSteps, type FlowStep, type StepId } from "./flow";
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

function Inspector(props: {
  readonly step: FlowStep;
  readonly onSelect: (id: StepId) => void;
  readonly onClose: () => void;
  readonly modeSwitch: React.ReactNode;
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        {props.modeSwitch}
        {/* oxlint-disable-next-line react/forbid-elements */}
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Hide inspector"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-px border-b border-border p-2">
        {flowSteps.map((step, index) => (
          // oxlint-disable-next-line react/forbid-elements
          <button
            key={step.id}
            type="button"
            onClick={() => props.onSelect(step.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
              step.id === props.step.id
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <span className="w-4 shrink-0 font-mono tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="font-mono text-[11px] text-muted-foreground">{props.step.route}</p>
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/70">
          {props.step.source}
        </p>

        <p className="mt-5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          First run
        </p>
        <div className="mt-2 flex flex-col gap-3">
          {props.step.reactions.map((reaction, index) => (
            <blockquote
              key={index}
              className="border-l-2 border-border pl-3 text-[13px] leading-relaxed text-foreground/80"
            >
              {reaction}
            </blockquote>
          ))}
        </div>
      </div>
    </aside>
  );
}

const stepFromHash = (): StepId => {
  const hash = globalThis.location?.hash.replace(/^#/, "") ?? "";
  return flowSteps.some((step) => step.id === hash) ? (hash as StepId) : "integrations-empty";
};

function CurrentFlowApp(props: { readonly modeSwitch: React.ReactNode }) {
  // Each screen is addressable as `#<step-id>`, so a specific screen can be
  // linked to directly rather than clicked toward.
  const [stepId, setStepId] = useState<StepId>(stepFromHash);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [overrides, setOverrides] = useState<{
    readonly integrations?: readonly DemoIntegration[];
    readonly connectOpen?: boolean;
    readonly accountModal?: AccountModal;
    readonly view?: ScreenView;
  }>({});

  const base = useMemo(() => stepState[stepId], [stepId]);
  const state = { ...base, ...overrides };
  const step = flowSteps.find((candidate) => candidate.id === stepId) ?? flowSteps[0]!;

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
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
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
      </div>

      {inspectorOpen ? (
        <Inspector
          step={step}
          onSelect={goToStep}
          onClose={() => setInspectorOpen(false)}
          modeSwitch={props.modeSwitch}
        />
      ) : (
        // oxlint-disable-next-line react/forbid-elements
        <button
          type="button"
          onClick={() => setInspectorOpen(true)}
          aria-label="Show inspector"
          className="fixed right-4 top-4 z-50 rounded-md border border-border bg-card p-2 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          <PanelRightOpenIcon className="size-4" />
        </button>
      )}

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode switch — the current flow and the reworked one, same chrome, same
// tokens, so the comparison is about the flow rather than the styling.
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
        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
        props.mode === mode
          ? "bg-background text-foreground shadow-xs"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
      {option("current", "Current")}
      {option("next", "Reworked")}
    </div>
  );
}

const modeFromHash = (): Mode =>
  (globalThis.location?.hash ?? "").startsWith("#next") ? "next" : "current";

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
      globalThis.location.hash = next === "next" ? "next" : "integrations-empty";
    }
  };

  const modeSwitch = <ModeSwitch mode={mode} onChange={changeMode} />;

  if (mode === "next") {
    return (
      <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <div className="flex min-w-0 flex-1 flex-col">
          <NextFlow />
        </div>
        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
          <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
            {modeSwitch}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
              What changed
            </p>
            <div className="mt-3 flex flex-col gap-3 text-[13px] leading-relaxed text-foreground/80">
              {NEXT_NOTES.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
            <p className="mt-6 text-xs font-medium uppercase tracking-widest text-muted-foreground">
              Data
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-foreground/80">
              The picker lists the live integrations.sh registry. The authenticate screen is built
              from that domain&apos;s credential record. Categories are a keyword stand-in — the
              registry has no taxonomy yet.
            </p>
          </div>
        </aside>
      </div>
    );
  }

  return <CurrentFlowApp modeSwitch={modeSwitch} />;
}

const NEXT_NOTES: readonly string[] = [
  "The picker is the page, not a dialog behind a button. Search is the first thing on it.",
  "Add happens in place. The row flips to Added, the list holds still, and you can keep adding.",
  "No add-integration form. Spec URL, base URL and auth methods all come from the registry, so there is nothing to fill in and no locked Method 1 to misread.",
  "Auth is deferred, not skipped. An add leaves one account reading Needs auth next to the button that fixes it — so the second step is visibly the same task, not a second add.",
  "The authenticate screen names the key, links straight to the page that mints it, and shows the provider's own setup steps. The paste field is focused and never gated.",
  "Owner is not asked during setup. Personal appears zero times.",
];
