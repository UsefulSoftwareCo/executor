// Reproduction of packages/react/src/pages/integration-detail.tsx plus the
// AccountsSection from packages/react/src/components/accounts-section.tsx.
//
// This is where a just-added integration lands. It has an Edit / Refresh /
// Delete header, an Accounts / Tools tab strip, a "Connections" heading, and a
// dashed empty card whose CTA is "Add connection" — the second add, for a thing
// the user did not know was separate from the first.

import { useState } from "react";
import { Button } from "@executor-js/react/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@executor-js/react/components/tabs";
import type { DemoIntegration } from "../fixtures";

export function IntegrationDetailPage(props: {
  readonly integration: DemoIntegration;
  readonly onAddConnection: () => void;
}) {
  const [tab, setTab] = useState<"accounts" | "tools">("accounts");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {props.integration.name}
          </h2>
          <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
            {props.integration.toolCount} tools
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm">
            Edit
          </Button>
          <Button variant="outline" size="sm">
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-destructive/30 text-destructive hover:bg-destructive/10"
          >
            Delete
          </Button>
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value: string) => setTab(value === "tools" ? "tools" : "accounts")}
        className="min-h-0 flex-1 gap-0 overflow-hidden"
      >
        <div className="shrink-0 border-b border-border/60 px-4 py-2">
          <TabsList variant="line">
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="accounts" className="min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Connections
                </h3>
              </div>
              <div className="rounded-lg border border-dashed border-border/60 px-6 py-8 text-center">
                <p className="text-sm font-medium text-foreground">No connections yet</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Add a connection to make this integration&apos;s tools available.
                </p>
                <Button type="button" className="mt-4" size="sm" onClick={props.onAddConnection}>
                  Add connection
                </Button>
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent
          value="tools"
          className="flex min-h-0 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex w-72 shrink-0 flex-col border-r border-border/60 p-3 lg:w-80 xl:w-[22rem]">
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No tools yet</p>
            </div>
            <div className="flex min-w-0 flex-1 items-center justify-center">
              <div className="max-w-sm text-center">
                <p className="text-sm font-medium text-foreground">No tools yet</p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  Add a connection to unlock this integration&apos;s tools.
                </p>
                <Button type="button" size="sm" className="mt-4" onClick={props.onAddConnection}>
                  Add connection
                </Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
