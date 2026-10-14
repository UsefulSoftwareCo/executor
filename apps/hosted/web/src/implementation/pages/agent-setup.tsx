import { Fragment, Suspense, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft02Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { ConnectedAgent } from "@executor-js/mcp-auth/agents";
import type { GrantId } from "@executor-js/mcp-auth/grants";
import type { AssistantId } from "@executor-js/ui/contracts/dashboard";
import {
  AssistantChoices,
  AssistantSetupGuide,
  assistantName,
} from "@executor-js/ui/dashboard/connect";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { Button } from "@executor-js/ui/components/button";
import { Spinner } from "@executor-js/ui/components/spinner";
import { useHydrated } from "@executor-js/ui/hooks/hydrated";
import { SessionMenu } from "../components/auth.tsx";
import { organizationsAtom } from "../../contracts/organization.ts";
import {
  AgentBaseline,
  AgentBaselineRequest,
  AgentConfirmation,
  AgentConnectionAttempt,
  agentBaselineAtom,
  confirmedMcpAgentAtom,
  newMcpAgentAtom,
} from "../../contracts/mcp-connections.ts";
import { parseAgentSetupSearch } from "../../contracts/navigation.ts";
import { useDocumentationUrl } from "../documentation.ts";
import { useMcpOrigin } from "../resource-origin.ts";

/**
 * Shared onboarding layout keeps identity controls outside the main instructions. Wide screens pin
 * them to the corner beside the content; narrower ones place them above it, so they never cover
 * the instructions. The content starts at a fixed top, so a step that grows or shrinks never moves
 * what is above it.
 */
export function SetupPageFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center px-6 pt-6 pb-[max(16px,_env(safe-area-inset-bottom))] lg:pt-24 lg:pb-24">
      <div className="mb-6 w-[200px] max-w-full self-end bg-background lg:fixed lg:bottom-[max(16px,_env(safe-area-inset-bottom))] lg:left-[max(12px,_env(safe-area-inset-left))] lg:mb-0 lg:max-w-[calc(100%-88px)]">
        <SessionMenu />
      </div>
      <div className="flex w-full flex-col items-center">{children}</div>
    </main>
  );
}

/** Moves focus to a screen's heading when it replaces the previous one, without scrolling to it. */
const focusHeading = (node: HTMLHeadingElement | null) => node?.focus({ preventScroll: true });

/**
 * A reloadable handoff that unlocks the first prompt once an assistant really connects. Each
 * screen the member chooses is a history entry named by the URL: the assistants, one assistant's
 * guide, then the first prompt for the agent that connected. Guides and the prompt are static, so
 * they render at once, also on the server; only the connection status below them waits for data.
 *
 * Next unlocks for an agent that is not in the guide's baseline, a read of the agents already
 * connected that starts as the guide is shown, or while the server renders a guide opened
 * directly, before its instructions reach the browser. The baseline is kept in the entry's history
 * state, so Back, Forward and reload compare with the same one. The first prompt confirms that the
 * member holds a usable MCP grant for its agent, so its URL alone never claims a connection.
 */
export function AgentSetupPage() {
  const endpoint = `${useMcpOrigin()}/mcp`;
  const navigate = useNavigate();
  // The screen and its saved baseline come from one location. The matched route's search can
  // trail the location by a render, which would pair one entry's URL with another's state.
  const location = useLocation();
  const search = parseAgentSetupSearch(location.search);
  // History state is browser-only, so the server render and hydration see none.
  const hydrated = useHydrated();
  const saved = hydrated
    ? Option.getOrUndefined(Schema.decodeUnknownOption(AgentBaseline)(location.state.agentSetup))
    : undefined;
  const capture = useBaselineCapture(
    search.assistant === undefined
      ? "choose"
      : search.step === "prompt"
        ? `prompt:${search.assistant}:${search.agent}`
        : `guide:${search.assistant}`,
  );
  return (
    <SetupPageFrame>
      <section className="@container w-full max-w-[600px]" aria-labelledby="agent-setup-title">
        <div className="mb-8 flex items-center gap-2 font-mono text-[15px]">
          <img src="/favicon.png" alt="" width={20} height={20} className="size-5" />
          <span>executor</span>
        </div>
        {/* Keyed so a new screen mounts its own elements rather than moving the last screen's. */}
        {search.assistant === undefined ? (
          <Fragment key="choose">
            <h1
              id="agent-setup-title"
              ref={focusHeading}
              tabIndex={-1}
              className="text-3xl font-medium tracking-[-0.04em] outline-none"
            >
              Connect your assistant
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Executor works inside the AI assistant you already use. Pick yours to see how to add
              it.
            </p>
            <div className="mt-6">
              <AssistantChoices
                onSelect={(chosen) => void navigate({ to: ".", search: { assistant: chosen } })}
              />
            </div>
            <Link
              to="/"
              className="mt-6 inline-block text-[13px] text-muted-foreground hover:text-foreground"
            >
              Skip for now
            </Link>
          </Fragment>
        ) : search.step === "prompt" ? (
          <PromptStep
            key={`prompt:${search.assistant}:${search.agent}`}
            endpoint={endpoint}
            assistant={search.assistant}
            agent={search.agent}
          />
        ) : (
          <GuideStep
            key={`guide:${search.assistant}`}
            endpoint={endpoint}
            assistant={search.assistant}
            capture={capture}
            saved={saved}
          />
        )}
      </section>
    </SetupPageFrame>
  );
}

/**
 * Names the baseline read for the guide on screen. Each screen the page shows starts a new one,
 * so a guide reads the agents already connected when it is shown, including any connected while
 * the assistants were open. The server renders the document's own read with a guide opened
 * directly, so the agents connected before its instructions arrived are known with them.
 */
function useBaselineCapture(screen: string) {
  const hydrated = useHydrated();
  const [capture, setCapture] = useState(() => (hydrated ? crypto.randomUUID() : "document"));
  const [shown, setShown] = useState(screen);
  if (screen !== shown) {
    setShown(screen);
    setCapture(crypto.randomUUID());
  }
  return capture;
}

/** One assistant's static guide over its connection status and Next. */
function GuideStep({
  endpoint,
  assistant,
  capture,
  saved,
}: {
  readonly endpoint: string;
  readonly assistant: AssistantId;
  readonly capture: string;
  readonly saved: AgentBaseline | undefined;
}) {
  const name = assistantName(assistant);
  return (
    <>
      <Button variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground" asChild>
        <Link to="." search={{}}>
          <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden />
          All assistants
        </Link>
      </Button>
      <h1 id="agent-setup-title" ref={focusHeading} tabIndex={-1} className="sr-only">
        Connect {name}
      </h1>
      <div className="mt-3">
        <AssistantSetupGuide endpoint={endpoint} assistant={assistant} />
      </div>
      {/* The server renders the guide first; its status streams when the baseline is read. */}
      <Suspense fallback={<GuideStatus assistant={name} state={{ kind: "preparing" }} />}>
        <GuideConnection assistant={assistant} capture={capture} saved={saved} />
      </Suspense>
    </>
  );
}

/**
 * The guide's connection status. The entry's saved baseline is used when it has one; otherwise
 * the current capture is read and saved to the entry, never replaced by a later read.
 */
function GuideConnection({
  assistant,
  capture,
  saved,
}: {
  readonly assistant: AssistantId;
  readonly capture: string;
  readonly saved: AgentBaseline | undefined;
}) {
  const name = assistantName(assistant);
  const organizations = useAtomValue(organizationsAtom);
  const retryOrganizations = useAtomRefresh(organizationsAtom);
  if (saved !== undefined)
    return <AgentWatch assistant={assistant} attempt={new AgentConnectionAttempt(saved)} />;
  if (AsyncResult.isFailure(organizations))
    return (
      <GuideStatus
        assistant={name}
        state={{
          kind: "teams-failed",
          retrying: organizations.waiting,
          retry: retryOrganizations,
        }}
      />
    );
  if (!AsyncResult.isSuccess(organizations))
    return <GuideStatus assistant={name} state={{ kind: "preparing" }} />;
  return (
    <CapturedBaseline
      assistant={assistant}
      request={
        new AgentBaselineRequest({
          organizations: organizations.value.map((organization) => organization.id),
          capture,
        })
      }
    />
  );
}

/** Progress the page learns by itself replaces the current entry; only the member's choices add one. */
function CapturedBaseline({
  assistant,
  request,
}: {
  readonly assistant: AssistantId;
  readonly request: AgentBaselineRequest;
}) {
  const navigate = useNavigate();
  const result = useAtomValue(agentBaselineAtom(request));
  const retry = useAtomRefresh(agentBaselineAtom(request));
  const baseline = AsyncResult.isSuccess(result) ? result.value : undefined;
  // A guide that hydrates with the server's read has not seen its entry's state yet. If the entry
  // already holds a baseline, the page shows that one once hydrated and this one is never saved.
  const hydrated = useHydrated();
  // Saves each baseline once; saving changes the location, so it must not run on every render.
  const save = useEffectEvent((agentSetup: AgentBaseline) =>
    navigate({
      to: ".",
      search: { assistant },
      state: { agentSetup },
      replace: true,
      resetScroll: false,
    }),
  );
  useEffect(() => {
    if (hydrated && baseline !== undefined) void save(baseline);
  }, [hydrated, baseline]);
  if (AsyncResult.isFailure(result))
    return (
      <GuideStatus
        assistant={assistantName(assistant)}
        state={{ kind: "prepare-failed", retrying: result.waiting, retry }}
      />
    );
  if (baseline === undefined)
    return <GuideStatus assistant={assistantName(assistant)} state={{ kind: "preparing" }} />;
  return <AgentWatch assistant={assistant} attempt={new AgentConnectionAttempt(baseline)} />;
}

/** Waits for a new agent, then keeps it, which stops the checks, and unlocks Next. */
function AgentWatch({
  assistant,
  attempt,
}: {
  readonly assistant: AssistantId;
  readonly attempt: AgentConnectionAttempt;
}) {
  const [agent, setAgent] = useState<ConnectedAgent>();
  return agent === undefined ? (
    <NewAgentWatch assistant={assistant} attempt={attempt} onConnected={setAgent} />
  ) : (
    <GuideStatus
      assistant={assistantName(assistant)}
      state={{ kind: "connected", agent }}
      next={{ assistant, step: "prompt", agent: agent.id }}
    />
  );
}

function NewAgentWatch({
  assistant,
  attempt,
  onConnected,
}: {
  readonly assistant: AssistantId;
  readonly attempt: AgentConnectionAttempt;
  readonly onConnected: (agent: ConnectedAgent) => void;
}) {
  const result = useAtomValue(newMcpAgentAtom(attempt));
  const retry = useAtomRefresh(newMcpAgentAtom(attempt));
  const agent = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined;
  useEffect(() => {
    if (agent !== undefined) onConnected(agent);
  }, [agent, onConnected]);
  return (
    <GuideStatus
      assistant={assistantName(assistant)}
      state={
        AsyncResult.isFailure(result)
          ? { kind: "check-failed", retrying: result.waiting, retry }
          : { kind: "waiting" }
      }
    />
  );
}

/** The guide's status card, with Next enabled only once `next` names the connected agent. */
function GuideStatus({
  assistant,
  state,
  next,
}: {
  readonly assistant: string;
  readonly state: ConnectionState;
  readonly next?: {
    readonly assistant: AssistantId;
    readonly step: "prompt";
    readonly agent: GrantId;
  };
}) {
  const navigate = useNavigate();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card px-4 py-3">
      <ConnectionStatus assistant={assistant} state={state} reserved={guideStates} />
      <Button
        size="sm"
        className="w-full @md:ml-auto @md:w-auto"
        disabled={next === undefined}
        onClick={() => {
          if (next !== undefined) void navigate({ to: ".", search: next });
        }}
      >
        Next: send your first prompt
        <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden />
      </Button>
    </div>
  );
}

type ConnectionState =
  | { readonly kind: "preparing" | "waiting" | "checking" }
  | {
      readonly kind: "teams-failed" | "prepare-failed" | "check-failed";
      readonly retrying: boolean;
      readonly retry: () => void;
    }
  | { readonly kind: "connected"; readonly agent: ConnectedAgent };

type ReservedState = "waiting" | "teams-failed" | "prepare-failed" | "check-failed";

/**
 * States that can be taller than the others where the status appears. They stay laid out, hidden,
 * behind the current one, so the card keeps the height of the tallest at every width and moving
 * between them shifts nothing. Preparing, checking and connected are never taller than these.
 */
const guideStates: readonly ReservedState[] = [
  "waiting",
  "teams-failed",
  "prepare-failed",
  "check-failed",
];
const promptStates: readonly ReservedState[] = ["teams-failed", "check-failed"];

/** One status cell: the current state over hidden copies of every reserved one. */
function ConnectionStatus({
  assistant,
  state,
  reserved,
}: {
  readonly assistant: string;
  readonly state: ConnectionState;
  readonly reserved: readonly ReservedState[];
}) {
  return (
    <div role="status" aria-live="polite" className="grid min-w-0 flex-1 basis-64">
      <StatusView key={state.kind} assistant={assistant} state={state} />
      {reserved
        .filter((kind) => kind !== state.kind)
        .map((kind) => (
          <div key={kind} className="invisible [grid-area:1/1]" inert aria-hidden>
            <StatusView
              assistant={assistant}
              state={kind === "waiting" ? { kind } : { kind, retrying: false, retry: () => {} }}
              reserved
            />
          </div>
        ))}
    </div>
  );
}

function StatusView({
  assistant,
  state,
  reserved = false,
}: {
  readonly assistant: string;
  readonly state: ConnectionState;
  /** A hidden copy that only reserves space keeps a still placeholder in place of the spinner. */
  readonly reserved?: boolean;
}) {
  const spinner = reserved ? (
    <span className="size-4" />
  ) : (
    <Spinner className="text-muted-foreground" aria-hidden role={undefined} />
  );
  const failed = <span className="mt-1.5 size-2 rounded-full bg-destructive" aria-hidden />;
  switch (state.kind) {
    case "preparing":
      return <StatusLine icon={spinner} title={`Preparing ${assistant} setup…`} />;
    case "checking":
      return <StatusLine icon={spinner} title={`Checking ${assistant} is connected…`} />;
    case "waiting":
      return (
        <StatusLine
          icon={spinner}
          title={`Waiting for ${assistant} to connect…`}
          detail="This updates by itself after you approve access. Already connected? Sign in again from your assistant."
        />
      );
    case "teams-failed":
      return (
        <StatusLine
          icon={failed}
          title="Couldn’t load your teams"
          detail="Try again to continue setup."
        >
          <RetryButton retrying={state.retrying} retry={state.retry} />
        </StatusLine>
      );
    case "prepare-failed":
      return (
        <StatusLine
          icon={failed}
          title={`Couldn’t prepare ${assistant} setup`}
          detail="Try again to show the setup steps."
        >
          <RetryButton retrying={state.retrying} retry={state.retry} />
        </StatusLine>
      );
    case "check-failed":
      return (
        <StatusLine
          icon={failed}
          title="Couldn’t check the connection"
          detail="Your assistant may still be connecting. Try again to check."
        >
          <RetryButton retrying={state.retrying} retry={state.retry} />
        </StatusLine>
      );
    case "connected":
      return (
        <StatusLine
          icon={
            <span className="flex size-5 items-center justify-center rounded-full bg-emerald-600 text-white">
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} size={12} aria-hidden />
            </span>
          }
          title="Executor is connected"
          detail={state.agent.name === null ? undefined : `Approved for ${state.agent.name}`}
          singleLineDetail
        />
      );
  }
}

function StatusLine({
  icon,
  title,
  detail,
  singleLineDetail = false,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string | undefined;
  /** Keeps a detail of unknown length, such as an agent's name, to one line. */
  readonly singleLineDetail?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 [grid-area:1/1]">
      <span className="mt-0.5 flex shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-5">
        <p className="font-medium">{title}</p>
        {detail && (
          <p className={`text-xs text-muted-foreground${singleLineDetail ? " truncate" : ""}`}>
            {detail}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** The icon slot holds either the retry icon or the spinner, so retrying keeps the button's size. */
function RetryButton({
  retrying,
  retry,
}: {
  readonly retrying: boolean;
  readonly retry: () => void;
}) {
  return (
    <Button variant="outline" size="sm" className="mt-2" disabled={retrying} onClick={retry}>
      {retrying ? (
        <Spinner aria-hidden role={undefined} />
      ) : (
        <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} aria-hidden />
      )}
      Try again
    </Button>
  );
}

/**
 * The first prompt is static and names the exact MCP URL and docs. Below it, the page confirms the
 * member still holds a usable MCP grant for the agent the URL names; one that is not found, such
 * as a revoked agent or an edited link, opens the guide instead.
 */
function PromptStep({
  endpoint,
  assistant,
  agent,
}: {
  readonly endpoint: string;
  readonly assistant: AssistantId;
  readonly agent: GrantId;
}) {
  const docsUrl = useDocumentationUrl();
  const prompt = `Use Executor, which I connected over MCP at ${endpoint}. If you cannot see its tools yet, connect to that server first.\n\nRead the docs to understand the product at ${docsUrl}, then help me get my first app set up.`;
  const name = assistantName(assistant);
  return (
    <>
      <h1
        id="agent-setup-title"
        ref={focusHeading}
        tabIndex={-1}
        className="text-3xl font-medium tracking-[-0.04em] outline-none"
      >
        Send your first prompt
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Paste this into {name} to set up your first app.
      </p>
      <div className="mt-6 overflow-hidden rounded-xl border bg-card">
        <p className="p-4 text-[13px] leading-6 break-words whitespace-pre-line select-text">
          {prompt}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/40 px-4 py-2.5">
          <CopyButton
            code={prompt}
            label="Copy starter prompt"
            text="Copy prompt"
            variant="default"
            size="sm"
            inline
          />
          <Link to="/" className="text-[13px] text-muted-foreground hover:text-foreground">
            Open dashboard &rarr;
          </Link>
        </div>
      </div>
      <div className="mt-3 rounded-xl border bg-card px-4 py-3">
        <Suspense fallback={<PromptStatus assistant={name} state={{ kind: "checking" }} />}>
          <AgentConfirmationStatus assistant={assistant} agent={agent} />
        </Suspense>
      </div>
    </>
  );
}

function AgentConfirmationStatus({
  assistant,
  agent,
}: {
  readonly assistant: AssistantId;
  readonly agent: GrantId;
}) {
  const name = assistantName(assistant);
  const organizations = useAtomValue(organizationsAtom);
  const retryOrganizations = useAtomRefresh(organizationsAtom);
  if (AsyncResult.isFailure(organizations))
    return (
      <PromptStatus
        assistant={name}
        state={{
          kind: "teams-failed",
          retrying: organizations.waiting,
          retry: retryOrganizations,
        }}
      />
    );
  if (!AsyncResult.isSuccess(organizations))
    return <PromptStatus assistant={name} state={{ kind: "checking" }} />;
  return (
    <ConfirmedAgent
      assistant={assistant}
      confirmation={
        new AgentConfirmation({
          organizations: organizations.value.map((organization) => organization.id),
          agent,
        })
      }
    />
  );
}

function ConfirmedAgent({
  assistant,
  confirmation,
}: {
  readonly assistant: AssistantId;
  readonly confirmation: AgentConfirmation;
}) {
  const navigate = useNavigate();
  const name = assistantName(assistant);
  const result = useAtomValue(confirmedMcpAgentAtom(confirmation));
  const retry = useAtomRefresh(confirmedMcpAgentAtom(confirmation));
  const missing = AsyncResult.isSuccess(result) && Option.isNone(result.value);
  // The prompt's URL named an agent the member does not hold, so its guide takes this entry.
  const openGuide = useEffectEvent(() =>
    navigate({ to: ".", search: { assistant }, replace: true, resetScroll: false }),
  );
  useEffect(() => {
    if (missing) void openGuide();
  }, [missing]);
  if (AsyncResult.isFailure(result))
    return (
      <PromptStatus
        assistant={name}
        state={{ kind: "check-failed", retrying: result.waiting, retry }}
      />
    );
  if (AsyncResult.isSuccess(result) && Option.isSome(result.value))
    return (
      <PromptStatus assistant={name} state={{ kind: "connected", agent: result.value.value }} />
    );
  return <PromptStatus assistant={name} state={{ kind: "checking" }} />;
}

function PromptStatus({
  assistant,
  state,
}: {
  readonly assistant: string;
  readonly state: ConnectionState;
}) {
  return <ConnectionStatus assistant={assistant} state={state} reserved={promptStates} />;
}
