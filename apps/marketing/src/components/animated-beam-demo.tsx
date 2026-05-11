"use client";

import React, { forwardRef, useRef } from "react";

import { cn } from "../lib/utils";
import { AnimatedBeam } from "./ui/animated-beam";

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
    hubBorder: "#635bff",
    label: "#0a2540",
    sub: "#8898a4",
    beam: "#635bff",
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
              <Icons.openai />
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

const Icons = {
  sentry: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[#362D59]">
      <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z" />
    </svg>
  ),
  github: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[var(--color-ink)]">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  ),
  linear: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[#5E6AD2]">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  ),
  claude: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[#D97757]">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  ),
  cursor: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[var(--color-ink)]">
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  ),
  openai: () => (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full text-[var(--color-ink)]">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  ),
};
