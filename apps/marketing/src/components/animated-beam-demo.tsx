"use client";

import React, { forwardRef, useRef } from "react";

import { cn } from "../lib/utils";
import { AnimatedBeam } from "./ui/animated-beam";

// Imported so Vite emits them as hashed build assets (served from /_astro/...);
// the deploy pipeline does not pick up newly added /public files.
import sentryLogo from "../assets/logos/sentry.svg?url";
import githubLogo from "../assets/logos/github.svg?url";
import linearLogo from "../assets/logos/linear.svg?url";
import claudeLogo from "../assets/logos/claude.svg?url";
import cursorLogo from "../assets/logos/cursor.svg?url";
import codexLogo from "../assets/logos/codex.svg?url";

type Variant = "blueprint" | "brutalist" | "pastel" | "cyber" | "editorial" | "stripe";

const variantStyles: Record<
  Variant,
  {
    nodeClass: string;
    hubClass: string;
    labelClass: string;
    subClass: string;
    beam: string;
    path: string;
    pathOpacity: number;
    pathWidth: number;
  }
> = {
  blueprint: {
    nodeClass: "bg-[#f6f4ec] border border-[rgba(10,10,10,0.18)] rounded-[6px]",
    hubClass: "bg-[#f6f4ec] border border-[#1a3aff] rounded-[6px]",
    labelClass: "text-[#0a0a0a]",
    subClass: "text-[#8a8a82]",
    beam: "#1a3aff",
    path: "rgba(10,10,10,0.18)",
    pathOpacity: 0.3,
    pathWidth: 1,
  },
  brutalist: {
    nodeClass: "bg-[#ffffff] border border-[#000000] rounded-[0px]",
    hubClass: "bg-[#000000] border-2 border-[#000000] rounded-[0px]",
    labelClass: "text-[#000000]",
    subClass: "text-[#000000]",
    beam: "#f0ff00",
    path: "rgba(0,0,0,0.5)",
    pathOpacity: 1,
    pathWidth: 2,
  },
  pastel: {
    nodeClass: "bg-[#ffffff] border border-[rgba(42,32,28,0.12)] rounded-[12px]",
    hubClass: "bg-[#ffffff] border border-[#c45a3a] rounded-[12px]",
    labelClass: "text-[#2a201c]",
    subClass: "text-[#6b5b53]",
    beam: "#c45a3a",
    path: "rgba(42,32,28,0.15)",
    pathOpacity: 0.6,
    pathWidth: 1.5,
  },
  cyber: {
    nodeClass: "bg-[#0e0e1a] border border-[rgba(255,255,255,0.18)] rounded-[4px]",
    hubClass: "bg-[#0e0e1a] border border-[#ff2a86] rounded-[4px]",
    labelClass: "text-[#f0f0f5]",
    subClass: "text-[#6c6c85]",
    beam: "#00f0ff",
    path: "rgba(255,255,255,0.18)",
    pathOpacity: 0.5,
    pathWidth: 1,
  },
  editorial: {
    nodeClass: "bg-[#f4ede0] border border-[rgba(42,31,21,0.28)] rounded-[9999px]",
    hubClass: "bg-[#f4ede0] border border-[#a14628] rounded-[9999px]",
    labelClass: "text-[#2a1f15]",
    subClass: "text-[#a89884]",
    beam: "#a14628",
    path: "rgba(42,31,21,0.22)",
    pathOpacity: 0.5,
    pathWidth: 1,
  },
  stripe: {
    nodeClass: "bg-[#ffffff] border border-[rgba(10,37,64,0.10)] rounded-[10px]",
    hubClass: "bg-[#ffffff] border border-[#111111] rounded-[10px]",
    labelClass: "text-[#0a0a0a]",
    subClass: "text-[#6b6b6b]",
    beam: "#111111",
    path: "rgba(10,37,64,0.10)",
    pathOpacity: 0.4,
    pathWidth: 1.25,
  },
};

const Node = forwardRef<
  HTMLDivElement,
  {
    className?: string;
    children?: React.ReactNode;
    size?: "sm" | "lg";
  }
>(({ className, children, size = "sm" }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        "z-10 flex items-center justify-center",
        size === "sm" ? "size-10 p-2" : "size-16 p-2",
        className,
      )}
    >
      {children}
    </div>
  );
});
Node.displayName = "Node";

export function AnimatedBeamDemo({
  className,
  variant = "blueprint",
}: {
  className?: string;
  variant?: Variant;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const agent1 = useRef<HTMLDivElement>(null);
  const agent2 = useRef<HTMLDivElement>(null);
  const agent3 = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const tool1 = useRef<HTMLDivElement>(null);
  const tool2 = useRef<HTMLDivElement>(null);
  const tool3 = useRef<HTMLDivElement>(null);

  const v = variantStyles[variant];
  const beamColor = v.beam;
  const pathColor = v.path;
  const pathOpacity = v.pathOpacity;
  const pathWidth = v.pathWidth;

  return (
    <div
      ref={containerRef}
      className={cn("relative flex w-full items-center justify-center py-2", className)}
    >
      <div className="flex w-full flex-row items-stretch justify-between gap-6 sm:gap-8">
        {/* Agents (left) */}
        <div className="flex flex-col justify-center gap-7">
          <Row label="Claude Code" reverse={false} labelClass={v.labelClass}>
            <Node ref={agent1} className={v.nodeClass}>
              <Icons.claude />
            </Node>
          </Row>
          <Row label="Cursor" reverse={false} labelClass={v.labelClass}>
            <Node ref={agent2} className={v.nodeClass}>
              <Icons.cursor />
            </Node>
          </Row>
          <Row label="Codex" reverse={false} labelClass={v.labelClass}>
            <Node ref={agent3} className={v.nodeClass}>
              <Icons.codex />
            </Node>
          </Row>
        </div>

        {/* Hub (center) */}
        <div className="flex flex-col justify-center">
          <Node ref={hub} size="lg" className={v.hubClass}>
            <img
              src="/favicon-192.png"
              alt="Executor"
              className={cn(
                "w-full h-full object-contain",
                (variant === "cyber" || variant === "brutalist") && "invert",
              )}
            />
          </Node>
        </div>

        {/* Tools (right) */}
        <div className="flex flex-col justify-center gap-7">
          <Row label="Sentry" sub="OpenAPI" reverse labelClass={v.labelClass} subClass={v.subClass}>
            <Node ref={tool1} className={v.nodeClass}>
              <Icons.sentry />
            </Node>
          </Row>
          <Row label="GitHub" sub="GraphQL" reverse labelClass={v.labelClass} subClass={v.subClass}>
            <Node ref={tool2} className={v.nodeClass}>
              <Icons.github />
            </Node>
          </Row>
          <Row label="Linear" sub="MCP" reverse labelClass={v.labelClass} subClass={v.subClass}>
            <Node ref={tool3} className={v.nodeClass}>
              <Icons.linear />
            </Node>
          </Row>
        </div>
      </div>

      {/* Beams: agents → hub */}
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={agent1}
        toRef={hub}
        curvature={-50}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={agent2}
        toRef={hub}
        curvature={0}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
        delay={0.3}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={agent3}
        toRef={hub}
        curvature={50}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
        delay={0.6}
      />

      {/* Beams: hub → tools */}
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={hub}
        toRef={tool1}
        curvature={50}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
        delay={0.15}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={hub}
        toRef={tool2}
        curvature={0}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
        delay={0.45}
      />
      <AnimatedBeam
        containerRef={containerRef}
        fromRef={hub}
        toRef={tool3}
        curvature={-50}
        pathColor={pathColor}
        pathOpacity={pathOpacity}
        pathWidth={pathWidth}
        gradientStartColor={beamColor}
        gradientStopColor={beamColor}
        duration={4}
        delay={0.75}
      />
    </div>
  );
}

function Row({
  children,
  label,
  sub,
  reverse,
  labelClass,
  subClass,
}: {
  children: React.ReactNode;
  label: string;
  sub?: string;
  reverse: boolean;
  labelClass?: string;
  subClass?: string;
}) {
  return (
    <div className={cn("flex items-center gap-3", reverse && "flex-row-reverse text-right")}>
      {children}
      <div className="relative z-10 flex flex-col leading-tight rounded bg-white px-1 -mx-1">
        <span className={cn("text-[12px] font-medium", labelClass)}>{label}</span>
        {sub ? (
          <span className={cn("font-mono text-[10px] tracking-tight", subClass)}>{sub}</span>
        ) : null}
      </div>
    </div>
  );
}

const logoIcon = (src: string) => () => (
  <img src={src} alt="" className="w-full h-full object-contain" loading="lazy" />
);

const Icons = {
  sentry: logoIcon(sentryLogo),
  github: logoIcon(githubLogo),
  linear: logoIcon(linearLogo),
  claude: logoIcon(claudeLogo),
  cursor: logoIcon(cursorLogo),
  codex: logoIcon(codexLogo),
};
