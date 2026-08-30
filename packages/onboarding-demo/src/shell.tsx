// Reproduction of the console chrome (packages/app/src/web/shell.tsx): the
// wordmark bar, the five nav items, the second INTEGRATIONS heading that
// repeats the first nav item, and the four-link footer.

import type { ReactNode } from "react";
import { cn } from "@executor-js/react/lib/utils";
import type { DemoIntegration } from "./fixtures";

const NAV_ITEMS = ["Integrations", "Secrets", "Policies", "Toolkits", "Artifacts"] as const;

function NavItem(props: { readonly label: string; readonly active: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        props.active
          ? "bg-sidebar-active font-medium text-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-active/60 hover:text-foreground",
      )}
    >
      {props.label}
    </span>
  );
}

export function Shell(props: {
  readonly integrations: readonly DemoIntegration[];
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border px-4">
          <span className="font-mono text-sm font-medium tracking-tight text-foreground">
            executor
          </span>
          <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
            theo&apos;s org
          </span>
        </div>

        <nav className="flex flex-1 flex-col overflow-y-auto p-2">
          {NAV_ITEMS.map((label) => (
            <NavItem key={label} label={label} active={label === "Integrations"} />
          ))}

          <span className="mt-5 mb-1 px-2.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Integrations
          </span>

          {props.integrations.length === 0 ? (
            <div className="px-2.5 py-2 text-sm leading-relaxed text-muted-foreground">
              No integrations yet
            </div>
          ) : (
            <div className="flex flex-col gap-px">
              {props.integrations.map((integration) => (
                <span
                  key={integration.slug}
                  className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-sidebar-foreground transition-colors hover:bg-sidebar-active/60 hover:text-foreground"
                >
                  {integration.icon ? (
                    <img
                      src={integration.icon}
                      alt=""
                      className="size-4 rounded-sm object-contain"
                    />
                  ) : (
                    <span className="size-4 rounded-sm bg-muted" />
                  )}
                  <span className="flex-1 truncate">{integration.name}</span>
                </span>
              ))}
            </div>
          )}
        </nav>

        <div className="shrink-0 border-t border-sidebar-border px-4 py-2.5">
          <div className="flex flex-col gap-1.5 text-xs leading-none text-muted-foreground">
            <span className="flex items-center justify-between">
              <span>Commands</span>
              <span className="font-mono text-[11px]">⌘K</span>
            </span>
            <span>Docs</span>
            <span>Feedback / bug?</span>
            <span>Star on GitHub</span>
            <span className="mt-0.5 tabular-nums">v1.4.4</span>
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {props.children}
      </main>
    </div>
  );
}
