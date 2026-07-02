import type { ReactNode } from "react";

import { Wordmark } from "@executor-js/react/components/wordmark";

// Split auth layout for the chromeless pages (setup, login, join): a promo
// panel on the left, the form on the right. The panel follows design.md's
// registry-minimal rules — graph-paper texture, mono eyebrow + index numerals,
// grayscale only — so the first screen a person ever sees speaks the same
// language as the app behind it. Collapses to form-only below lg.
const PANEL_POINTS: ReadonlyArray<{ index: string; title: string; body: string }> = [
  {
    index: "01",
    title: "Connect",
    body: "OpenAPI, GraphQL, and MCP sources become tools your agent can call.",
  },
  {
    index: "02",
    title: "Control",
    body: "Policies decide which tools run, which ask first, and which are blocked.",
  },
  {
    index: "03",
    title: "Audit",
    body: "Every invocation is recorded, with approvals where they matter.",
  },
];

export function AuthLayout(props: { readonly children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-12 lg:flex">
        {/* Graph-paper texture, faded toward the bottom (design.md signature). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 text-foreground opacity-[0.05]"
          style={{
            backgroundImage:
              "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
            backgroundSize: "32px 32px",
            maskImage: "linear-gradient(to bottom, black 30%, transparent 85%)",
          }}
        />

        <div className="relative">
          <Wordmark />
        </div>

        <div className="relative max-w-md space-y-10">
          <div className="space-y-4">
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              The integration layer for AI agents
            </p>
            <h2 className="text-4xl font-semibold tracking-[-0.04em] text-foreground">
              Every tool your agent needs, behind one endpoint.
            </h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Connect your APIs once. Any MCP-compatible agent gets the whole catalog, governed by
              your policies.
            </p>
          </div>

          <ul className="space-y-5">
            {PANEL_POINTS.map((point) => (
              <li key={point.index} className="flex gap-4">
                <span className="font-mono text-[11px] font-medium tracking-[0.08em] text-muted-foreground/70 pt-0.5">
                  {point.index}
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{point.title}</p>
                  <p className="text-sm leading-6 text-muted-foreground">{point.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative font-mono text-[11px] tracking-[0.08em] text-muted-foreground">
          self-hosted
        </p>
      </aside>

      <main className="flex flex-col items-center justify-center gap-6 p-6">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        {props.children}
      </main>
    </div>
  );
}
