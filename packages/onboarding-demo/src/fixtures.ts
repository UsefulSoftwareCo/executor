// ---------------------------------------------------------------------------
// Everything the reproduction renders from.
//
// Presets come from the REAL plugin modules, so the curated list here is the
// same list the console shows. Connections, tools and auth methods are static
// stand-ins for the API reads the console makes. The integrations.sh calls are
// the genuine public endpoints — that catalog is already client-callable, which
// is exactly why it is the obvious raw material for the rework.
// ---------------------------------------------------------------------------

import { openApiPresets, type OpenApiPreset } from "@executor-js/plugin-openapi/presets";
import { mcpPresets, type McpPreset } from "@executor-js/plugin-mcp/presets";

export type PluginKey = "openapi" | "mcp" | "graphql" | "google";

export interface DemoPreset {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly icon?: string;
  readonly url?: string;
  readonly pluginKey: PluginKey;
  readonly pluginLabel: string;
}

const fromOpenApi = (preset: OpenApiPreset): DemoPreset => ({
  id: preset.id,
  name: preset.name,
  summary: preset.summary,
  ...(preset.icon ? { icon: preset.icon } : {}),
  ...(preset.url ? { url: preset.url } : {}),
  pluginKey: "openapi",
  pluginLabel: "OpenAPI",
});

const fromMcp = (preset: McpPreset): DemoPreset => ({
  id: preset.id,
  name: preset.name,
  summary: preset.summary,
  ...(preset.icon ? { icon: preset.icon } : {}),
  ...("url" in preset && preset.url ? { url: preset.url } : {}),
  pluginKey: "mcp",
  pluginLabel: "MCP",
});

/** The console's "Popular integrations" list, in the console's own order:
 *  every loaded plugin's presets, concatenated plugin by plugin. */
export const curatedPresets: readonly DemoPreset[] = [
  ...openApiPresets.map(fromOpenApi),
  ...mcpPresets.map(fromMcp),
];

/** The plugin chips under "Or add manually". */
export const integrationPlugins: readonly { readonly key: PluginKey; readonly label: string }[] = [
  { key: "openapi", label: "OpenAPI" },
  { key: "mcp", label: "MCP" },
  { key: "graphql", label: "GraphQL" },
  { key: "google", label: "Google" },
];

// ---------------------------------------------------------------------------
// Workspace state — what a brand-new tenant has, which is nothing
// ---------------------------------------------------------------------------

export interface DemoIntegration {
  readonly slug: string;
  readonly name: string;
  readonly kind: PluginKey;
  readonly icon?: string;
  readonly toolCount: number;
}

export const seededIntegrations: readonly DemoIntegration[] = [];

/** What the workspace looks like after the user adds PostHog — the state Theo
 *  reached before hunting for the key field. */
export const posthogIntegration: DemoIntegration = {
  slug: "posthog",
  name: "PostHog",
  kind: "openapi",
  icon: "https://integrations.sh/logo/posthog.com",
  toolCount: 0,
};

/** The OAuth-only integration, for the step where the popup dies. */
export const gmailIntegration: DemoIntegration = {
  slug: "gmail",
  name: "Gmail",
  kind: "google",
  icon: "https://integrations.sh/logo/google.com",
  toolCount: 0,
};

// ---------------------------------------------------------------------------
// Auth methods for the add-connection modal
//
// Shape mirrors `AuthMethod` in packages/react/src/lib/auth-placements.tsx.
// The labels are the ones a spec-derived integration actually produces: an
// OpenAPI spec whose security schemes carry no human name yields ordinal
// method labels, which is the "Method 1" tab.
// ---------------------------------------------------------------------------

export interface DemoPlacement {
  readonly carrier: "header" | "query" | "env";
  readonly name: string;
  readonly prefix: string;
}

export interface DemoAuthMethod {
  readonly id: string;
  readonly label: string;
  readonly kind: "apikey" | "oauth" | "none";
  readonly placements: readonly DemoPlacement[];
}

export const posthogAuthMethods: readonly DemoAuthMethod[] = [
  {
    id: "method-1",
    label: "Method 1",
    kind: "apikey",
    placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
  },
  {
    id: "method-2",
    label: "Method 2",
    kind: "apikey",
    placements: [{ carrier: "query", name: "personal_api_key", prefix: "" }],
  },
  { id: "oauth", label: "OAuth2", kind: "oauth", placements: [] },
];

export const gmailAuthMethods: readonly DemoAuthMethod[] = [
  { id: "oauth", label: "OAuth2", kind: "oauth", placements: [] },
];

// ---------------------------------------------------------------------------
// integrations.sh — the live public catalog
// ---------------------------------------------------------------------------

export const INTEGRATIONS_SH_ORIGIN = "https://integrations.sh";

export const CONNECTABLE_KINDS = ["mcp", "openapi", "graphql"] as const;
export type CatalogKind = (typeof CONNECTABLE_KINDS)[number];

export interface CatalogEntry {
  readonly domain: string;
  readonly description: string;
  readonly kinds: readonly CatalogKind[];
}

export const catalogLogoUrl = (domain: string, size: number): string =>
  `${INTEGRATIONS_SH_ORIGIN}/logo/${domain}?sz=${size * 2}`;

const isConnectableKind = (kind: string): kind is CatalogKind =>
  (CONNECTABLE_KINDS as readonly string[]).includes(kind);

/** `/api/search` — the same endpoint the console's connect dialog calls, and
 *  the same 250ms-debounced, ≥2-character contract. */
export const searchCatalog = async (
  query: string,
  limit = 10,
): Promise<readonly CatalogEntry[]> => {
  const url = new URL("/api/search", INTEGRATIONS_SH_ORIGIN);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    readonly results?: readonly {
      readonly domain: string;
      readonly description: string;
      readonly kinds: readonly string[];
    }[];
  };
  return (payload.results ?? [])
    .map((entry) => ({
      domain: entry.domain,
      description: entry.description,
      kinds: entry.kinds.filter(isConnectableKind),
    }))
    .filter((entry) => entry.kinds.length > 0);
};

export interface CatalogDomain {
  readonly domain: string;
  readonly icon: string;
  readonly description: string;
  readonly formats: Readonly<Record<string, number>>;
  readonly popularity: number;
}

/** `/api/domains.json` — the whole popularity-sorted registry (~3.4k domains).
 *  The console never calls this; it is here because it is the list the product
 *  is missing, and the rework will want it. */
export const fetchCatalogDomains = async (): Promise<readonly CatalogDomain[]> => {
  const response = await fetch(`${INTEGRATIONS_SH_ORIGIN}/api/domains.json`);
  if (!response.ok) return [];
  const payload = (await response.json()) as { readonly data?: readonly CatalogDomain[] };
  return payload.data ?? [];
};

export interface SurfaceCredential {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly generateUrl?: string;
  readonly setup?: string;
}

/** `/api/<domain>/surface` — the per-domain document. The console reads only
 *  `surfaces[].url` out of this; the `credentials` block (which key, where to
 *  mint it, how) is fetched and thrown away. */
export const fetchSurfaceCredentials = async (
  domain: string,
): Promise<readonly SurfaceCredential[]> => {
  const response = await fetch(
    `${INTEGRATIONS_SH_ORIGIN}/api/${encodeURIComponent(domain)}/surface`,
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as {
    readonly credentials?: Readonly<
      Record<
        string,
        {
          readonly type?: string;
          readonly label?: string;
          readonly generateUrl?: string;
          readonly setup?: string;
        }
      >
    >;
  };
  return Object.entries(payload.credentials ?? {}).map(([id, value]) => ({
    id,
    type: value.type ?? "unknown",
    label: value.label ?? id,
    ...(value.generateUrl ? { generateUrl: value.generateUrl } : {}),
    ...(value.setup ? { setup: value.setup } : {}),
  }));
};
