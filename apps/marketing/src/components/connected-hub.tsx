import { useRef, type ReactNode, type RefObject } from "react";
import { AnimatedBeam } from "./ui/animated-beam";
import { cn } from "../lib/utils";
import { logoClass } from "../lib/logos";

import gmailLogo from "../assets/logos/gmail.svg?url";
import calendarLogo from "../assets/logos/google-calendar.svg?url";
import githubLogo from "../assets/logos/github.svg?url";
import stripeLogo from "../assets/logos/stripe.svg?url";
import linearLogo from "../assets/logos/linear.svg?url";
import claudeLogo from "../assets/logos/claude.svg?url";
import codexLogo from "../assets/logos/codex.svg?url";
import cursorLogo from "../assets/logos/cursor.svg?url";
import chatgptLogo from "../assets/logos/chatgpt.svg?url";
import geminiLogo from "../assets/logos/gemini.svg?url";

const services = [
  { name: "Gmail", key: "gmail", logo: gmailLogo },
  { name: "Calendar", key: "google-calendar", logo: calendarLogo },
  { name: "GitHub", key: "github", logo: githubLogo },
  { name: "Stripe", key: "stripe", logo: stripeLogo },
  { name: "Linear", key: "linear", logo: linearLogo },
] as const;

const agents = [
  { name: "Claude Code", key: "claude", logo: claudeLogo },
  { name: "Codex", key: "codex", logo: codexLogo },
  { name: "Cursor", key: "cursor", logo: cursorLogo },
  { name: "ChatGPT", key: "chatgpt", logo: chatgptLogo },
  { name: "Gemini", key: "gemini", logo: geminiLogo },
] as const;

// Beams draw in currentColor, so the theme's ink colour carries into dark mode.
const beam = {
  pathColor: "currentColor",
  pathOpacity: 0.14,
  pathWidth: 1.25,
  gradientStartColor: "currentColor",
  gradientStopColor: "currentColor",
  duration: 4,
} as const;

function Endpoint({
  nodeRef,
  name,
  logoKey,
  logo,
  side,
}: {
  readonly nodeRef: RefObject<HTMLDivElement | null>;
  readonly name: string;
  readonly logoKey: string;
  readonly logo: string;
  readonly side: "left" | "right";
}) {
  return (
    <div className={cn("flex items-center gap-2.5", side === "right" && "flex-row-reverse")}>
      <span className="hidden text-[12.5px] text-tone-40 @min-[560px]:inline">{name}</span>
      <div
        ref={nodeRef}
        className="relative z-10 grid size-9 shrink-0 place-items-center rounded-[8px] border border-tone-89 bg-tone-100"
      >
        <img
          src={logo}
          alt={name}
          width="18"
          height="18"
          className={cn("size-4.5 object-contain", logoClass(logoKey))}
        />
      </div>
    </div>
  );
}

function Column({
  children,
  align,
}: {
  readonly children: ReactNode;
  readonly align: "start" | "end";
}) {
  return (
    <div className={cn("flex flex-col gap-3.5", align === "end" ? "items-end" : "items-start")}>
      {children}
    </div>
  );
}

// One endpoint and its beam to the hub. Each spoke owns its node's ref.
function Spoke({
  item,
  side,
  index,
  container,
  hub,
}: {
  readonly item: { readonly name: string; readonly key: string; readonly logo: string };
  readonly side: "left" | "right";
  readonly index: number;
  readonly container: RefObject<HTMLDivElement | null>;
  readonly hub: RefObject<HTMLDivElement | null>;
}) {
  const node = useRef<HTMLDivElement>(null);
  const isService = side === "left";
  return (
    <>
      <Endpoint nodeRef={node} name={item.name} logoKey={item.key} logo={item.logo} side={side} />
      <AnimatedBeam
        {...beam}
        containerRef={container}
        fromRef={isService ? node : hub}
        toRef={isService ? hub : node}
        curvature={isService ? (index - 2) * -14 : (index - 2) * 14}
        delay={isService ? index * 0.35 : 0.9 + index * 0.35}
      />
    </>
  );
}

export function ConnectedHub() {
  const container = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);

  return (
    <figure className="@container mt-7 max-w-225 overflow-hidden rounded-[10px] border border-tone-90 bg-tone-98">
      <div
        ref={container}
        className="relative grid grid-cols-[auto_1fr_auto] items-center gap-4 px-5 py-7 text-ink @min-[560px]:px-9 @min-[560px]:py-9"
      >
        <Column align="end">
          {services.map((service, i) => (
            <Spoke
              key={service.key}
              item={service}
              side="left"
              index={i}
              container={container}
              hub={hub}
            />
          ))}
        </Column>

        <div className="flex justify-center">
          <div
            ref={hub}
            className="relative z-10 flex flex-col items-center gap-2 rounded-[12px] border border-tone-80 bg-tone-100 px-4 py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)]"
          >
            <img
              src="/favicon-192.png"
              alt=""
              width="28"
              height="28"
              className="logo-mono size-7"
            />
            <span className="text-[13px] font-medium text-tone-20">Executor</span>
          </div>
        </div>

        <Column align="start">
          {agents.map((agent, i) => (
            <Spoke
              key={agent.key}
              item={agent}
              side="right"
              index={i}
              container={container}
              hub={hub}
            />
          ))}
        </Column>
      </div>
    </figure>
  );
}
