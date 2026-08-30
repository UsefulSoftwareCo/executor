// Reproduction of packages/react/src/pages/integrations.tsx — the screen that
// follows CLI setup. The "Connect an agent" card sits above the fold; finding
// an integration is a dialog behind one button in the header.

import { PlusIcon } from "lucide-react";
import { Button } from "@executor-js/react/components/button";
import { PageContainer, PageHeader } from "@executor-js/react/components/page";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "@executor-js/react/components/card-stack";
import { Badge } from "@executor-js/react/components/badge";
import { Tabs, TabsList, TabsTrigger } from "@executor-js/react/components/tabs";
import type { DemoIntegration } from "../fixtures";

function McpInstallCard() {
  return (
    <CardStack>
      <Tabs value="http">
        <CardStackHeader
          className="items-start py-4"
          rightSlot={
            <TabsList>
              <TabsTrigger value="http">Remote HTTP</TabsTrigger>
              <TabsTrigger value="stdio">Standard I/O</TabsTrigger>
            </TabsList>
          }
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-semibold text-foreground">Connect an agent</span>
            <span className="text-xs font-normal text-muted-foreground">
              Paste this into Claude Code, Cursor, or any MCP client, and your agent gets every tool
              you connect here.
            </span>
          </div>
        </CardStackHeader>
        <CardStackContent>
          <div className="px-4 pt-3 pb-3">
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 font-mono text-xs text-foreground">
              npx add-mcp http://localhost:3123/mcp --transport http --name executor
            </div>
            <div className="mt-3 text-xs font-medium text-muted-foreground">Advanced ⌄</div>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <span>Work with your agent</span>
            <span className="rounded-md border border-border/60 px-1.5 py-0.5">Cursor</span>
            <span className="rounded-md border border-border/60 px-1.5 py-0.5">Claude</span>
            <span className="rounded-md border border-border/60 px-1.5 py-0.5">OpenCode</span>
            <span>and more</span>
          </div>
        </CardStackContent>
      </Tabs>
    </CardStack>
  );
}

export function IntegrationsPage(props: {
  readonly integrations: readonly DemoIntegration[];
  readonly onConnect: () => void;
  readonly onOpenIntegration: (slug: string) => void;
}) {
  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Tool providers available in this workspace."
        actions={
          <Button onClick={props.onConnect} size="sm" className="gap-1.5">
            <PlusIcon className="size-4" />
            Connect
          </Button>
        }
      />

      <div className="mb-8">
        <McpInstallCard />
      </div>

      <div className="mb-8 border-t border-border/50" />

      {props.integrations.length === 0 ? (
        <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <PlusIcon className="size-5" />
          </div>
          <p className="mb-1 text-[14px] font-medium text-foreground/70">No integrations yet</p>
          <p className="mb-5 text-[13px] text-muted-foreground/60">
            Connect an integration to start curating tools.
          </p>
          <Button onClick={props.onConnect} size="sm" className="gap-1.5">
            <PlusIcon className="size-4" />
            Connect an integration
          </Button>
        </div>
      ) : (
        <div className="mb-8 space-y-3">
          <CardStack searchable>
            <CardStackContent>
              {props.integrations.map((integration) => (
                <CardStackEntry key={integration.slug} asChild>
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => props.onOpenIntegration(integration.slug)}
                  >
                    {integration.icon ? (
                      <img
                        src={integration.icon}
                        alt=""
                        className="size-8 shrink-0 rounded-md object-contain"
                      />
                    ) : (
                      <span className="size-8 shrink-0 rounded-md bg-muted" />
                    )}
                    <CardStackEntryContent>
                      <CardStackEntryTitle>{integration.name}</CardStackEntryTitle>
                      <CardStackEntryDescription>{integration.slug}</CardStackEntryDescription>
                    </CardStackEntryContent>
                    <CardStackEntryActions>
                      <Badge variant="outline">
                        {integration.toolCount === 0
                          ? "No connection"
                          : `${integration.toolCount} tools`}
                      </Badge>
                    </CardStackEntryActions>
                  </button>
                </CardStackEntry>
              ))}
            </CardStackContent>
          </CardStack>
        </div>
      )}
    </PageContainer>
  );
}
