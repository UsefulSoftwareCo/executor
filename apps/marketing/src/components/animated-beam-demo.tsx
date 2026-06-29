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
    nodeBg: string;
    nodeBorder: string;
    nodeRadius: string;
    hubBg: string;
    hubBorder: string;
    label: string;
    sub: string;
    beam: string;
    path: string;
    pathOpacity: number;
    pathWidth: number;
  }
> = {
  blueprint: {
    nodeBg: "#f6f4ec",
    nodeBorder: "rgba(10,10,10,0.18)",
    nodeRadius: "6px",
    hubBg: "#f6f4ec",
    hubBorder: "#1a3aff",
    label: "#0a0a0a",
    sub: "#8a8a82",
    beam: "#1a3aff",
    path: "rgba(10,10,10,0.18)",
    pathOpacity: 0.3,
    pathWidth: 1,
  },
  brutalist: {
    nodeBg: "#ffffff",
    nodeBorder: "#000000",
    nodeRadius: "0px",
    hubBg: "#000000",
    hubBorder: "#000000",
    label: "#000000",
    sub: "#000000",
    beam: "#f0ff00",
    path: "rgba(0,0,0,0.5)",
    pathOpacity: 1,
    pathWidth: 2,
  },
  pastel: {
    nodeBg: "#ffffff",
    nodeBorder: "rgba(42,32,28,0.12)",
    nodeRadius: "12px",
    hubBg: "#ffffff",
    hubBorder: "#c45a3a",
    label: "#2a201c",
    sub: "#6b5b53",
    beam: "#c45a3a",
    path: "rgba(42,32,28,0.15)",
    pathOpacity: 0.6,
    pathWidth: 1.5,
  },
  cyber: {
    nodeBg: "#0e0e1a",
    nodeBorder: "rgba(255,255,255,0.18)",
    nodeRadius: "4px",
    hubBg: "#0e0e1a",
    hubBorder: "#ff2a86",
    label: "#f0f0f5",
    sub: "#6c6c85",
    beam: "#00f0ff",
    path: "rgba(255,255,255,0.18)",
    pathOpacity: 0.5,
    pathWidth: 1,
  },
  editorial: {
    nodeBg: "#f4ede0",
    nodeBorder: "rgba(42,31,21,0.28)",
    nodeRadius: "9999px",
    hubBg: "#f4ede0",
    hubBorder: "#a14628",
    label: "#2a1f15",
    sub: "#a89884",
    beam: "#a14628",
    path: "rgba(42,31,21,0.22)",
    pathOpacity: 0.5,
    pathWidth: 1,
  },
  stripe: {
    nodeBg: "#ffffff",
    nodeBorder: "rgba(10,37,64,0.10)",
    nodeRadius: "10px",
    hubBg: "#ffffff",
    hubBorder: "#111111",
    label: "#0a0a0a",
    sub: "#6b6b6b",
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
    style?: React.CSSProperties;
  }
>(({ className, children, size = "sm", style }, ref) => {
  return (
    <div
      ref={ref}
      style={style}
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
  const nodeStyle: React.CSSProperties = {
    background: v.nodeBg,
    border: `1px solid ${v.nodeBorder}`,
    borderRadius: v.nodeRadius,
  };
  const hubStyle: React.CSSProperties = {
    background: v.hubBg,
    border: `${variant === "brutalist" ? "2px" : "1px"} solid ${v.hubBorder}`,
    borderRadius: v.nodeRadius,
  };
  const labelStyle: React.CSSProperties = { color: v.label };
  const subStyle: React.CSSProperties = { color: v.sub };

  return (
    <div
      ref={containerRef}
      className={cn("relative flex w-full items-center justify-center py-2", className)}
    >
      <div className="flex w-full flex-row items-stretch justify-between gap-6 sm:gap-8">
        {/* Agents (left) */}
        <div className="flex flex-col justify-center gap-7">
          <Row label="Claude Code" reverse={false} labelStyle={labelStyle}>
            <Node ref={agent1} style={nodeStyle}>
              <Icons.claude />
            </Node>
          </Row>
          <Row label="Cursor" reverse={false} labelStyle={labelStyle}>
            <Node ref={agent2} style={nodeStyle}>
              <Icons.cursor />
            </Node>
          </Row>
          <Row label="Codex" reverse={false} labelStyle={labelStyle}>
            <Node ref={agent3} style={nodeStyle}>
              <Icons.codex />
            </Node>
          </Row>
        </div>

        {/* Hub (center) */}
        <div className="flex flex-col justify-center">
          <Node ref={hub} size="lg" style={hubStyle}>
            <img
              src="/favicon-192.png"
              alt="Executor"
              className="w-full h-full object-contain"
              style={
                variant === "cyber" || variant === "brutalist" ? { filter: "invert(1)" } : undefined
              }
            />
          </Node>
        </div>

        {/* Tools (right) */}
        <div className="flex flex-col justify-center gap-7">
          <Row label="Sentry" sub="OpenAPI" reverse labelStyle={labelStyle} subStyle={subStyle}>
            <Node ref={tool1} style={nodeStyle}>
              <Icons.sentry />
            </Node>
          </Row>
          <Row label="GitHub" sub="GraphQL" reverse labelStyle={labelStyle} subStyle={subStyle}>
            <Node ref={tool2} style={nodeStyle}>
              <Icons.github />
            </Node>
          </Row>
          <Row label="Linear" sub="MCP" reverse labelStyle={labelStyle} subStyle={subStyle}>
            <Node ref={tool3} style={nodeStyle}>
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
  labelStyle,
  subStyle,
}: {
  children: React.ReactNode;
  label: string;
  sub?: string;
  reverse: boolean;
  labelStyle?: React.CSSProperties;
  subStyle?: React.CSSProperties;
}) {
  return (
    <div className={cn("flex items-center gap-3", reverse && "flex-row-reverse text-right")}>
      {children}
      <div className="flex flex-col leading-tight">
        <span className="text-[12px] font-medium" style={labelStyle}>
          {label}
        </span>
        {sub ? (
          <span className="font-mono text-[10px] tracking-tight" style={subStyle}>
            {sub}
          </span>
        ) : null}
      </div>
    </div>
  );
}

const logoIcon = (src: string) => () => (
  <img src={src} alt="" className="w-full h-full" style={{ objectFit: "contain" }} loading="lazy" />
);

const Icons = {
  sentry: logoIcon(sentryLogo),
  github: logoIcon(githubLogo),
  linear: logoIcon(linearLogo),
  claude: logoIcon(claudeLogo),
  cursor: logoIcon(cursorLogo),
  codex: logoIcon(codexLogo),
};
