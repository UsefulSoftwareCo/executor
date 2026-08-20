import { Suspense, useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { PlusIcon } from "lucide-react";
import type { Integration } from "@executor-js/sdk/shared";
import { useIntegrationPlugins, type IntegrationPlugin } from "@executor-js/sdk/client";
import { integrationsOptimisticAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { PageContainer, PageHeader } from "../components/page";
import { ConnectIntegrationDialog } from "../components/connect-integration-dialog";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import {
  IntegrationFavicon,
  integrationInferredUrl,
  integrationPresetIconUrl,
} from "../components/integration-favicon";
import { groupIntegrations, type IntegrationFamilyGroup } from "../lib/integration-grouping";
import { IntegrationHealthSummary } from "../components/integration-health-summary";
import { IntegrationIconWithAccount } from "../components/integration-icon-with-account";
import { Skeleton } from "../components/skeleton";
import { useExecutorDocumentTitle } from "../lib/document-title";
import { ErrorState } from "../components/error-state";
import { isAsyncResultLoading } from "../lib/async-result";
import { pluginKeyForIntegrationKind } from "../lib/integration-plugin-keys";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function IntegrationsPage() {
  useExecutorDocumentTitle("Integrations");
  const integrations = useAtomValue(integrationsOptimisticAtom);
  const refreshIntegrations = useAtomRefresh(integrationsOptimisticAtom);
  const [connectOpen, setConnectOpen] = useState(false);

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Tool providers available in this workspace."
        actions={
          <Button
            onClick={() => {
              setConnectOpen(true);
              trackEvent("integration_connect_dialog_opened");
            }}
            size="sm"
            className="gap-1.5"
          >
            <PlusIcon className="size-4" />
            Connect
          </Button>
        }
      />

      <div className="mb-8">
        <McpInstallCard />
      </div>

      <div className="mb-8 border-t border-border/50" />

      {isAsyncResultLoading(integrations) ? (
        <IntegrationsGridSkeleton />
      ) : (
        AsyncResult.match(integrations, {
          onInitial: () => <IntegrationsGridSkeleton />,
          onFailure: () => (
            <ErrorState message="Failed to load integrations" onRetry={refreshIntegrations} />
          ),
          onSuccess: ({ value }) => {
            if (value.length === 0) {
              return (
                <EmptyIntegrations
                  onConnect={() => {
                    setConnectOpen(true);
                    trackEvent("integration_connect_dialog_opened");
                  }}
                />
              );
            }

            return (
              <div className="mb-8 space-y-3">
                <IntegrationGrid integrations={value} />
              </div>
            );
          },
        })
      )}

      <ConnectIntegrationDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyIntegrations(props: { onConnect: () => void }) {
  return (
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
  );
}

// ---------------------------------------------------------------------------
// Integration grid — flat list of catalog integrations, click-through to detail
// ---------------------------------------------------------------------------

function IntegrationGrid(props: { integrations: readonly Integration[] }) {
  const integrationPlugins = useIntegrationPlugins();
  const pluginByKind = useMemo(() => {
    const out = new Map<string, IntegrationPlugin>();
    for (const p of integrationPlugins) out.set(p.key, p);
    return out;
  }, [integrationPlugins]);

  const items = useMemo(() => groupIntegrations(props.integrations), [props.integrations]);

  const renderEntry = (integration: Integration) => {
    const pluginKey = pluginKeyForIntegrationKind(integration.kind);
    const plugin = pluginByKind.get(pluginKey);
    const SummaryComponent = plugin?.summary;
    const slug = String(integration.slug);
    const name = integration.name || slug;
    return (
      <CardStackEntry key={slug} asChild searchText={`${name} ${slug} ${integration.kind}`}>
        <Link
          to="/{-$orgSlug}/integrations/$namespace"
          params={{ namespace: slug }}
          data-testid={`integration-entry-${slug}`}
        >
          <IntegrationIconWithAccount
            icon={integrationPresetIconUrl(
              { id: slug, kind: integration.kind, name, url: integration.displayUrl },
              integrationPlugins,
            )}
            integrationId={slug}
            url={integration.displayUrl ?? integrationInferredUrl({ id: slug, name }) ?? undefined}
          />
          <CardStackEntryContent>
            <CardStackEntryTitle>{name}</CardStackEntryTitle>
            <CardStackEntryDescription>{slug}</CardStackEntryDescription>
          </CardStackEntryContent>
          <CardStackEntryActions>
            {SummaryComponent && (
              <Suspense fallback={null}>
                <SummaryComponent integrationId={slug} />
              </Suspense>
            )}
            <IntegrationHealthSummary integration={integration.slug} />
          </CardStackEntryActions>
        </Link>
      </CardStackEntry>
    );
  };

  const rendered: ReactNode[] = [];
  let flatRun: Integration[] = [];
  const flushFlat = () => {
    if (flatRun.length === 0) return;
    const run = flatRun;
    flatRun = [];
    rendered.push(
      <CardStack key={`flat-${String(run[0]!.slug)}`} searchable>
        <CardStackContent>{run.map(renderEntry)}</CardStackContent>
      </CardStack>,
    );
  };

  for (const item of items) {
    if (item.type === "single") {
      flatRun.push(item.integration);
      continue;
    }
    flushFlat();
    rendered.push(
      <IntegrationFamilyGroupCard
        key={`group-${item.family}`}
        group={item}
        plugin={pluginByKind.get("openapi")}
        renderEntry={renderEntry}
      />,
    );
  }
  flushFlat();

  return <div className="space-y-3">{rendered}</div>;
}

function IntegrationFamilyGroupCard(props: {
  group: IntegrationFamilyGroup;
  plugin: IntegrationPlugin | undefined;
  renderEntry: (integration: Integration) => ReactNode;
}) {
  const { group, plugin, renderEntry } = props;
  const headerIcon =
    plugin?.presets?.find((preset) => preset.family === group.family && preset.icon)?.icon ?? null;
  return (
    <CardStack collapsible defaultOpen data-testid={`integration-group-${group.family}`}>
      <CardStackHeader>
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <IntegrationFavicon icon={headerIcon} size={16} />
          </span>
          <span className="truncate">{group.label}</span>
          <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">
            {group.members.length}
          </span>
        </span>
      </CardStackHeader>
      <CardStackContent>{group.members.map(renderEntry)}</CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function IntegrationsGridSkeleton() {
  return (
    <CardStack>
      <CardStackContent>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
              <Skeleton className="h-3" style={{ width: `${25 + ((i * 7) % 20)}%` }} />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </CardStackContent>
    </CardStack>
  );
}
