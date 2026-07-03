import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";
import {
  IntegrationsRegistry,
  buildUserAgent,
  integrationsRegistryLayer,
  type IntegrationCatalogEntryType,
} from "@executor-js/integrations-registry";
import {
  StorageError,
  type IntegrationPresetCatalogEntry,
} from "@executor-js/sdk";

const USER_AGENT = buildUserAgent({
  channel: "dev",
  version: "0.1.0",
  client: "open-agents",
});

const integrationsRuntime = ManagedRuntime.make(
  integrationsRegistryLayer({
    userAgent: USER_AGENT,
    cacheDir: join(tmpdir(), "open-agents-integrations-cache"),
  }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(NodeFileSystem.layer),
  ),
);

const officialRemoteMcpEndpoints: Readonly<
  Record<
    string,
    {
      readonly endpoint: string;
      readonly name?: string;
      readonly summary?: string;
    }
  >
> = {
  "mcp/slack": {
    endpoint: "https://mcp.slack.com/mcp",
    name: "Slack",
    summary: "Search Slack, retrieve conversations, send messages, and manage canvases via MCP.",
  },
  "mcp/notion": {
    endpoint: "https://mcp.notion.com/mcp",
    name: "Notion",
    summary: "Search, read, and update Notion workspace content via MCP.",
  },
  "discovered/datadoghq-com-mcp": {
    endpoint: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp?toolsets=all",
    name: "Datadog",
    summary: "Query Datadog logs, metrics, traces, incidents, and monitors via MCP.",
  },
  "discovered/braintrust-dev-mcp": {
    endpoint: "https://api.braintrust.dev/mcp",
    name: "Braintrust",
    summary: "Inspect Braintrust projects, logs, traces, prompts, and evals via MCP.",
  },
};

const pluginIdForKind = (kind: string): "mcp" | "openapi" | "graphql" | null => {
  switch (kind) {
    case "mcp":
    case "openapi":
    case "graphql":
      return kind;
    default:
      return null;
  }
};

const iconUrl = (entry: IntegrationCatalogEntryType): string | undefined =>
  entry.icon ?? undefined;

const catalogSummary = (entry: IntegrationCatalogEntryType): string => entry.description;

const mcpPreset = (
  entry: IntegrationCatalogEntryType,
): IntegrationPresetCatalogEntry | null => {
  const official = officialRemoteMcpEndpoints[entry.id];
  if (!official) return null;
  return {
    pluginId: "mcp",
    id: entry.slug,
    namespace: entry.slug,
    name: official.name ?? entry.name,
    summary: official.summary ?? catalogSummary(entry),
    url: official.endpoint,
    endpoint: official.endpoint,
    icon: iconUrl(entry),
    featured: true,
  };
};

const httpPreset = (
  entry: IntegrationCatalogEntryType,
  pluginId: "openapi" | "graphql",
): IntegrationPresetCatalogEntry | null => {
  const url = entry.url ?? undefined;
  if (!url) return null;
  return {
    pluginId,
    id: entry.slug,
    namespace: entry.slug,
    name: entry.name,
    summary: catalogSummary(entry),
    url,
    endpoint: url,
    icon: iconUrl(entry),
    featured: entry.devtool ?? undefined,
  };
};

const catalogPreset = (
  entry: IntegrationCatalogEntryType,
): IntegrationPresetCatalogEntry | null => {
  const pluginId = pluginIdForKind(entry.kind);
  if (!pluginId) return null;
  if (pluginId === "mcp") return mcpPreset(entry);
  return httpPreset(entry, pluginId);
};

const comparePresets = (
  a: IntegrationPresetCatalogEntry,
  b: IntegrationPresetCatalogEntry,
): number => {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  return a.name.localeCompare(b.name);
};

export const openAgentsIntegrationPresets = (): Effect.Effect<
  readonly IntegrationPresetCatalogEntry[],
  StorageError
> =>
  Effect.tryPromise({
    try: async () => {
      const catalog = await integrationsRuntime.runPromise(
        IntegrationsRegistry.asEffect().pipe(
          Effect.flatMap((registry) => registry.get()),
        ),
      );
      return catalog.flatMap((entry) => {
        const preset = catalogPreset(entry);
        return preset ? [preset] : [];
      }).sort(comparePresets);
    },
    catch: (cause) =>
      new StorageError({
        message: "Failed to load integrations catalog",
        cause,
      }),
  });
