import { Suspense, useEffect, useEffectEvent, useState, type ReactNode } from "react";
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
import { AsyncResult, type Atom } from "effect/reactivity";
import type { ConnectedAgent } from "@executor-js/mcp-auth/agents";
import type { GrantId } from "@executor-js/mcp-auth/grants";
import type { AssistantId } from "@executor-js/ui/contracts/dashboard";
import { executorCatalogPackage } from "@executor-js/hosted-server/catalog";
import {
  AssistantChoices,
  AssistantGuideLink,
  AssistantGuideLogo,
  AssistantGuideSteps,
  EndpointField,
  assistantName,
  useAssistantGuide,
} from "@executor-js/ui/dashboard/connect";
import { CopyButton } from "@executor-js/ui/dashboard/code";
import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { Spinner } from "@executor-js/ui/components/spinner";
import { useHydrated } from "@executor-js/ui/hooks/hydrated";
import { cn } from "@executor-js/ui/lib/utils";
import { randomUuid } from "@executor-js/utils/random-uuid";
import { inventoryAtom, organizationsAtom } from "../../contracts/organization.ts";
import {
  AgentBaseline,
  AgentBaselineRequest,
  AgentConfirmation,
  AgentConnectionAttempt,
  agentBaselineAtom,
  confirmedMcpAgentAtom,
  mcpAgentsAtom,
  newMcpAgentAtom,
} from "../../contracts/mcp-connections.ts";
import { parseAgentSetupSearch } from "../../contracts/navigation.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";
import {
  SetupActions,
  SetupBack,
  SetupCard,
  SetupLede,
  SetupNext,
  SetupPage,
  SetupTitle,
} from "../components/setup-page.tsx";
import { SetupLink, useSetupSequence, useSetupViewed } from "../components/setup-sequence.tsx";
import { useDocumentationUrl } from "../documentation.ts";
import { useMcpOrigin } from "../resource-origin.ts";

const focusHeading = (node: HTMLHeadingElement | null) => node?.focus({ preventScroll: true });

export function AgentSetupPage() {
  const endpoint = `${useMcpOrigin()}/mcp`;
  const current = useLocation();
  const here = current.pathname.endsWith("/setup/assistant");
  const [kept, keep] = useState(current);
  if (here && current.href !== kept.href) keep(current);
  const location = here ? current : kept;
  const search = parseAgentSetupSearch(location.search);
  const hydrated = useHydrated();
  const saved = hydrated
    ? Option.getOrUndefined(Schema.decodeUnknownOption(AgentBaseline)(location.state.agentSetup))
    : undefined;
  const screen =
    search.assistant === undefined
      ? "choose"
      : search.step === "prompt"
        ? `prompt:${search.assistant}:${search.agent}`
        : `guide:${search.assistant}`;
  const capture = useBaselineCapture(screen);
  const sequence = useSetupSequence();
  const { slug } = useOrganizationRoute();
  return (
    <SetupPage organization={slug} onSignOut={() => sequence.report("leave_setup", "started")}>
      <section className="@container w-full" aria-labelledby="agent-setup-title">
        {search.assistant === undefined ? (
          <ChooseStep key={screen} endpoint={endpoint} capture={capture} saved={saved} />
        ) : search.step === "prompt" ? (
          <PromptStep
            key={screen}
            endpoint={endpoint}
            assistant={search.assistant}
            agent={search.agent}
          />
        ) : (
          <GuideStep
            key={screen}
            endpoint={endpoint}
            assistant={search.assistant}
            capture={capture}
            saved={saved}
          />
        )}
      </section>
    </SetupPage>
  );
}

function useBaselineCapture(screen: string) {
  const hydrated = useHydrated();
  const [capture, setCapture] = useState(() => (hydrated ? randomUuid() : "document"));
  const [shown, setShown] = useState(screen);
  if (screen !== shown) {
    setShown(screen);
    setCapture(randomUuid());
  }
  return capture;
}

interface ScreenBaseline {
  readonly capture: string;
  readonly saved: AgentBaseline | undefined;
}

function ChooseStep({ endpoint, ...baseline }: { readonly endpoint: string } & ScreenBaseline) {
  const navigate = useNavigate();
  const [found, setAgent] = useState<ConnectedAgent>();
  const before = useAgentConnectedBefore();
  const agent = found ?? before;
  useSetupViewed("setup_assistant");
  const name = "your assistant";
  return (
    <>
      <SetupTitle id="agent-setup-title" ref={focusHeading}>
        Connect your assistant
      </SetupTitle>
      <SetupLede>
        Executor works inside the AI assistant you already use. Pick yours to see how to add it.
      </SetupLede>
      <div className="mt-6">
        <AssistantChoices
          onSelect={(chosen) => void navigate({ to: ".", search: { assistant: chosen } })}
        />
      </div>
      <div className="mt-6 flex items-center gap-3 text-xs text-muted-foreground" role="separator">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <SetupCard aria-labelledby="agent-setup-mcp" className="mt-4">
        <div className="px-4.5 py-4 max-sm:px-6">
          <h2 id="agent-setup-mcp" className="text-sm font-medium">
            Add the MCP server
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Any client that supports remote MCP servers with OAuth sign-in can use this URL.
          </p>
          <EndpointField endpoint={endpoint} className="mt-3" />
        </div>
        <Suspense fallback={<GuideStatus assistant={name} state={{ kind: "preparing" }} />}>
          <AgentConnection assistant={name} {...baseline} agent={agent} onConnected={setAgent} />
        </Suspense>
      </SetupCard>
      <SetupActions>
        <AssistantNext assistant="other" agent={agent} picked={false} />
      </SetupActions>
    </>
  );
}

function GuideStep({
  endpoint,
  assistant,
  ...baseline
}: {
  readonly endpoint: string;
  readonly assistant: AssistantId;
} & ScreenBaseline) {
  useSetupViewed("setup_guide", assistant);
  const guide = useAssistantGuide(endpoint, assistant);
  const name = assistantName(assistant);
  const [found, setAgent] = useState<ConnectedAgent>();
  const before = useAgentConnectedBefore();
  const agent = found ?? before;
  return (
    <>
      <SetupTitle id="agent-setup-title" ref={focusHeading}>
        Add Executor to {name}
      </SetupTitle>
      <SetupLede>
        <span className="max-sm:hidden">Takes about a minute. </span>This page updates once {name}{" "}
        connects.
      </SetupLede>
      <SetupCard aria-label={`${name} setup`}>
        <div className="px-4.5 py-4 max-sm:px-6">
          {guide.link && (
            <AssistantGuideLink guide={guide} className="mb-4">
              <AssistantGuideLogo guide={guide} className="size-3.5" />
            </AssistantGuideLink>
          )}
          <AssistantGuideSteps guide={guide} className="text-sm leading-6 text-foreground" />
        </div>
        <Suspense fallback={<GuideStatus assistant={name} state={{ kind: "preparing" }} />}>
          <AgentConnection assistant={name} {...baseline} agent={agent} onConnected={setAgent} />
        </Suspense>
      </SetupCard>
      <SetupActions>
        <SetupBack>
          <Link to="." search={{}}>
            <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} aria-hidden />
            <span className="max-sm:sr-only">Different assistant</span>
          </Link>
        </SetupBack>
        <AssistantNext assistant={assistant} agent={agent} />
      </SetupActions>
    </>
  );
}

function AssistantNext({
  assistant,
  agent,
  picked = true,
}: {
  readonly assistant: AssistantId;
  readonly agent: ConnectedAgent | undefined;
  readonly picked?: boolean;
}) {
  const sequence = useSetupSequence();
  return (
    <SetupNext
      done={agent !== undefined}
      required={sequence.required}
      hint="Connect your assistant to continue"
      label="Next: connect accounts"
    >
      {(content) => (
        <SetupLink
          to={sequence.after(
            "assistant",
            agent === undefined ? undefined : { assistant, agent: agent.id },
          )}
          onClick={() =>
            sequence.report(
              agent === undefined ? "skip_assistant" : "continue_assistant",
              "started",
              picked || agent !== undefined ? assistant : undefined,
            )
          }
        >
          {content}
        </SetupLink>
      )}
    </SetupNext>
  );
}

function useAgentConnectedBefore(): ConnectedAgent | undefined {
  const { required } = useSetupSequence();
  const { organization } = useOrganizationRoute();
  const agents = useAtomValue(mcpAgentsAtom(organization));
  if (!required || !AsyncResult.isSuccess(agents)) return undefined;
  return agents.value.find((agent) => agent.access.kind !== "api");
}

interface AgentFound {
  readonly agent: ConnectedAgent | undefined;
  readonly onConnected: (agent: ConnectedAgent) => void;
}

function AgentConnection({
  assistant,
  capture,
  saved,
  ...found
}: { readonly assistant: string } & ScreenBaseline & AgentFound) {
  const organizations = useAtomValue(organizationsAtom);
  const retryOrganizations = useAtomRefresh(organizationsAtom);
  if (saved !== undefined)
    return (
      <AgentWatch assistant={assistant} attempt={new AgentConnectionAttempt(saved)} {...found} />
    );
  if (AsyncResult.isFailure(organizations))
    return (
      <GuideStatus
        assistant={assistant}
        state={{
          kind: "teams-failed",
          retrying: organizations.waiting,
          retry: retryOrganizations,
        }}
      />
    );
  if (!AsyncResult.isSuccess(organizations))
    return <GuideStatus assistant={assistant} state={{ kind: "preparing" }} />;
  return (
    <CapturedBaseline
      assistant={assistant}
      request={
        new AgentBaselineRequest({
          organizations: organizations.value.map((organization) => organization.id),
          capture,
        })
      }
      {...found}
    />
  );
}

function CapturedBaseline({
  assistant,
  request,
  ...found
}: {
  readonly assistant: string;
  readonly request: AgentBaselineRequest;
} & AgentFound) {
  const navigate = useNavigate();
  const result = useAtomValue(agentBaselineAtom(request));
  const retry = useAtomRefresh(agentBaselineAtom(request));
  const baseline = AsyncResult.isSuccess(result) ? result.value : undefined;
  const hydrated = useHydrated();
  const save = useEffectEvent((agentSetup: AgentBaseline) =>
    navigate({
      to: ".",
      search: true,
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
        assistant={assistant}
        state={{ kind: "prepare-failed", retrying: result.waiting, retry }}
      />
    );
  if (baseline === undefined)
    return <GuideStatus assistant={assistant} state={{ kind: "preparing" }} />;
  return (
    <AgentWatch assistant={assistant} attempt={new AgentConnectionAttempt(baseline)} {...found} />
  );
}

function AgentWatch({
  assistant,
  attempt,
  agent,
  onConnected,
}: {
  readonly assistant: string;
  readonly attempt: AgentConnectionAttempt;
} & AgentFound) {
  return agent === undefined ? (
    <NewAgentWatch assistant={assistant} attempt={attempt} onConnected={onConnected} />
  ) : (
    <GuideStatus assistant={assistant} state={{ kind: "connected", agent }} />
  );
}

function NewAgentWatch({
  assistant,
  attempt,
  onConnected,
}: {
  readonly assistant: string;
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
      assistant={assistant}
      state={
        AsyncResult.isFailure(result)
          ? { kind: "check-failed", retrying: result.waiting, retry }
          : { kind: "waiting" }
      }
    />
  );
}

function GuideStatus({
  assistant,
  state,
}: {
  readonly assistant: string;
  readonly state: ConnectionState;
}) {
  return (
    <StatusRow connected={state.kind === "connected"}>
      <ConnectionStatus assistant={assistant} state={state} reserved={guideStates} />
    </StatusRow>
  );
}

function StatusRow({
  connected,
  children,
}: {
  readonly connected: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center border-t px-4.5 py-3 transition-colors max-sm:px-6",
        connected ? "bg-emerald-50 dark:bg-emerald-950/40" : "bg-muted/40",
      )}
    >
      {children}
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

const guideStates: readonly ReservedState[] = [
  "waiting",
  "teams-failed",
  "prepare-failed",
  "check-failed",
];
const promptStates: readonly ReservedState[] = ["teams-failed", "check-failed"];

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
  readonly reserved?: boolean;
}) {
  const spinner = reserved ? (
    <span className="size-4" />
  ) : (
    <Spinner className="text-muted-foreground" aria-hidden role={undefined} />
  );
  const failed = <span className="size-2 rounded-full bg-destructive" aria-hidden />;
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
          detail="Updates by itself once you approve. Already connected? Sign in again."
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
  readonly singleLineDetail?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 [grid-area:1/1]">
      <div className="flex min-w-0 flex-1 gap-3">
        <span className="flex h-5 shrink-0 items-center">{icon}</span>
        <div className="min-w-0 flex-1 text-[13px] leading-5">
          <p className="font-medium">{title}</p>
          {detail && (
            <p className={`text-xs text-muted-foreground${singleLineDetail ? " truncate" : ""}`}>
              {detail}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function RetryButton({
  retrying,
  retry,
}: {
  readonly retrying: boolean;
  readonly retry: () => void;
}) {
  return (
    <Button variant="outline" size="sm" className="shrink-0" disabled={retrying} onClick={retry}>
      {retrying ? (
        <Spinner aria-hidden role={undefined} />
      ) : (
        <HugeiconsIcon icon={ArrowReloadHorizontalIcon} strokeWidth={2} aria-hidden />
      )}
      Try again
    </Button>
  );
}

function PromptStep({
  endpoint,
  assistant,
  agent,
}: {
  readonly endpoint: string;
  readonly assistant: AssistantId;
  readonly agent: GrantId;
}) {
  const { organization, slug } = useOrganizationRoute();
  const sequence = useSetupSequence();
  useSetupViewed("setup_prompt", assistant);
  const docsUrl = useDocumentationUrl();
  const inventory = useAtomValue(inventoryAtom(organization));
  const retry = useAtomRefresh(inventoryAtom(organization));
  const connected = Option.map(AsyncResult.value(inventory), connectedAccounts);
  const name = assistantName(assistant);
  return (
    <>
      <SetupTitle id="agent-setup-title" ref={focusHeading}>
        Send your first prompt
      </SetupTitle>
      <SetupLede>Paste this into {assistant === "other" ? "your assistant" : name}.</SetupLede>
      <SetupCard>
        {Option.match(connected, {
          onNone: () =>
            AsyncResult.isFailure(inventory) ? (
              <div className="p-4 max-sm:px-6">
                <HostedFailure cause={inventory.cause} retry={retry} layout="compact" />
              </div>
            ) : (
              <div aria-busy="true" aria-label="Loading your prompt">
                <PromptText>
                  {promptOpening(endpoint)}
                  {"\n\n"}
                  <span className="flex h-6 items-center">
                    <Skeleton className="h-3.5 w-full" />
                  </span>
                  <span className="flex h-6 items-center">
                    <Skeleton className="h-3.5 w-3/5" />
                  </span>
                </PromptText>
                <PromptCopy prompt={undefined} />
              </div>
            ),
          onSome: (accounts) => {
            const prompt = firstPrompt(endpoint, docsUrl, accounts);
            return (
              <>
                <PromptText>{prompt}</PromptText>
                <PromptCopy prompt={prompt} />
              </>
            );
          },
        })}
        <StatusRow connected={false}>
          <Suspense fallback={<PromptStatus assistant={name} state={{ kind: "checking" }} />}>
            <AgentConfirmationStatus assistant={assistant} agent={agent} />
          </Suspense>
        </StatusRow>
      </SetupCard>
      <SetupActions>
        <Button asChild>
          <Link
            to="/org/$organizationSlug/apps"
            params={{ organizationSlug: slug }}
            onClick={() => sequence.report("finish_setup", "started", assistant)}
          >
            Open dashboard
            <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden />
          </Link>
        </Button>
      </SetupActions>
    </>
  );
}

function PromptText({ children }: { readonly children: ReactNode }) {
  return (
    <p className="p-4 text-[13px] leading-6 break-words whitespace-pre-line select-text max-sm:px-6">
      {children}
    </p>
  );
}

function PromptCopy({ prompt }: { readonly prompt: string | undefined }) {
  return (
    <div className="flex items-center border-t bg-muted/40 px-4 py-2.5 max-sm:px-6">
      <CopyButton
        code={prompt}
        label={prompt === undefined ? "Starter prompt loading" : "Copy starter prompt"}
        text="Copy prompt"
        variant="outline"
        size="sm"
        inline
      />
    </div>
  );
}

type Inventory = Atom.Success<ReturnType<typeof inventoryAtom>>;

function connectedAccounts(inventory: Inventory) {
  const apps = inventory.apps.flatMap((app) => {
    if (app.copiedFrom?.name === executorCatalogPackage) return [];
    const labels = inventory.links.flatMap((link) =>
      link.app === app.id
        ? inventory.accounts
            .filter((account) => account.id === link.account)
            .map((account) => account.label)
        : [],
    );
    return labels.length === 0 ? [] : [{ app: app.name, accounts: labels }];
  });
  return apps.length === 0 ? undefined : apps;
}

const list = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

const promptOpening = (endpoint: string) =>
  `Use Executor, which I connected over MCP at ${endpoint}. If you cannot see its tools yet, connect to that server first.`;

const firstPrompt = (
  endpoint: string,
  docsUrl: string,
  connected: ReturnType<typeof connectedAccounts>,
) =>
  `${promptOpening(endpoint)}\n\n${
    connected === undefined
      ? `Read the docs to understand the product at ${docsUrl}, then help me get my first app set up.`
      : `I've connected ${list.format(
          connected.map(({ app, accounts }) => `${app} (${list.format(accounts)})`),
        )}. Read the docs to understand the product at ${docsUrl}, then show me what you can do with them.`
  }`;

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
