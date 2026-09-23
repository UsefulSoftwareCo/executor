import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import claudeLogo from "../assets/logos/claude.svg?url";
import codexLogo from "../assets/logos/codex.svg?url";
import cursorLogo from "../assets/logos/cursor.svg?url";
import grokLogo from "../assets/logos/grok.svg?url";

const agentClients = {
  claude: {
    name: "Claude",
    logo: claudeLogo,
    project: "PostHog setup",
    nav: ["New chat", "Projects", "Recents"],
    hint: "Message Claude…",
  },
  codex: {
    name: "Codex",
    logo: codexLogo,
    project: "posthog",
    nav: ["New chat", "Pull requests", "Scheduled", "Plugins"],
    hint: "Ask Codex…",
  },
  grok: {
    name: "Grok Bot",
    logo: grokLogo,
    project: "Analytics bot",
    nav: ["Analytics bot", "Research bot", "General"],
    hint: "Message Analytics bot…",
  },
  cursor: {
    name: "Cursor",
    logo: cursorLogo,
    project: "posthog",
    nav: ["New chat", "Search", "Automations", "Customize"],
    hint: "Plan, build, or ask anything…",
  },
} as const;
type AgentId = keyof typeof agentClients;
const agentOrder = ["claude", "codex", "grok", "cursor"] as const;

const stages = [
  {
    id: "connect",
    step: 1,
    agent: "claude",
    prompt: "Hey, can you add the PostHog MCP?",
    action: "I’ll add it through Executor.",
    reply: "PostHog is connected. You can use this app from your other agents, too.",
    call: {
      kind: "deploy",
      name: "deployApp",
      file: "index.ts",
      change: "Added PostHog MCP tools",
      version: 1,
    },
  },
  {
    id: "find",
    step: 2,
    agent: "codex",
    prompt: "Can you read from Executor?",
    action: "I’ll check the apps you already have in Executor.",
    reply: "Yes. Your PostHog app and connected account are already here. No setup needed.",
    call: { kind: "lookup", name: "listApps" },
  },
  {
    id: "reads",
    step: 3,
    agent: "codex",
    prompt: "Can you make these queries read-only?",
    action: "I’ll update the same PostHog app to expose only read-only tools.",
    reply: "Done. The read-only rule applies wherever you use this app.",
    call: {
      kind: "deploy",
      name: "deployApp",
      file: "index.ts",
      change: "Keep only read-only tools",
      version: 2,
    },
  },
  {
    id: "cache",
    step: 4,
    agent: "grok",
    prompt: "Hi Grokbot, can you cache my PostHog queries?",
    action: "I found your read-only PostHog app in Executor. I’ll add query caching.",
    reply: "Deployed. Repeated queries now reuse saved results, with your read-only rule intact.",
    call: {
      kind: "deploy",
      name: "deployApp",
      file: "query-cache.ts",
      change: "Added caching for repeated queries",
      version: 3,
    },
  },
  {
    id: "ui",
    step: 5,
    agent: "cursor",
    prompt: "Make a dashboard from that data and give me a URL.",
    action: "I’ll add a web UI to your existing PostHog app and deploy it through Executor.",
    reply:
      "Your dashboard is ready. It uses the same account, read-only tools, and cached queries.",
    call: {
      kind: "deploy",
      name: "deployApp",
      file: "ui/main.tsx",
      change: "Added an analytics view",
      version: 4,
    },
  },
] as const;

type ComposerStage = (typeof stages)[number];

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const readReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;
const serverReducedMotion = () => false;
function subscribeReducedMotion(onChange: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

type TurnPlayback =
  | { readonly phase: "thinking" }
  | { readonly phase: "action"; readonly text: string }
  | { readonly phase: "tool" }
  | { readonly phase: "reply"; readonly text: string }
  | { readonly phase: "done" };

const thoughtDuration = 350;
const toolDuration = 950;
const characterDuration = 18;
const responsePause = 180;
const streamDuration = (text: string) => Math.max(500, text.length * characterDuration);
const turnDuration = (turn: ComposerStage) =>
  thoughtDuration +
  streamDuration(turn.action) +
  toolDuration +
  responsePause +
  streamDuration(turn.reply) +
  180 +
  (turn.id === "ui" ? 1400 : 0);

function turnPlayback(turn: ComposerStage, elapsed: number): TurnPlayback {
  const actionEnd = thoughtDuration + streamDuration(turn.action);
  const toolEnd = actionEnd + toolDuration;
  const replyStart = toolEnd + responsePause;
  if (elapsed < thoughtDuration) return { phase: "thinking" };
  if (elapsed < actionEnd)
    return {
      phase: "action",
      text: turn.action.slice(0, Math.ceil((elapsed - thoughtDuration) / characterDuration)),
    };
  if (elapsed < toolEnd) return { phase: "tool" };
  if (elapsed < replyStart + streamDuration(turn.reply))
    return {
      phase: "reply",
      text: turn.reply.slice(0, Math.max(0, Math.ceil((elapsed - replyStart) / characterDuration))),
    };
  return { phase: "done" };
}

function ThinkingIndicator({ agent }: { readonly agent: AgentId }) {
  return (
    <div
      className="chat-thinking flex items-center gap-1.25 h-5.75 [&_i]:w-1.25 [&_i]:h-1.25 [&_i]:rounded-[50%] [&_i]:bg-[#999] [&_i]:[animation:chat-think_1s_ease-in-out_infinite] [&_i:nth-child(2)]:[animation-delay:120ms] [&_i:nth-child(3)]:[animation-delay:240ms] [@media(prefers-reduced-motion:_reduce)]:[&_i]:[animation:none]"
      role="status"
      aria-label={`${agentClients[agent].name} is thinking`}
    >
      <i />
      <i />
      <i />
    </div>
  );
}

function AgentIdentity({ agent }: { readonly agent: AgentId }) {
  const client = agentClients[agent];
  return (
    <div className="demo-identity flex items-center gap-2 text-[13px] font-medium [&_img]:w-6 [&_img]:h-6 [&_img]:shrink-0 [&_img]:object-contain [@container(max-width:_639px)]:text-[14px] [@container(max-width:_639px)]:[&_img]:w-6.5 [@container(max-width:_639px)]:[&_img]:h-6.5 [.executor-chat_&]:text-[14px] [.handoff-sidebar_&]:gap-1.5 [.handoff-sidebar_&]:text-[12px] [.handoff-sidebar_&_img]:w-4.5 [.handoff-sidebar_&_img]:h-4.5 [.handoff-client-title_&]:text-[12px] [.handoff-client-title_&_img]:w-5 [.handoff-client-title_&_img]:h-5 [.handoff-client_&]:[color:var(--client-ink)]">
      <img src={client.logo} width="24" height="24" alt="" />
      <span>{client.name}</span>
    </div>
  );
}

function ExecutorCall({
  turn,
  status,
}: {
  readonly turn: ComposerStage;
  readonly status: "running" | "done";
}) {
  return (
    <details
      className="executor-call my-[6px] mx-0 [border:1px_solid_rgb(0_0_0_/_10%)] rounded-[8px] bg-[#fafafa] [&_summary]:flex [&_summary]:items-center [&_summary]:flex-wrap [&_summary]:gap-2.25 [&_summary]:py-[13px] [&_summary]:px-[14px] [&_summary]:text-[12px] [&_summary]:cursor-pointer [&_summary]:[list-style:none] [&_summary::-webkit-details-marker]:hidden [&_summary::after]:[content:'+'] [&_summary::after]:text-[#888] [&_summary::after]:[font:14px_var(--font-mono)] [&[open]_summary::after]:[content:'−'] [&_summary_>_code]:[font:11px_var(--font-mono)] [&_summary_>_code]:text-[#888] [&_summary_>_img]:shrink-0 [&_summary:focus-visible]:[outline:2px_solid_#555] [&_summary:focus-visible]:outline-offset-[-3px] max-[639px]:[&_summary]:p-[12px] max-[639px]:[&_summary]:text-[11px] max-[639px]:[&_summary]:gap-1.5 max-[639px]:[&_summary_>_code]:text-[10px] [animation:chat-appear_220ms_ease-out] [@media(prefers-reduced-motion:_reduce)]:[animation:none] [.handoff-client_&]:[background:var(--client-panel)] [.handoff-client_&]:[border-color:var(--client-rule)]"
      onToggle={(event) => {
        if (event.currentTarget.open) event.currentTarget.scrollIntoView({ block: "nearest" });
      }}
    >
      <summary>
        <img src="/favicon-192.png" width="18" height="18" alt="" />
        <span>Executor MCP</span>
        <code>{turn.call.name}</code>
        <span
          className="executor-call-done ml-auto [font:10px_var(--font-mono)] text-[#287359] [&[data-running='true']]:flex [&[data-running='true']]:items-center [&[data-running='true']]:gap-1.5 [&[data-running='true']]:text-[#888]"
          data-running={status === "running"}
        >
          {status === "running" ? (
            <>
              <i
                className="chat-tool-spinner inline-block w-2.5 h-2.5 [border:1px_solid_#ddd] [border-top-color:#777] rounded-[50%] [animation:chat-spin_800ms_linear_infinite] [@media(prefers-reduced-motion:_reduce)]:[animation:none]"
                aria-hidden="true"
              />
              {turn.call.kind === "lookup" ? "Reading…" : "Deploying…"}
            </>
          ) : (
            "✓ Done"
          )}
        </span>
      </summary>
      <div className="executor-call-detail [border-top:1px_solid_rgb(0_0_0_/_7%)] bg-[#fff] rounded-[0_0_8px_8px] overflow-hidden [&_>_p]:m-0 [&_>_p]:[padding:0_14px_14px] [&_>_p]:text-[12px] [&_>_p]:leading-[1.6] [&_>_p]:text-[#666] [.handoff-client_&]:[background:var(--client-bg)] [.handoff-client_&]:[border-color:var(--client-rule)] [.handoff-client_&_>_p]:[color:var(--client-muted)]">
        {status === "running" ? (
          <p className="executor-call-progress [.executor-call-detail_>_&]:p-[14px]" role="status">
            {turn.call.kind === "lookup"
              ? "Reading your configured apps from Executor…"
              : "Building and deploying the updated source…"}
          </p>
        ) : turn.call.kind === "lookup" ? (
          <div className="executor-lookup-result flex items-center flex-wrap gap-3.5 p-[18px] text-[11px] [color:var(--client-muted)] [&_strong]:font-medium [&_strong]:[color:var(--client-ink)]">
            <strong>PostHog</strong>
            <span>Account connected</span>
            <span>Ready to use</span>
          </div>
        ) : (
          <>
            <div className="executor-call-file flex justify-between gap-3 py-[12px] px-[14px] text-[11px] text-[#888] [&_code]:[font:11px_var(--font-mono)] [&_code]:text-[#555] max-[639px]:flex-col max-[639px]:gap-1.25 [.handoff-client_&_code]:[color:var(--client-ink)]">
              <code>{turn.call.file}</code>
              <span>{turn.call.change}</span>
            </div>
            {turn.id === "reads" ? (
              <pre className="executor-source m-0 p-[16px] [font:12px/1.8_var(--font-mono)] text-[#396353] overflow-x-auto bg-[#f5f8f6] max-[639px]:text-[10px] max-[639px]:p-[12px]">
                <code>{`const imported = await mcpTools(connection);

const tools = Object.fromEntries(
  Object.entries(imported).filter(
    ([, tool]) => tool.readOnly === true
  )
);`}</code>
              </pre>
            ) : (
              <p>{turn.call.change}.</p>
            )}
            <div className="executor-call-saved flex flex-wrap gap-3.5 py-[11px] px-[14px] [border-top:1px_solid_rgb(0_0_0_/_7%)] text-[#999] [font:10px_var(--font-mono)] [.handoff-client_&]:[border-color:var(--client-rule)]">
              <span>posthog</span>
              <span>v{turn.call.version} deployed</span>
              <span>Source retained</span>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

const demoAppUrl = "https://posthog.demo-org.executor.website";

function BrowserResult() {
  return (
    <div className="handoff-browser bg-[#f4f4f4] [&_iframe]:block [&_iframe]:border-0 [&_iframe]:w-full [&_iframe]:h-150 [&_iframe]:bg-[#fcfcfb] max-[639px]:[&_iframe]:h-152.5">
      <div className="handoff-browser-toolbar flex items-center gap-4 py-[14px] px-[18px] [border-bottom:1px_solid_#ddd] max-[639px]:gap-2.5 max-[639px]:p-[12px]">
        <div
          className="handoff-traffic flex items-center gap-1.25 [&_i]:w-1.5 [&_i]:h-1.5 [&_i]:rounded-[50%] [&_i]:bg-[#b3b1ab] [.handoff-client_&_i:nth-child(1)]:bg-[#ed6a5e] [.handoff-client_&_i:nth-child(2)]:bg-[#f4bd4f] [.handoff-client_&_i:nth-child(3)]:bg-[#62c554] max-[639px]:[.handoff-browser-toolbar_>_&]:hidden"
          aria-hidden="true"
        >
          <i />
          <i />
          <i />
        </div>
        <div className="handoff-address flex-1 flex items-center gap-2.5 min-w-0 py-[8px] px-[14px] bg-[#fff] [border:1px_solid_#ddd] rounded-[7px] text-[#888] [font:11px_var(--font-mono)] [&_a]:overflow-hidden [&_a]:text-ellipsis [&_a]:whitespace-nowrap [&_a]:text-[#666] [&_a]:no-underline max-[639px]:p-[8px]">
          <span aria-hidden="true">⌕</span>
          <a href="/demo/posthog" target="_blank" rel="noopener">
            {demoAppUrl}
          </a>
        </div>
        <a
          className="handoff-open shrink-0 text-[11px] text-[#888] no-underline"
          href="/demo/posthog"
          target="_blank"
          rel="noopener"
        >
          Open ↗
        </a>
      </div>
      <iframe src="/demo/posthog" title="PostHog dashboard built across four agents" />
    </div>
  );
}

function AssistantReply({
  turn,
  playback,
}: {
  readonly turn: ComposerStage;
  readonly playback: TurnPlayback;
}) {
  return (
    <div
      className="demo-assistant-message grid gap-2.25 pr-2 [&_>_p]:m-0 [&_>_p]:text-[14px] [&_>_p]:leading-[1.6] [&_>_p]:text-[#666] [&_>_p]:[text-wrap:pretty] [@container(max-width:_639px)]:[&_>_p]:text-[16px] [.executor-chat_&]:pr-0 [.executor-chat_&_>_p]:max-w-[64ch] max-[639px]:[.executor-chat_&_>_p]:text-[16px] [.handoff-client_&_>_p]:[color:var(--client-ink)] [.handoff-client_&_>_p]:text-[13px] [.handoff-client[data-client='grok']_&_>_p]:[background:var(--client-panel)] [.handoff-client[data-client='grok']_&_>_p]:py-[10px] [.handoff-client[data-client='grok']_&_>_p]:px-[12px] [.handoff-client[data-client='grok']_&_>_p]:rounded-[10px] [.handoff-client[data-client='grok']_&_>_p]:w-[fit-content] max-[639px]:[.handoff-client_&_>_p]:text-[16px]"
      aria-busy={playback.phase !== "done"}
    >
      <AgentIdentity agent={turn.agent} />
      {playback.phase === "thinking" ? (
        <ThinkingIndicator agent={turn.agent} />
      ) : (
        <p>
          {playback.phase === "action" ? playback.text : turn.action}
          {playback.phase === "action" && (
            <span
              className="chat-stream-cursor inline-block w-0.5 h-[1em] ml-0.75 [vertical-align:-0.1em] bg-[#999] [animation:chat-cursor_800ms_steps(2,_start)_infinite] [@media(prefers-reduced-motion:_reduce)]:[animation:none]"
              aria-hidden="true"
            />
          )}
        </p>
      )}
      {(playback.phase === "tool" || playback.phase === "reply" || playback.phase === "done") && (
        <ExecutorCall turn={turn} status={playback.phase === "tool" ? "running" : "done"} />
      )}
      {(playback.phase === "reply" || playback.phase === "done") && (
        <p>
          {playback.phase === "reply" ? playback.text : turn.reply}
          {playback.phase === "reply" && (
            <span
              className="chat-stream-cursor inline-block w-0.5 h-[1em] ml-0.75 [vertical-align:-0.1em] bg-[#999] [animation:chat-cursor_800ms_steps(2,_start)_infinite] [@media(prefers-reduced-motion:_reduce)]:[animation:none]"
              aria-hidden="true"
            />
          )}
        </p>
      )}
      {playback.phase === "done" && turn.id === "ui" && (
        <a
          className="handoff-result-link [.handoff-client_&]:block [.handoff-client_&]:py-[14px] [.handoff-client_&]:px-[16px] [.handoff-client_&]:[border:1px_solid_var(--client-rule)] [.handoff-client_&]:rounded-[7px] [.handoff-client_&]:[color:var(--client-ink)] [.handoff-client_&]:[font:12px_var(--font-mono)] [.handoff-client_&]:no-underline [.handoff-client_&]:[background:var(--client-panel)]"
          href="/demo/posthog"
          target="_blank"
          rel="noopener"
        >
          Open {demoAppUrl} ↗
        </a>
      )}
    </div>
  );
}

type ConversationPlayback =
  | {
      readonly phase: "draft";
      readonly previous: ComposerStage | null;
      readonly next: ComposerStage;
      readonly sentAt: number;
    }
  | {
      readonly phase: "reply";
      readonly turn: ComposerStage;
      readonly playback: TurnPlayback;
      readonly sinceSent: number;
    }
  | { readonly phase: "complete"; readonly turn: ComposerStage };

const promptPause = 1000;
const conversationDuration = stages.reduce(
  (duration, turn) => duration + promptPause + turnDuration(turn),
  0,
);

function conversationPlayback(elapsed: number): ConversationPlayback {
  let start = 0;
  let previous: ComposerStage | null = null;
  for (const turn of stages) {
    const sentAt = start + promptPause;
    if (elapsed < sentAt) return { phase: "draft", previous, next: turn, sentAt };
    const completedAt = sentAt + turnDuration(turn);
    if (elapsed < completedAt)
      return {
        phase: "reply",
        turn,
        playback: turnPlayback(turn, elapsed - sentAt),
        sinceSent: elapsed - sentAt,
      };
    start = completedAt;
    previous = turn;
  }
  return { phase: "complete", turn: stages[4] };
}

/** Example conversation that plays while its send control is visible and owns its timers. */
export function ChatThreadComposer() {
  const [elapsed, setElapsed] = useState(0);
  const [run, setRun] = useState(0);
  const [paused, setPaused] = useState(false);
  const progress = useRef(0);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    serverReducedMotion,
  );
  const sendButton = useRef<HTMLButtonElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const conversation = conversationPlayback(elapsed);
  const active = conversation.phase === "draft" ? conversation.previous : conversation.turn;
  const playback: TurnPlayback =
    conversation.phase === "reply" ? conversation.playback : { phase: "done" };

  const clientId =
    conversation.phase === "draft" ? conversation.next.agent : conversation.turn.agent;
  const client = agentClients[clientId];
  const jumpTo = (agent: AgentId | "browser") => {
    let start = 0;
    if (agent === "browser") start = conversationDuration;
    else {
      for (const turn of stages) {
        if (turn.agent === agent) break;
        start += promptPause + turnDuration(turn);
      }
    }
    progress.current = start;
    setElapsed(start);
    setPaused(false);
    setRun(run + 1);
  };

  useEffect(() => {
    if (sendButton.current === null || paused || progress.current >= conversationDuration) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    let visibleSince: number | null = null;
    let accumulated = progress.current;
    const publish = () => {
      const time = accumulated + (visibleSince === null ? 0 : performance.now() - visibleSince);
      progress.current = Math.min(conversationDuration, time);
      setElapsed(progress.current);
      if (progress.current >= conversationDuration) {
        clearInterval(timer);
        observer.disconnect();
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some(
          (entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5,
        );
        if (visible) {
          if (reducedMotion) {
            progress.current = conversationDuration;
            setElapsed(conversationDuration);
            observer.disconnect();
          } else if (visibleSince === null) {
            visibleSince = performance.now();
            timer = setInterval(publish, 30);
          }
        } else if (visibleSince !== null) {
          accumulated += performance.now() - visibleSince;
          visibleSince = null;
          clearInterval(timer);
          publish();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(sendButton.current);
    return () => {
      observer.disconnect();
      clearInterval(timer);
    };
  }, [run, paused, reducedMotion]);

  useLayoutEffect(() => {
    const container = history.current;
    if (container !== null) container.scrollTop = container.scrollHeight;
  }, [elapsed]);

  return (
    <div className="handoff-demo isolate mt-6 [border:1px_solid_rgb(0_0_0_/_12%)] rounded-[12px] overflow-hidden bg-[#fff] [&_button:focus-visible]:[outline:2px_solid_#888] [&_button:focus-visible]:outline-offset-[-3px]">
      <nav
        className="handoff-chapters flex items-center gap-1 py-[10px] px-[12px] [border-bottom:1px_solid_rgb(0_0_0_/_7%)] overflow-x-auto [&_button]:flex [&_button]:items-center [&_button]:justify-center [&_button]:gap-2 [&_button]:flex-1 [&_button]:whitespace-nowrap [&_button]:border-0 [&_button]:rounded-[6px] [&_button]:p-[9px] [&_button]:bg-transparent [&_button]:text-[#888] [&_button]:[font:12px_var(--font-sans)] [&_button]:cursor-pointer [&_button_img]:shrink-0 [&_button_img]:object-contain [&_button[aria-pressed='true']]:bg-[#f0efec] [&_button[aria-pressed='true']]:text-[#222] [&_button:hover]:bg-[#f6f5f3] max-[639px]:gap-0.75 max-[639px]:p-[8px] max-[639px]:[&_button]:min-h-11 max-[639px]:[&_button]:[flex:0_0_auto] max-[639px]:[&_button]:gap-1.5 max-[639px]:[&_button]:text-[11px] max-[639px]:[&_button]:p-[8px] max-[639px]:[&_button_img]:w-4.25 max-[639px]:[&_button_img]:h-4.25"
        aria-label="Follow the app across agents"
      >
        {agentOrder.map((agent) => (
          <button
            key={agent}
            type="button"
            aria-pressed={conversation.phase !== "complete" && clientId === agent}
            onClick={() => jumpTo(agent)}
          >
            <img src={agentClients[agent].logo} alt="" width="20" height="20" />
            <span>{agentClients[agent].name}</span>
          </button>
        ))}
        <button
          type="button"
          aria-pressed={conversation.phase === "complete"}
          onClick={() => jumpTo("browser")}
        >
          Browser ↗
        </button>
      </nav>
      {conversation.phase === "complete" ? (
        <BrowserResult />
      ) : (
        <div
          className="handoff-client [--client-bg:#faf9f6] [--client-sidebar:#f0efeb] [--client-panel:#fff] [--client-ink:#333] [--client-muted:#888] [--client-rule:rgb(0_0_0_/_8%)] [--client-bubble:#eeece7] grid grid-cols-[126px_minmax(0,_1fr)] [background:var(--client-bg)] [color:var(--client-ink)] [&[data-client='codex']]:[--client-bg:#ffffff] [&[data-client='codex']]:[--client-sidebar:#f8f8f8] [&[data-client='codex']]:[--client-panel:#ffffff] [&[data-client='codex']]:[--client-ink:#1a1c1f] [&[data-client='codex']]:[--client-muted:#777777] [&[data-client='codex']]:[--client-bubble:#f0f0f0] [&[data-client='codex']]:[--client-rule:rgb(0_0_0_/_9%)] [&[data-client='grok']]:[--client-bg:#ffffff] [&[data-client='grok']]:[--client-sidebar:#f8f8f8] [&[data-client='grok']]:[--client-panel:#eeeeee] [&[data-client='grok']]:[--client-ink:#171717] [&[data-client='grok']]:[--client-muted:#777777] [&[data-client='grok']]:[--client-bubble:#111111] [&[data-client='grok']]:[--client-rule:rgb(0_0_0_/_9%)] [&[data-client='cursor']]:[--client-bg:#f8f8f8] [&[data-client='cursor']]:[--client-sidebar:#f2f2f2] [&[data-client='cursor']]:[--client-panel:#ffffff] [&[data-client='cursor']]:[--client-ink:#262626] [&[data-client='cursor']]:[--client-muted:#808080] [&[data-client='cursor']]:[--client-bubble:#ededed] [&[data-client='cursor']]:[--client-rule:rgb(0_0_0_/_9%)] max-[639px]:grid-cols-1"
          data-client={clientId}
        >
          <aside
            className="handoff-sidebar min-w-0 flex flex-col gap-5 py-[15px] px-[11px] [background:var(--client-sidebar)] [border-right:1px_solid_var(--client-rule)] [&_>_small]:text-[9px] [&_>_small]:[color:var(--client-muted)] max-[639px]:hidden"
            aria-label={`${client.name} example sidebar`}
          >
            <div
              className="handoff-traffic flex items-center gap-1.25 [&_i]:w-1.5 [&_i]:h-1.5 [&_i]:rounded-[50%] [&_i]:bg-[#b3b1ab] [.handoff-client_&_i:nth-child(1)]:bg-[#ed6a5e] [.handoff-client_&_i:nth-child(2)]:bg-[#f4bd4f] [.handoff-client_&_i:nth-child(3)]:bg-[#62c554] max-[639px]:[.handoff-browser-toolbar_>_&]:hidden"
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
            </div>
            <AgentIdentity agent={clientId} />
            <div className="handoff-sidebar-nav grid gap-1.25 text-[10px] [color:var(--client-muted)] [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-1.5 [&_>_span]:py-[6px] [&_>_span]:px-[4px] [&_>_span]:rounded-[4px] [&_>_span[data-selected='true']]:bg-[#e7e7e7] [&_>_span[data-selected='true']]:text-[#222]">
              {client.nav.map((item, index) => (
                <span key={item} data-selected={clientId === "grok" && index === 0}>
                  {clientId === "grok" && (
                    <i
                      className="handoff-bot-dot w-4 h-4 shrink-0 bg-[#ce4698] rounded-[5px] [&[data-bot='1']]:bg-[#589574] [&[data-bot='1']]:rounded-[50%] [&[data-bot='2']]:bg-[#ad794b] [&[data-bot='2']]:rounded-[6px]"
                      data-bot={index}
                    />
                  )}
                  {item}
                </span>
              ))}
            </div>
            <small>{clientId === "grok" ? "Workspace" : "Projects"}</small>
            <span className="handoff-project py-[6px] px-[7px] -mt-3.25 text-[10px] rounded-[4px] [background:var(--client-bubble)] [.handoff-client[data-client='grok']_&]:bg-[#e7e7e7]">
              {clientId === "grok" ? "Personal" : "posthog"}
            </span>
            <div className="handoff-sidebar-bottom mt-auto [color:var(--client-muted)] text-[10px]">
              {clientId === "grok" ? "Marketplace" : "Settings"}
            </div>
          </aside>
          <div className="executor-chat mt-6 [border:1px_solid_rgb(0_0_0_/_12%)] rounded-[12px] overflow-hidden bg-[#fff] [&_button:focus-visible]:[outline:2px_solid_#555] [&_button:focus-visible]:outline-offset-[-3px] [.handoff-client_&]:m-0 [.handoff-client_&]:border-0 [.handoff-client_&]:rounded-none [.handoff-client_&]:[background:var(--client-bg)] [.handoff-client_&]:[color:var(--client-ink)] [.handoff-client_&]:min-w-0">
            <div className="executor-chat-header flex items-center gap-5 py-[18px] px-[24px] [border-bottom:1px_solid_rgb(0_0_0_/_7%)] [&_>_span]:flex [&_>_span]:items-center [&_>_span]:gap-1.5 [&_>_span]:text-[#888] [&_>_span]:text-[11px] [&_small]:ml-auto [&_small]:[font:10px_var(--font-mono)] [&_small]:text-[#999] max-[639px]:p-[16px] max-[639px]:flex-wrap max-[639px]:[&_small]:text-[9px] max-[639px]:gap-2.5 [.handoff-client_&]:py-[16px] [.handoff-client_&]:px-[20px] [.handoff-client_&]:[border-color:var(--client-rule)] [.handoff-client_&]:min-h-14.5 max-[639px]:[.handoff-client_&]:p-[14px]">
              <div className="handoff-client-title flex items-center gap-4 min-w-0 [&_>_span]:text-[10px] [&_>_span]:[color:var(--client-muted)] max-[639px]:gap-2.5 max-[639px]:[&_>_span]:text-[9px]">
                <AgentIdentity agent={clientId} />
                <span>{client.project}</span>
              </div>
              <button
                type="button"
                className="chat-playback-control ml-auto py-[6px] px-[8px] [border:1px_solid_rgb(0_0_0_/_10%)] rounded-[5px] bg-[#fff] text-[#777] [font:11px_var(--font-sans)] cursor-pointer hover:bg-[#f5f5f5] max-[639px]:min-h-9 [.handoff-client_&]:bg-transparent [.handoff-client_&]:[border-color:var(--client-rule)] [.handoff-client_&]:[color:var(--client-muted)]"
                onClick={() => setPaused(!paused)}
              >
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
            {clientId === "cursor" && (
              <div className="handoff-cursor-tabs flex items-center gap-4.5 py-[9px] px-[20px] [color:var(--client-muted)] text-[10px] [border-bottom:1px_solid_var(--client-rule)] [&_>_:first-child]:[color:var(--client-ink)]">
                <span>Agent</span>
                <span>Changes</span>
                <span>Browser</span>
                <span>Files</span>
              </div>
            )}
            <div
              className="executor-chat-history h-107.5 py-[28px] px-[32px] overflow-hidden max-[639px]:h-110 max-[639px]:py-[22px] max-[639px]:px-[16px] [.handoff-client_&]:h-90 [.handoff-client_&]:p-[24px] [.handoff-client[data-client='cursor']_&]:h-81.25 max-[639px]:[.handoff-client_&]:h-90 max-[639px]:[.handoff-client_&]:py-[20px] max-[639px]:[.handoff-client_&]:px-[16px]"
              ref={history}
              role="log"
              aria-label={`${client.name} conversation using Executor`}
            >
              {active === null || active.agent !== clientId ? (
                <div className="handoff-welcome grid gap-3.5 [color:var(--client-muted)] [&_p]:text-[13px] [&_p]:leading-[1.6] [&_p]:m-0">
                  <AgentIdentity agent={clientId} />
                  <p>
                    {clientId === "claude"
                      ? "What would you like to build?"
                      : `Continue in ${client.name}. Your apps are already in Executor.`}
                  </p>
                </div>
              ) : (
                stages
                  .filter((turn) => turn.step <= active.step && turn.agent === clientId)
                  .map((turn) => (
                    <div
                      className="executor-chat-turn flex flex-col gap-5.5 [.executor-chat-turn_+_&]:mt-8 [.executor-chat-turn_+_&]:pt-7 [.executor-chat-turn_+_&]:[border-top:1px_solid_rgb(0_0_0_/_5%)] [animation:chat-appear_180ms_ease-out] [@media(prefers-reduced-motion:_reduce)]:[animation:none] [.handoff-client_.executor-chat-turn_+_&]:[border-color:var(--client-rule)]"
                      key={turn.id}
                    >
                      <div className="demo-user-message self-end flex flex-col gap-1.75 max-w-[92%] [&_p]:m-0 [&_p]:py-[13px] [&_p]:px-[16px] [&_p]:rounded-[14px_14px_3px_14px] [&_p]:bg-[#f1efeb] [&_p]:text-[14px] [&_p]:leading-[1.6] [&_p]:[text-wrap:pretty] [@container(max-width:_639px)]:[&_p]:text-[16px] [.executor-chat_&]:max-w-[85%] max-[639px]:[.executor-chat_&]:max-w-[95%] max-[639px]:[.executor-chat_&_p]:text-[16px] [.handoff-client_&_p]:[background:var(--client-bubble)] [.handoff-client_&_p]:[color:var(--client-ink)] [.handoff-client_&_p]:text-[13px] [.handoff-client[data-client='grok']_&_p]:rounded-[12px] [.handoff-client[data-client='grok']_&_p]:text-[#fff] max-[639px]:[.handoff-client_&_p]:text-[16px]">
                        <div className="demo-speaker text-[#888] text-[11px] font-medium [.demo-user-message_&]:text-right">
                          You
                        </div>
                        <p>{turn.prompt}</p>
                      </div>
                      <AssistantReply
                        turn={turn}
                        playback={turn.id === active.id ? playback : { phase: "done" }}
                      />
                    </div>
                  ))
              )}
            </div>
            <div className="executor-chat-compose [border-top:1px_solid_rgb(0_0_0_/_7%)] py-[18px] px-[24px] max-[639px]:p-[16px] [.handoff-client_&]:py-[16px] [.handoff-client_&]:px-[20px] [.handoff-client_&]:[border-color:var(--client-rule)] max-[639px]:[.handoff-client_&]:p-[14px]">
              <div className="demo-compose-label text-[#888] text-[11px] [padding:0_2px_8px]">
                You
              </div>
              <div className="demo-compose-box flex flex-col gap-2 p-[12px] [border:1px_solid_rgb(0_0_0_/_15%)] rounded-[10px] bg-[#fff] [&_textarea]:[resize:none] [&_textarea]:w-full [&_textarea]:p-0 [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:[font:14px/1.5_var(--font-sans)] [&_textarea]:text-[#333] [&_textarea:focus-visible]:[outline:2px_solid_#888] [&_textarea:focus-visible]:outline-offset-0 [&_textarea:focus-visible]:rounded-[3px] [@container(max-width:_639px)]:[&_textarea]:text-[16px] [.executor-chat_&]:flex-row [.executor-chat_&]:items-center [.executor-chat_&_textarea]:min-w-0 [.executor-chat_&_textarea]:flex-1 max-[639px]:[.executor-chat_&]:flex-col max-[639px]:[.executor-chat_&]:items-stretch max-[639px]:[.executor-chat_&_textarea]:text-[16px] [.executor-chat_&_textarea:disabled]:cursor-not-allowed [.executor-chat_&_textarea:disabled]:opacity-60 [.handoff-client_&]:[background:var(--client-panel)] [.handoff-client_&]:[border-color:var(--client-rule)] [.handoff-client_&_textarea]:[color:var(--client-ink)] [.handoff-client_&_textarea]:text-[13px] [.handoff-client_&_textarea::placeholder]:[color:var(--client-muted)] max-[639px]:[.handoff-client_&_textarea]:text-[16px] max-[639px]:[.handoff-client_&]:flex-col">
                <textarea
                  name="example-prompt"
                  aria-label={`Prompt sent to ${client.name} in this example`}
                  readOnly
                  disabled={conversation.phase !== "draft"}
                  rows={2}
                  placeholder={client.hint}
                  value={conversation.phase === "draft" ? conversation.next.prompt : ""}
                />
                <button
                  ref={sendButton}
                  type="button"
                  className="demo-send inline-flex items-center justify-center gap-3.5 self-end py-[7px] px-[10px] min-h-8.5 [border:1px_solid_rgb(0_0_0_/_12%)] rounded-[6px] bg-[#f6f5f3] [font:12px_var(--font-sans)] text-[#333] cursor-pointer hover:bg-[#eeece8] [@media(pointer:_coarse)]:min-h-12 [.executor-chat_&]:shrink-0 [.executor-chat_&]:self-center max-[639px]:[.executor-chat_&]:self-end max-[639px]:[.executor-chat_&]:min-h-11 [.executor-chat_&:disabled]:opacity-100 [.executor-chat_&:disabled]:cursor-not-allowed [.executor-chat_&:disabled]:bg-[#e5e5e5] [.executor-chat_&:disabled]:text-[#707070] [.executor-chat_&:disabled]:border-[#dedede] [.executor-chat_&]:[transition:transform_120ms_ease] [.executor-chat_&[data-sending='true']]:[transform:translateY(1px)_scale(0.96)] [.executor-chat_&[data-sending='true']]:bg-[#e6e4df] [.executor-chat_&[data-sending='true']]:opacity-100 [@media(prefers-reduced-motion:_reduce)]:[.executor-chat_&]:[transition:none] [@media(prefers-reduced-motion:_reduce)]:[.executor-chat_&[data-sending='true']]:[transform:none] [.handoff-client_&]:bg-[#242424] [.handoff-client_&]:border-[#242424] [.handoff-client_&]:text-[#fff] [.handoff-client_&[data-sending='true']]:bg-[#3d3d3d] [.handoff-client_&[data-sending='true']]:border-[#3d3d3d] [.handoff-client_&[data-sending='true']]:text-[#fff] [.handoff-client_&[data-sending='true']]:opacity-100 max-[639px]:[.handoff-client_&]:self-end"
                  disabled={conversation.phase !== "draft"}
                  data-sending={conversation.phase === "reply" && conversation.sinceSent < 200}
                  onClick={() => {
                    if (conversation.phase !== "draft") return;
                    progress.current = conversation.sentAt;
                    setElapsed(conversation.sentAt);
                    setPaused(false);
                    setRun(run + 1);
                  }}
                >
                  Send prompt <span aria-hidden="true">↑</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
